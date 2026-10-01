//! PEAK-System trace files (`.trc`), file versions 1.0 to 2.1, as written by PCAN-View,
//! PCAN-Explorer and python-can.
//!
//! Header lines start with `;`. Version 2.x files declare their columns, and a frame line is:
//!
//! ```text
//! ;$FILEVERSION=2.1
//! ;$STARTTIME=45930.5
//! ;$COLUMNS=N,O,T,B,I,d,R,L,D
//!       1      1059.900 DT 1  0001 Rx -  8  00 11 22 33 44 55 66 77
//! ```
//!
//! Version 1.x files have fixed columns, told apart by what follows the time offset:
//!
//! ```text
//!      1)      1059.9  Rx  0001  8  00 11 22 33 44 55 66 77         1.1
//!      1)      1059.9  1  Rx  0001  -  8  00 11 22 33 44 55 66 77   1.3 (1.2 without the -)
//!      1)      1059  0001  8  00 11 22 33 44 55 66 77               1.0
//! ```
//!
//! Time offsets are milliseconds from `$STARTTIME` (days since 1899-12-30, as PEAK writes
//! it), or from zero without one. Buses are named `can<number>` from the bus column, and
//! `can1` without one. Error frames get the ID [`ERR_FLAG`] alone.

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::lines::LineSplitter;
use crate::text::{
    dlc_to_len, fields, parse_decimal, parse_decimal_ns, parse_hex_u32, ChannelName,
};
use crate::{LogParser, ParseStats};

/// Days from 1899-12-30, PEAK's epoch, to 1970-01-01.
const UNIX_EPOCH_DAYS: i64 = 25_569;
const MAX_COLUMNS: usize = 16;

#[derive(Debug, Default)]
pub struct TrcParser {
    lines: LineSplitter,
    stats: ParseStats,
    header: Header,
}

#[derive(Debug, Default)]
struct Header {
    start_ns: i64,
    version_2: bool,
    columns: Option<Columns>,
    /// A `$COLUMNS` line was seen but lacks a column we need.
    unusable_columns: bool,
}

/// Field positions declared by `$COLUMNS`. The data column is last and takes every
/// remaining field.
#[derive(Debug, Clone, Copy)]
struct Columns {
    time: usize,
    kind: usize,
    bus: Option<usize>,
    id: usize,
    direction: Option<usize>,
    /// The `l` column: payload length in bytes.
    length: Option<usize>,
    /// The `L` column: DLC.
    dlc: Option<usize>,
    data: usize,
}

impl Columns {
    fn parse(spec: &[u8]) -> Option<Self> {
        let mut columns = Columns {
            time: usize::MAX,
            kind: usize::MAX,
            bus: None,
            id: usize::MAX,
            direction: None,
            length: None,
            dlc: None,
            data: usize::MAX,
        };
        let names: Vec<&[u8]> = spec.split(|&b| b == b',').map(<[u8]>::trim_ascii).collect();
        if names.len() > MAX_COLUMNS {
            return None;
        }
        for (index, name) in names.iter().enumerate() {
            match *name {
                b"O" => columns.time = index,
                b"T" => columns.kind = index,
                b"B" => columns.bus = Some(index),
                b"I" => columns.id = index,
                b"d" => columns.direction = Some(index),
                b"l" => columns.length = Some(index),
                b"L" => columns.dlc = Some(index),
                b"D" => columns.data = index,
                _ => {}
            }
        }
        let complete = [columns.time, columns.kind, columns.id, columns.data]
            .iter()
            .all(|&c| c != usize::MAX)
            && (columns.length.is_some() || columns.dlc.is_some())
            && columns.data == names.len() - 1;
        complete.then_some(columns)
    }
}

impl TrcParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl LogParser for TrcParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        let header = &mut self.header;
        self.lines.push(chunk, &mut self.stats, |line, stats| {
            line_into(header, line, stats, sink)
        });
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        let header = &mut self.header;
        self.lines.finish(&mut self.stats, |line, stats| {
            line_into(header, line, stats, sink)
        });
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
    }
}

