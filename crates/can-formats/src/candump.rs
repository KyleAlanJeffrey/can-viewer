//! Linux can-utils `candump -l` / `-L` log format: `(1436509052.249713) can0 123#DEADBEEF`.
//!
//! Frame grammar from can-utils `lib.h`: classic `<id>#<data>` or `<id>#R<len>`, each with an
//! optional `_<dlc>` suffix, and CAN FD `<id>##<flags><data>`. Three hex digits mean an 11-bit ID
//! and eight mean 29-bit. Data bytes may be separated by `.`. `candump -x` appends ` T` or ` R`.
//! CAN XL lines are rejected for now. [`write_log`] writes a frame store back in this format.

use can_core::{flags, FrameRef, FrameSink, FrameStore, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::lines::LineSplitter;
use crate::text::{hex_value, parse_decimal_ns, parse_hex_u32};
use crate::{LogParser, ParseStats};

const CAN_EFF_MASK: u32 = 0x1FFF_FFFF;
const CANFD_BRS: u8 = 0x1;
const CANFD_ESI: u8 = 0x2;

#[derive(Debug, Default)]
pub struct CandumpParser {
    lines: LineSplitter,
    stats: ParseStats,
}

impl CandumpParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl LogParser for CandumpParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        self.lines.push(chunk, &mut self.stats, |line, stats| {
            line_into(line, stats, sink)
        });
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        self.lines
            .finish(&mut self.stats, |line, stats| line_into(line, stats, sink));
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
    }
}

fn line_into<S: FrameSink>(line: &[u8], stats: &mut ParseStats, sink: &mut S) {
    match parse_line(line, sink) {
        Ok(()) => stats.frames += 1,
        Err(reason) => stats.reject(reason),
    }
}

fn parse_line<S: FrameSink>(line: &[u8], sink: &mut S) -> Result<(), &'static str> {
    let rest = line
        .strip_prefix(b"(")
        .ok_or("expected '(' before timestamp")?;
    let close = memchr::memchr(b')', rest).ok_or("unterminated timestamp")?;
    let ts_ns = parse_timestamp(&rest[..close]).ok_or("bad timestamp")?;
    let mut fields = rest[close + 1..]
        .split(|&b| b == b' ')
        .filter(|f| !f.is_empty());
    let interface = fields.next().ok_or("missing interface name")?;
    let frame = fields.next().ok_or("missing frame")?;
    let mut frame_flags = match fields.next() {
        Some(b"T") => flags::TX,
        _ => 0,
    };
    let mut data = [0u8; MAX_PAYLOAD];
    let (id, len) = parse_frame(frame, &mut data, &mut frame_flags)?;
    let channel = sink.channel_index(interface);
    sink.push(FrameRef {
        ts_ns,
        channel,
        id,
        flags: frame_flags,
        data: &data[..len],
    });
    Ok(())
}

/// Seconds with up to nine decimals, negative for times before the epoch (as [`write_log`]
/// writes them for a log that has some).
fn parse_timestamp(s: &[u8]) -> Option<i64> {
    match s.strip_prefix(b"-") {
        Some(magnitude) => parse_decimal_ns(magnitude, 9).map(|ns| -ns),
        None => parse_decimal_ns(s, 9),
    }
}

