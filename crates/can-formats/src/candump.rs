//! Linux can-utils `candump -l` / `-L` log format: `(1436509052.249713) can0 123#DEADBEEF`.
//!
//! Frame grammar from can-utils `lib.h`: classic `<id>#<data>` or `<id>#R<len>`, each with an
//! optional `_<dlc>` suffix, and CAN FD `<id>##<flags><data>`. Three hex digits mean an 11-bit ID
//! and eight mean 29-bit. Data bytes may be separated by `.`. `candump -x` appends ` T` or ` R`.
//! CAN XL lines are rejected for now.

use can_core::{flags, FrameRef, FrameSink, EXT_FLAG, MAX_PAYLOAD};

use crate::{LogParser, ParseStats};

const CAN_ERR_FLAG: u32 = 0x2000_0000;
const CAN_EFF_MASK: u32 = 0x1FFF_FFFF;
const CANFD_BRS: u8 = 0x1;
const CANFD_ESI: u8 = 0x2;

#[derive(Debug, Default)]
pub struct CandumpParser {
    carry: Vec<u8>,
    stats: ParseStats,
}

impl CandumpParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn line<S: FrameSink>(&mut self, line: &[u8], sink: &mut S) {
        self.stats.lines += 1;
        let line = line.trim_ascii();
        if line.is_empty() {
            return;
        }
        match parse_line(line, sink) {
            Ok(()) => self.stats.frames += 1,
            Err(reason) => self.stats.reject(reason),
        }
    }
}

impl LogParser for CandumpParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        self.stats.bytes += chunk.len() as u64;
        let mut rest = chunk;
        if !self.carry.is_empty() {
            let Some(nl) = memchr::memchr(b'\n', rest) else {
                self.carry.extend_from_slice(rest);
                return;
            };
            let mut line = std::mem::take(&mut self.carry);
            line.extend_from_slice(&rest[..nl]);
            self.line(&line, sink);
            line.clear();
            self.carry = line;
            rest = &rest[nl + 1..];
        }
        let complete = memchr::memrchr(b'\n', rest).map_or(0, |i| i + 1);
        let (body, tail) = rest.split_at(complete);
        let mut start = 0;
        for nl in memchr::memchr_iter(b'\n', body) {
            self.line(&body[start..nl], sink);
            start = nl + 1;
        }
        self.carry.extend_from_slice(tail);
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            self.line(&line, sink);
        }
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
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
        8 if raw & CAN_ERR_FLAG != 0 => {
            *frame_flags |= flags::ERROR;
            raw & CAN_EFF_MASK
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

/// `1436509052.249713` -> nanoseconds. Fractions beyond nanoseconds are truncated.
fn parse_timestamp(s: &[u8]) -> Option<i64> {
    let (int, frac) = match memchr::memchr(b'.', s) {
        Some(dot) => (&s[..dot], &s[dot + 1..]),
        None => (s, &[][..]),
    };
    let frac = &frac[..frac.len().min(9)];
    let secs = parse_decimal(int)?;
    let mut nanos = if frac.is_empty() {
        0
    } else {
        parse_decimal(frac)?
    };
    for _ in frac.len()..9 {
        nanos *= 10;
    }
    secs.checked_mul(1_000_000_000)?.checked_add(nanos)
}

fn parse_decimal(s: &[u8]) -> Option<i64> {
    if s.is_empty() || s.len() > 18 {
        return None;
    }
    s.iter().try_fold(0i64, |acc, &c| {
        c.is_ascii_digit().then(|| acc * 10 + i64::from(c - b'0'))
    })
}

fn parse_hex_u32(s: &[u8]) -> Option<u32> {
    if s.is_empty() || s.len() > 8 {
        return None;
    }
    s.iter().try_fold(0u32, |acc, &c| {
        hex_value(c).map(|v| (acc << 4) | u32::from(v))
    })
}

const HEX: [u8; 256] = {
    let mut table = [0xFF; 256];
    let mut i = 0;
    while i < 10 {
        table[b'0' as usize + i] = i as u8;
        i += 1;
    }
    let mut i = 0;
    while i < 6 {
        table[b'a' as usize + i] = 10 + i as u8;
        table[b'A' as usize + i] = 10 + i as u8;
        i += 1;
    }
    table
};

fn hex_value(c: u8) -> Option<u8> {
    let v = HEX[usize::from(c)];
    (v != 0xFF).then_some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct VecSink {
        channels: Vec<Vec<u8>>,
        frames: Vec<(i64, u8, u32, u8, Vec<u8>)>,
    }

    impl FrameSink for VecSink {
        fn channel_index(&mut self, name: &[u8]) -> u8 {
            if let Some(i) = self.channels.iter().position(|c| c == name) {
                return i as u8;
            }
            self.channels.push(name.to_vec());
            (self.channels.len() - 1) as u8
        }

        fn push(&mut self, f: FrameRef<'_>) {
            self.frames
                .push((f.ts_ns, f.channel, f.id, f.flags, f.data.to_vec()));
        }
    }

    fn parse_chunked(input: &[u8], chunk: usize) -> (VecSink, ParseStats) {
        let mut parser = CandumpParser::new();
        let mut sink = VecSink::default();
        for part in input.chunks(chunk.max(1)) {
            parser.push(part, &mut sink);
        }
        parser.finish(&mut sink);
        (sink, parser.stats().clone())
    }

    fn parse(input: &str) -> (VecSink, ParseStats) {
        parse_chunked(input.as_bytes(), usize::MAX)
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
        assert_eq!(sink.frames[2].2, 0x80);
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
        assert_eq!(sink.frames.len(), 2);
        assert_eq!(sink.frames[0].0, 1_500_000_000);
        assert_eq!(sink.frames[1].0, 2_250_000_000);
    }

    #[test]
    fn chunk_boundaries_do_not_matter() {
        let input = b"(1436509052.249713) can0 123#DEADBEEF\n(1436509052.250000) can0 18FEF100##1001122\n(1.0) vcan0 7FF#\n";
        let (whole, _) = parse_chunked(input, usize::MAX);
        for chunk in 1..input.len() {
            let (split, stats) = parse_chunked(input, chunk);
            assert_eq!(split.frames, whole.frames, "chunk size {chunk}");
            assert_eq!(stats.frames, 3);
        }
    }
}