fn line_into<S: FrameSink>(header: &mut Header, line: &[u8], stats: &mut ParseStats, sink: &mut S) {
    if let Some(comment) = line.strip_prefix(b";") {
        header.apply(comment);
        return;
    }
    let result = match header.columns {
        Some(columns) => frame_v2(header.start_ns, columns, line, sink),
        None if header.unusable_columns => Err("unsupported ;$COLUMNS header"),
        None if header.version_2 => Err("missing ;$COLUMNS header"),
        None => frame_v1(header.start_ns, line, sink),
    };
    match result {
        Ok(true) => stats.frames += 1,
        Ok(false) => {}
        Err(reason) => stats.reject(reason),
    }
}

impl Header {
    /// A header line, without its leading `;`.
    fn apply(&mut self, line: &[u8]) {
        let Some(setting) = line.strip_prefix(b"$") else {
            return;
        };
        let Some(equals) = memchr::memchr(b'=', setting) else {
            return;
        };
        let (key, value) = (&setting[..equals], setting[equals + 1..].trim_ascii());
        match key {
            b"FILEVERSION" => self.version_2 = value.starts_with(b"2."),
            b"STARTTIME" => self.start_ns = start_time_ns(value).unwrap_or(0),
            b"COLUMNS" => {
                self.columns = Columns::parse(value);
                self.unusable_columns = self.columns.is_none();
            }
            _ => {}
        }
    }
}

/// `45930.5`, days since 1899-12-30, as nanoseconds since the Unix epoch. A nanosecond is
/// about 1e-14 days, so the fraction is read to 18 digits.
fn start_time_ns(value: &[u8]) -> Option<i64> {
    const NS_PER_DAY: i128 = 86_400_000_000_000;
    let (days, fraction) = match memchr::memchr(b'.', value) {
        Some(dot) => (&value[..dot], &value[dot + 1..]),
        None => (value, &[][..]),
    };
    let fraction = &fraction[..fraction.len().min(18)];
    let days = i128::from(parse_decimal(days)?) - i128::from(UNIX_EPOCH_DAYS);
    let fraction_ns = if fraction.is_empty() {
        0
    } else {
        let scale = 10i128.pow(fraction.len() as u32);
        (i128::from(parse_decimal(fraction)?) * NS_PER_DAY + scale / 2) / scale
    };
    i64::try_from(days * NS_PER_DAY + fraction_ns).ok()
}

/// A frame line of a version 2.x file. Returns whether it held a frame.
fn frame_v2<S: FrameSink>(
    start_ns: i64,
    columns: Columns,
    line: &[u8],
    sink: &mut S,
) -> Result<bool, &'static str> {
    let mut words = fields(line);
    let mut cols: [&[u8]; MAX_COLUMNS] = [&[]; MAX_COLUMNS];
    for col in cols.iter_mut().take(columns.data) {
        *col = words.next().ok_or("too few columns")?;
    }
    let kind = cols[columns.kind];
    let mut frame_flags = match kind {
        b"DT" | b"RR" | b"ER" | b"EC" | b"EB" => 0,
        b"FD" => flags::FD,
        b"FB" => flags::FD | flags::BRS,
        b"FE" => flags::FD | flags::ESI,
        b"BI" => flags::FD | flags::BRS | flags::ESI,
        _ => return Ok(false),
    };
    let ts_ns =
        start_ns.saturating_add(parse_decimal_ns(cols[columns.time], 6).ok_or("bad time offset")?);
    let bus = match columns.bus {
        Some(index) => parse_decimal(cols[index]).ok_or("bad bus number")?,
        None => 1,
    };
    if let Some(index) = columns.direction {
        frame_flags |= parse_direction(cols[index]).ok_or("bad direction")?;
    }
    let len = match (columns.length, columns.dlc) {
        (Some(index), _) => parse_decimal(cols[index])
            .filter(|&n| n <= MAX_PAYLOAD as i64)
            .ok_or("bad data length")? as usize,
        (None, Some(index)) => {
            let dlc = parse_decimal(cols[index])
                .filter(|&n| n <= 15)
                .ok_or("bad DLC")? as u8;
            if frame_flags & flags::FD != 0 {
                dlc_to_len(dlc)
            } else {
                usize::from(dlc.min(8))
            }
        }
        (None, None) => unreachable!("Columns::parse requires a length column"),
    };
    let mut data = [0u8; MAX_PAYLOAD];
    let (id, len) = match kind {
        b"RR" => {
            frame_flags |= flags::RTR;
            (parse_id(cols[columns.id])?, 0)
        }
        b"ER" | b"EC" | b"EB" => {
            frame_flags |= flags::ERROR;
            (ERR_FLAG, read_available_bytes(&mut words, &mut data)?)
        }
        _ => (
            parse_id(cols[columns.id])?,
            read_bytes(&mut words, len, &mut data)?,
        ),
    };
    push(sink, ts_ns, bus, id, frame_flags, &data[..len]);
    Ok(true)
}