fn parse_frame(
    s: &[u8],
    data: &mut [u8; MAX_PAYLOAD],
    frame_flags: &mut u8,
) -> Result<(u32, usize), &'static str> {
    let hash = memchr::memchr(b'#', s).ok_or("missing '#' in frame")?;
    let id_hex = &s[..hash];
    let raw = parse_hex_u32(id_hex).ok_or("bad CAN ID")?;
    let id = match id_hex.len() {
        3 if raw <= 0x7FF => raw,
        8 if raw & ERR_FLAG != 0 => {
            *frame_flags |= flags::ERROR;
            (raw & CAN_EFF_MASK) | ERR_FLAG
        }
        8 => (raw & CAN_EFF_MASK) | EXT_FLAG,
        _ => return Err("CAN ID must be 3 (11-bit) or 8 (29-bit) hex digits"),
    };
    let body = &s[hash + 1..];

    if let Some(fd) = body.strip_prefix(b"#") {
        let (&flag_digit, payload) = fd.split_first().ok_or("missing CAN FD flags")?;
        let fd_flags = hex_value(flag_digit).ok_or("bad CAN FD flags")?;
        *frame_flags |= flags::FD;
        if fd_flags & CANFD_BRS != 0 {
            *frame_flags |= flags::BRS;
        }
        if fd_flags & CANFD_ESI != 0 {
            *frame_flags |= flags::ESI;
        }
        return Ok((id, parse_payload(payload, data)?));
    }
    if body.first() == Some(&b'R') {
        *frame_flags |= flags::RTR;
        return Ok((id, 0));
    }
    let payload = memchr::memchr(b'_', body).map_or(body, |u| &body[..u]);
    let len = parse_payload(payload, data)?;
    if len > 8 {
        return Err("classic CAN payload over 8 bytes");
    }
    Ok((id, len))
}

fn parse_payload(s: &[u8], out: &mut [u8; MAX_PAYLOAD]) -> Result<usize, &'static str> {
    let mut n = 0;
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'.' {
            i += 1;
            continue;
        }
        let (Some(hi), Some(lo)) = (hex_value(s[i]), s.get(i + 1).and_then(|&c| hex_value(c)))
        else {
            return Err("bad hex data");
        };
        if n == MAX_PAYLOAD {
            return Err("payload over 64 bytes");
        }
        out[n] = (hi << 4) | lo;
        n += 1;
        i += 2;
    }
    Ok(n)
}

/// Every frame of `store` as a `candump -l` log, in store order, leaving out the frames the
/// store reassembled from J1939 transport protocol packets (the packets themselves are kept).
/// Times are written to the microsecond. Transmitted frames get candump's ` T` suffix, and a
/// remote frame is written without a length, as the store keeps none.
#[must_use]
pub fn write_log(store: &FrameStore) -> Vec<u8> {
    let mut out = Vec::with_capacity(store.len() * 40);
    for i in 0..store.len() {
        let frame = store.frame(i);
        if frame.flags & flags::REASSEMBLED != 0 {
            continue;
        }
        let interface = store
            .channels()
            .get(usize::from(frame.channel))
            .map_or("can0", String::as_str);
        write_frame(&mut out, &frame, interface);
    }
    out
}