/// A frame line of a version 1.x file. Returns whether it held a frame.
fn frame_v1<S: FrameSink>(start_ns: i64, line: &[u8], sink: &mut S) -> Result<bool, &'static str> {
    let mut words = fields(line);
    let number = words.next().ok_or("empty line")?;
    if !number.ends_with(b")") {
        return Err("expected a message number ending in ')'");
    }
    let ts_ns = start_ns.saturating_add(
        parse_decimal_ns(words.next().ok_or("missing time offset")?, 6).ok_or("bad time offset")?,
    );
    let third = words.next().ok_or("missing CAN ID")?;
    let mut frame_flags = 0;
    let mut bus = 1;
    let id = if let Some(direction) = parse_direction(third) {
        frame_flags = direction;
        words.next().ok_or("missing CAN ID")?
    } else if third.eq_ignore_ascii_case(b"Warng") || third.eq_ignore_ascii_case(b"Error") {
        return Ok(false);
    } else {
        let fourth = words.next().ok_or("missing DLC")?;
        match parse_direction(fourth) {
            Some(direction) => {
                frame_flags = direction;
                bus = parse_decimal(third).ok_or("bad bus number")?;
                words.next().ok_or("missing CAN ID")?
            }
            None => {
                let dlc = parse_dlc(fourth)?;
                let len = read_bytes_or_rtr(&mut words, dlc, &mut frame_flags)?;
                return finish_v1(sink, ts_ns, bus, third, frame_flags, len);
            }
        }
    };
    let mut dlc_word = words.next().ok_or("missing DLC")?;
    if dlc_word == b"-" {
        dlc_word = words.next().ok_or("missing DLC")?;
    }
    let dlc = parse_dlc(dlc_word)?;
    let len = read_bytes_or_rtr(&mut words, dlc, &mut frame_flags)?;
    finish_v1(sink, ts_ns, bus, id, frame_flags, len)
}

/// The payload bytes of a 1.x line, or `RTR` in their place.
fn read_bytes_or_rtr<'a>(
    words: &mut impl Iterator<Item = &'a [u8]>,
    dlc: u8,
    frame_flags: &mut u8,
) -> Result<([u8; MAX_PAYLOAD], usize), &'static str> {
    let mut data = [0u8; MAX_PAYLOAD];
    let len = usize::from(dlc.min(8));
    let first = words.next();
    if first == Some(b"RTR") {
        *frame_flags |= flags::RTR;
        return Ok((data, 0));
    }
    let mut words = first.into_iter().chain(words);
    let len = read_bytes(&mut words, len, &mut data)?;
    Ok((data, len))
}

fn finish_v1<S: FrameSink>(
    sink: &mut S,
    ts_ns: i64,
    bus: i64,
    id: &[u8],
    frame_flags: u8,
    (data, len): ([u8; MAX_PAYLOAD], usize),
) -> Result<bool, &'static str> {
    // PCAN-View 1.0 and 1.1 log bus status changes as frames with ID FFFFFFFF.
    if id == b"FFFFFFFF" {
        return Ok(false);
    }
    push(sink, ts_ns, bus, parse_id(id)?, frame_flags, &data[..len]);
    Ok(true)
}

fn push<S: FrameSink>(sink: &mut S, ts_ns: i64, bus: i64, id: u32, frame_flags: u8, data: &[u8]) {
    let channel = sink.channel_index(ChannelName::new(bus as u64).as_bytes());
    sink.push(FrameRef {
        ts_ns,
        channel,
        id,
        flags: frame_flags,
        data,
    });
}

fn parse_direction(word: &[u8]) -> Option<u8> {
    if word.eq_ignore_ascii_case(b"Rx") {
        Some(0)
    } else if word.eq_ignore_ascii_case(b"Tx") {
        Some(flags::TX)
    } else {
        None
    }
}