fn write_frame(out: &mut Vec<u8>, frame: &FrameRef<'_>, interface: &str) {
    use std::io::Write;

    let sign = if frame.ts_ns < 0 { "-" } else { "" };
    let magnitude = frame.ts_ns.unsigned_abs();
    let seconds = magnitude / 1_000_000_000;
    let micros = magnitude % 1_000_000_000 / 1_000;
    // Writing to a Vec never fails.
    let _ = write!(out, "({sign}{seconds}.{micros:06}) {interface} ");
    let _ = if frame.id & (EXT_FLAG | ERR_FLAG) != 0 {
        write!(out, "{:08X}", frame.id & !EXT_FLAG)
    } else {
        write!(out, "{:03X}", frame.id)
    };
    if frame.flags & flags::FD != 0 {
        let mut fd_flags = 0;
        if frame.flags & flags::BRS != 0 {
            fd_flags |= CANFD_BRS;
        }
        if frame.flags & flags::ESI != 0 {
            fd_flags |= CANFD_ESI;
        }
        let _ = write!(out, "##{fd_flags:X}");
    } else if frame.flags & flags::RTR != 0 {
        out.extend_from_slice(b"#R");
    } else {
        out.push(b'#');
    }
    if frame.flags & flags::RTR == 0 || frame.flags & flags::FD != 0 {
        for byte in frame.data {
            let _ = write!(out, "{byte:02X}");
        }
    }
    if frame.flags & flags::TX != 0 {
        out.extend_from_slice(b" T");
    }
    out.push(b'\n');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lines::{LINE_TOO_LONG, MAX_LINE};
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    fn parse(input: &str) -> (VecSink, ParseStats) {
        parse_chunked(CandumpParser::new(), input.as_bytes(), usize::MAX)
    }

    #[test]
    fn classic_standard_and_extended() {
        let (sink, stats) = parse(
            "(1436509052.249713) can0 123#DEADBEEF\n(1436509052.250000) can1 1234ABCD#0102\n",
        );
        assert_eq!(stats.frames, 2);
        assert_eq!(
            sink.frames[0],
            (
                1_436_509_052_249_713_000,
                0,
                0x123,
                0,
                vec![0xDE, 0xAD, 0xBE, 0xEF]
            )
        );
        assert_eq!(
            sink.frames[1],
            (
                1_436_509_052_250_000_000,
                1,
                0x1234_ABCD | EXT_FLAG,
                0,
                vec![1, 2]
            )
        );
    }

    #[test]
    fn can_fd_with_flags() {
        let (sink, _) = parse("(1.0) can0 321##311223344556677889900\n");
        let (_, _, id, fl, data) = &sink.frames[0];
        assert_eq!(*id, 0x321);
        assert_eq!(*fl, flags::FD | flags::BRS | flags::ESI);
        assert_eq!(data.len(), 10);
        assert_eq!(data[0], 0x11);
    }

    #[test]
    fn rtr_error_dlc_suffix_separators_and_direction() {
        let (sink, stats) = parse(
            "(1.0) can0 123#R\n\
             (1.0) can0 123#R5\n\
             (1.0) can0 20000080#0000000000000000\n\
             (1.0) can0 123#11.22.33\n\
             (1.0) can0 123#1122334455667788_C\n\
             (1.0) can0 123#00 T\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames[0].3, flags::RTR);
        assert_eq!(sink.frames[1].3, flags::RTR);
        assert_eq!(sink.frames[2].2, 0x80 | ERR_FLAG);
        assert_eq!(sink.frames[2].3, flags::ERROR);
        assert_eq!(sink.frames[3].4, vec![0x11, 0x22, 0x33]);
        assert_eq!(sink.frames[4].4.len(), 8);
        assert_eq!(sink.frames[5].3, flags::TX);
    }

    #[test]
    fn rejects_bad_lines_without_stopping() {
        let (sink, stats) =
            parse("garbage\n(1.0) can0 1234#00\n(1.0) can0 123#0\n(1.0) can0 123#00\n");
        assert_eq!(sink.frames.len(), 1);
        assert_eq!(stats.rejected, 3);
        assert_eq!(
            stats.first_rejection,
            Some((1, "expected '(' before timestamp"))
        );
    }

    #[test]
    fn handles_crlf_blank_lines_and_missing_final_newline() {
        let (sink, stats) = parse("\r\n(1.5) can0 123#01\r\n\n(2.25) can0 123#02");
        assert_eq!(stats.rejected, 0);
        assert_eq!(stats.lines, 4);
        assert_eq!(sink.frames.len(), 2);
        assert_eq!(sink.frames[0].0, 1_500_000_000);
        assert_eq!(sink.frames[1].0, 2_250_000_000);
    }

    #[test]
    fn rejects_overlong_lines_without_buffering_them() {
        let mut input = vec![0xA5; 3 * MAX_LINE];
        input.extend_from_slice(b"\n(1.0) can0 123#01\n");
        for chunk in [7, 1000, MAX_LINE + 1, usize::MAX] {
            let mut parser = CandumpParser::new();
            let mut sink = VecSink::default();
            for part in input.chunks(chunk) {
                parser.push(part, &mut sink);
                assert!(parser.lines.carried() <= MAX_LINE, "chunk size {chunk}");
            }
            parser.finish(&mut sink);
            let stats = parser.stats();
            assert_eq!(sink.frames.len(), 1, "chunk size {chunk}");
            assert_eq!(
                (stats.lines, stats.rejected, stats.first_rejection),
                (2, 1, Some((1, LINE_TOO_LONG))),
                "chunk size {chunk}"
            );
        }

        let (sink, stats) = parse_chunked(CandumpParser::new(), &input[..2 * MAX_LINE], 100);
        assert!(sink.frames.is_empty());
        assert_eq!(
            (stats.lines, stats.rejected),
            (1, 1),
            "unterminated at the end"
        );
    }

    #[test]
    fn negative_timestamps() {
        let (sink, stats) =
            parse("(-1.500000) can0 123#01\n(-0.25) can0 123#02\n(-) can0 123#03\n");
        assert_eq!(stats.rejected, 1);
        assert_eq!(sink.frames[0].0, -1_500_000_000);
        assert_eq!(sink.frames[1].0, -250_000_000);
    }

    #[test]
    fn writes_a_log_that_reads_back_the_same() {
        let input = "(1436509052.249713) can0 123#DEADBEEF\n\
                     (1436509052.250000) vcan1 1234ABCD#0102\n\
                     (1436509052.250001) can0 7FF#\n\
                     (1436509052.250002) can0 321##3112233\n\
                     (1436509052.250003) can0 0F0##0\n\
                     (1436509052.250004) can0 123#R\n\
                     (1436509052.250005) can0 18FEF100#R\n\
                     (1436509052.250006) can0 20000080#0000000000000000\n\
                     (1436509052.250007) can0 123#00 T\n\
                     (-2.000001) can0 001#01\n";
        let mut store = FrameStore::new();
        let mut parser = CandumpParser::new();
        parser.push(input.as_bytes(), &mut store);
        parser.finish(&mut store);
        assert_eq!(
            parser.stats().rejected,
            0,
            "{:?}",
            parser.stats().first_rejection
        );

        let written = write_log(&store);
        assert_eq!(String::from_utf8(written.clone()).unwrap(), input);
        let (sink, stats) = parse(std::str::from_utf8(&written).unwrap());
        assert_eq!(stats.rejected, 0);
        assert_eq!(sink.frames.len(), store.len());
        for (i, (ts_ns, _, id, frame_flags, data)) in sink.frames.iter().enumerate() {
            let stored = store.frame(i);
            assert_eq!(
                (*ts_ns, *id, *frame_flags, data.as_slice()),
                (stored.ts_ns, stored.id, stored.flags, stored.data)
            );
        }
    }

    #[test]
    fn writing_leaves_out_reassembled_j1939_transfers() {
        let mut store = FrameStore::new();
        let channel = store.channel_index(b"can0");
        let push = |store: &mut FrameStore, ts_ns: i64, id: u32, data: &[u8]| {
            store.push(FrameRef {
                ts_ns,
                channel,
                id: id | EXT_FLAG,
                flags: 0,
                data,
            });
        };
        // A BAM of 10 bytes (PGN 0xFECA) in two packets.
        push(
            &mut store,
            1_000_000_000,
            0x1CEC_FF00,
            &[0x20, 10, 0, 2, 0xFF, 0xCA, 0xFE, 0x00],
        );
        push(
            &mut store,
            1_050_000_000,
            0x1CEB_FF00,
            &[1, 1, 2, 3, 4, 5, 6, 7],
        );
        push(
            &mut store,
            1_100_000_000,
            0x1CEB_FF00,
            &[2, 8, 9, 10, 0xFF, 0xFF, 0xFF, 0xFF],
        );
        assert_eq!(store.reassembled_frames(), 1);
        let written = String::from_utf8(write_log(&store)).unwrap();
        assert_eq!(written.lines().count(), 3);
        assert!(!written.contains("FECA"), "{written}");
    }

    #[test]
    fn chunk_boundaries_do_not_matter() {
        let input = b"(1436509052.249713) can0 123#DEADBEEF\n(1436509052.250000) can0 18FEF100##1001122\n(1.0) vcan0 7FF#\nbad\n";
        let (_, stats) = assert_chunking_does_not_matter(CandumpParser::new, input);
        assert_eq!((stats.frames, stats.rejected), (3, 1));
    }
}