/// `0001` or `18FEF100`: more than four hex digits, or a value above 0x7FF, means 29-bit.
fn parse_id(word: &[u8]) -> Result<u32, &'static str> {
    match parse_hex_u32(word) {
        Some(id) if id > 0x1FFF_FFFF => Err("bad CAN ID"),
        Some(id) if word.len() > 4 || id > 0x7FF => Ok(id | EXT_FLAG),
        Some(id) => Ok(id),
        None => Err("bad CAN ID"),
    }
}

fn parse_dlc(word: &[u8]) -> Result<u8, &'static str> {
    match parse_decimal(word) {
        Some(dlc) if dlc <= 15 => Ok(dlc as u8),
        _ => Err("bad DLC"),
    }
}

fn read_bytes<'a>(
    words: &mut impl Iterator<Item = &'a [u8]>,
    len: usize,
    data: &mut [u8; MAX_PAYLOAD],
) -> Result<usize, &'static str> {
    for byte in &mut data[..len] {
        let word = words.next().ok_or("too few data bytes")?;
        *byte = parse_byte(word)?;
    }
    Ok(len)
}

/// Every remaining field as a byte, for lines whose length column is not the data length.
fn read_available_bytes<'a>(
    words: &mut impl Iterator<Item = &'a [u8]>,
    data: &mut [u8; MAX_PAYLOAD],
) -> Result<usize, &'static str> {
    let mut len = 0;
    for word in words {
        if len == MAX_PAYLOAD {
            return Err("payload over 64 bytes");
        }
        data[len] = parse_byte(word)?;
        len += 1;
    }
    Ok(len)
}

fn parse_byte(word: &[u8]) -> Result<u8, &'static str> {
    match parse_hex_u32(word) {
        Some(value) if word.len() <= 2 => Ok(value as u8),
        _ => Err("bad data byte"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    fn parse(input: &str) -> (VecSink, ParseStats) {
        parse_chunked(TrcParser::new(), input.as_bytes(), usize::MAX)
    }

    /// 2025-09-30T12:00:00Z.
    const NOON: i64 = 1_759_233_600_000_000_000;

    #[test]
    fn version_2_1_with_every_message_type() {
        let (sink, stats) = parse(
            ";$FILEVERSION=2.1\r\n\
             ;$STARTTIME=45930.5\r\n\
             ;$COLUMNS=N,O,T,B,I,d,R,L,D\r\n\
             ;\r\n\
             ;   Generated by PCAN-View\r\n\
             ;---+-- ------+------ +- +- --+----- +- +- +--- +- -- -- -- -- -- -- --\r\n\
                   1      1059.900 DT 1  0001 Rx -  8  00 11 22 33 44 55 66 77\r\n\
                   2      1283.231 DT 2  18FEF100 Tx -  4  01 02 03 04\r\n\
                   3      1300.000 FD 1  0300 Rx -  13 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F\r\n\
                   4      1301.000 FB 1  0300 Rx -  9  00 01 02 03 04 05 06 07 08 09 0A 0B\r\n\
                   5      1302.000 FE 1  0300 Rx -  0\r\n\
                   6      1303.000 BI 1  0300 Rx -  15 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F\r\n\
                   7      1400.000 RR 1  0123 Rx -  4\r\n\
                   8      1500.000 ST 1  -    Rx -  4  00 00 00 00\r\n\
                   9      1600.000 ER 1  -    Rx -  4  00 00 88 00\r\n\
                  10      1700.000 EC 1  -    Rx -  2  01 02\r\n\
                  11      1800.000 EV 1  -    Rx -  0  a user event\r\n\
                  12      1900.000 DT 1  0800 Rx -  15 00 11 22 33 44 55 66 77\r\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 10);
        assert_eq!(stats.lines, 18);
        assert_eq!(sink.channels, [b"can1".to_vec(), b"can2".to_vec()]);
        assert_eq!(
            sink.frames[0],
            (
                NOON + 1_059_900_000,
                0,
                0x001,
                0,
                vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]
            )
        );
        assert_eq!(
            sink.frames[1],
            (
                NOON + 1_283_231_000,
                1,
                0x18FE_F100 | EXT_FLAG,
                flags::TX,
                vec![1, 2, 3, 4]
            )
        );
        assert_eq!((sink.frames[2].3, sink.frames[2].4.len()), (flags::FD, 32));
        assert_eq!(
            (sink.frames[3].3, sink.frames[3].4.len()),
            (flags::FD | flags::BRS, 12)
        );
        assert_eq!(
            (sink.frames[4].3, sink.frames[4].4.len()),
            (flags::FD | flags::ESI, 0)
        );
        assert_eq!(
            (sink.frames[5].3, sink.frames[5].4.len()),
            (flags::FD | flags::BRS | flags::ESI, 64)
        );
        assert_eq!(
            sink.frames[6],
            (NOON + 1_400_000_000, 0, 0x123, flags::RTR, vec![])
        );
        assert_eq!(
            sink.frames[7],
            (
                NOON + 1_600_000_000,
                0,
                ERR_FLAG,
                flags::ERROR,
                vec![0, 0, 0x88, 0]
            )
        );
        assert_eq!(
            (sink.frames[8].2, sink.frames[8].4.clone()),
            (ERR_FLAG, vec![1, 2])
        );
        let big_dlc = &sink.frames[9];
        assert_eq!((big_dlc.2, big_dlc.4.len()), (0x800 | EXT_FLAG, 8));
    }

    #[test]
    fn version_2_0_without_bus_column_and_length_in_bytes() {
        let (sink, stats) = parse(
            ";$FILEVERSION=2.0\n\
             ;$STARTTIME=45930.5\n\
             ;$COLUMNS=N,O,T,I,d,l,D\n\
             1 10.5 DT 0001 Rx 3 AA BB CC\n\
             2 11.0 FD 0300 Tx 12 00 01 02 03 04 05 06 07 08 09 0A 0B\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.channels, [b"can1".to_vec()]);
        assert_eq!(
            sink.frames[0],
            (NOON + 10_500_000, 0, 1, 0, vec![0xAA, 0xBB, 0xCC])
        );
        assert_eq!(
            (sink.frames[1].3, sink.frames[1].4.len()),
            (flags::FD | flags::TX, 12)
        );
    }

    #[test]
    fn version_1_layouts() {
        let v1_1 = ";$FILEVERSION=1.1\n\
                    ;$STARTTIME=45930.5\n\
                    ;---+--   ----+----  --+--  ----+---  +  -+ -- -- -- -- -- -- --\n\
                         1)      1059.9  Rx         0001  8  00 11 22 33 44 55 66 77\n\
                         2)      1298.9  Tx         18FEF100 4  01 02 03 04\n\
                         3)      1300.0  Rx         0003  4  RTR\n\
                         4)      1301.0  Warng      0004  1  00\n\
                         5)      1302.0  Rx         FFFFFFFF  4  00 00 00 04\n";
        let (sink, stats) = parse(v1_1);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 3);
        assert_eq!(sink.channels, [b"can1".to_vec()]);
        assert_eq!(sink.frames[0].0, NOON + 1_059_900_000);
        assert_eq!(sink.frames[0].4.len(), 8);
        assert_eq!(
            (sink.frames[1].2, sink.frames[1].3),
            (0x18FE_F100 | EXT_FLAG, flags::TX)
        );
        assert_eq!((sink.frames[2].2, sink.frames[2].3), (3, flags::RTR));

        let v1_3 = ";$FILEVERSION=1.3\n\
                    ;$STARTTIME=45930.5\n\
                         1)      1059.9  2  Rx         0001  -  8  00 11 22 33 44 55 66 77\n\
                         2)      1060.9  1  Tx         0002  -  2  AA BB\n";
        let (sink, stats) = parse(v1_3);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.channels, [b"can2".to_vec(), b"can1".to_vec()]);
        assert_eq!(sink.frames[0].4.len(), 8);
        assert_eq!(
            sink.frames[1],
            (NOON + 1_060_900_000, 1, 2, flags::TX, vec![0xAA, 0xBB])
        );

        let v1_2 = ";$FILEVERSION=1.2\n\
                    ;$STARTTIME=45930.5\n\
                         1)      1059.9  2  Rx         0001  8  00 11 22 33 44 55 66 77\n";
        let (sink, stats) = parse(v1_2);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!((sink.frames[0].1, sink.frames[0].4.len()), (0, 8));
        assert_eq!(sink.channels, [b"can2".to_vec()]);

        let v1_0 = ";##########################################################################\n\
                    ;   C:\\trace.trc\n\
                    ;----+- ---+--- ----+--- + -+ -- -- ...\n\
                         1)      1059  0001  8  00 11 22 33 44 55 66 77\n\
                         2)      1283  FFFFFFFF  4  00 00 00 04\n\
                         3)      1290  0002  2  RTR\n";
        let (sink, stats) = parse(v1_0);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 2);
        assert_eq!(
            sink.frames[0],
            (
                1_059_000_000,
                0,
                1,
                0,
                vec![0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]
            )
        );
        assert_eq!((sink.frames[1].2, sink.frames[1].3), (2, flags::RTR));
    }

    #[test]
    fn start_time_keeps_sub_microsecond_precision() {
        assert_eq!(start_time_ns(b"45930.5"), Some(NOON));
        assert_eq!(
            start_time_ns(b"45930.50000001157407407407"),
            Some(NOON + 1_000_000)
        );
        assert_eq!(start_time_ns(b"45930"), Some(NOON - 43_200_000_000_000));
        assert_eq!(start_time_ns(b"99999999999999999999.5"), None);
        assert_eq!(start_time_ns(b"45930.5x"), None);
    }

    #[test]
    fn rejects_malformed_lines_with_reasons() {
        let (sink, stats) = parse(
            ";$FILEVERSION=2.1\n\
             ;$STARTTIME=45930.5\n\
             ;$COLUMNS=N,O,T,B,I,d,R,L,D\n\
             1 x DT 1 0001 Rx - 1 00\n\
             2 1.0 DT 1 000G Rx - 1 00\n\
             3 1.0 DT 1 0001 Rx - 16 00\n\
             4 1.0 DT 1 0001 Rx - 2 00\n\
             5 1.0 DT 1 0001 Rx - 1 0G\n\
             6 1.0 DT 1 0001 Rx\n\
             7 1.0 DT x 0001 Rx - 1 00\n\
             8 1.0 DT 1 0001 Xx - 1 00\n\
             9 1.0 DT 1 20000000 Rx - 1 00\n\
             10 1.0 DT 1 0001 Rx - 1 00\n",
        );
        assert_eq!(sink.frames.len(), 1);
        assert_eq!(stats.rejected, 9);
        assert_eq!(stats.first_rejection, Some((4, "bad time offset")));

        let (sink, stats) = parse(";$FILEVERSION=2.1\n1 1.0 DT 1 0001 Rx - 1 00\n");
        assert!(sink.frames.is_empty());
        assert_eq!(stats.first_rejection, Some((2, "missing ;$COLUMNS header")));

        let (_, stats) = parse(";$FILEVERSION=2.1\n;$COLUMNS=N,O,T,D,I\n1 1.0 DT 00 0001\n");
        assert_eq!(
            stats.first_rejection,
            Some((3, "unsupported ;$COLUMNS header"))
        );

        let (_, stats) = parse("1 1059 0001 8 00\n1) 1059 0001 8 00\n");
        assert_eq!(
            stats.first_rejection,
            Some((1, "expected a message number ending in ')'"))
        );
        assert_eq!(stats.first_rejection.map(|_| stats.rejected), Some(2));
    }

    #[test]
    fn chunk_boundaries_do_not_matter() {
        let input = ";$FILEVERSION=2.1\r\n\
                     ;$STARTTIME=45930.5\r\n\
                     ;$COLUMNS=N,O,T,B,I,d,R,L,D\r\n\
                     1 1059.900 DT 1  0001 Rx -  8  00 11 22 33 44 55 66 77\r\n\
                     2 1283.231 FB 2  18FEF100 Tx -  13  00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F\r\n\
                     3 1400.000 RR 1  0123 Rx -  4\r\n\
                     4 1600.000 ER 1  -    Rx -  4  00 00 88 00\r\n\
                     5 1700.000 DT 1  000G Rx -  1  00\r\n";
        let (sink, stats) = assert_chunking_does_not_matter(TrcParser::new, input.as_bytes());
        assert_eq!((sink.frames.len(), stats.rejected), (4, 1));
    }
}
