//! CSV exports of CAN frames. There is no single CSV layout, so the header line names the
//! columns, and three families are read:
//!
//! - python-can's `CSVWriter`: `timestamp,arbitration_id,extended,remote,error,dlc,data`,
//!   with seconds, a `0x` hex ID and base64 (or hex) data.
//! - SavvyCAN's export: `Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,...,D8`, in microseconds.
//! - Any other header with a time column, an ID column and either one column of hex data or
//!   one column per byte (`D1`, `byte0`, `data[3]`), plus optional length, extended, remote,
//!   error, FD, BRS, ESI, direction and bus columns.
//!
//! The time unit is the one named in the time column's header (`Time (ms)`, `time_us`);
//! otherwise a value with a decimal point is seconds and a whole number is microseconds.

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::lines::LineSplitter;
use crate::text::{hex_value, parse_decimal, parse_decimal_ns, parse_hex_u32, ChannelName};
use crate::{LogParser, ParseStats};

/// Enough for 64 byte columns and the rest.
const MAX_COLUMNS: usize = 96;
const NO_COLUMN: usize = usize::MAX;
const BAD_HEADER: &str = "the CSV header has no time, ID and data columns we know";

#[derive(Debug, Default)]
pub struct CsvParser {
    lines: LineSplitter,
    stats: ParseStats,
    layout: Option<Layout>,
    /// The header line was seen and matched no layout.
    bad_header: bool,
}

#[derive(Debug, Clone)]
struct Layout {
    delimiter: u8,
    time: usize,
    /// Power of ten of nanoseconds per time unit, or `None` to go by the value.
    time_unit: Option<u32>,
    id: usize,
    length: Option<usize>,
    data: Data,
    extended: Option<usize>,
    remote: Option<usize>,
    error: Option<usize>,
    fd: Option<usize>,
    brs: Option<usize>,
    esi: Option<usize>,
    direction: Option<usize>,
    bus: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
enum Data {
    /// One column holding every byte in hex or base64.
    Column(usize),
    /// `count` consecutive columns of one byte each, the first at `first`.
    Bytes { first: usize, count: usize },
}

enum Role {
    Time(Option<u32>),
    Id,
    Length,
    Data,
    Byte(u32),
    Extended,
    Remote,
    Error,
    Fd,
    Brs,
    Esi,
    Direction,
    Bus,
    Other,
}

impl CsvParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

/// Whether `line` is a header line this parser can use, for format detection.
#[must_use]
pub fn is_header(line: &[u8]) -> bool {
    Layout::from_header(line).is_some()
}

impl LogParser for CsvParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        let (layout, bad_header) = (&mut self.layout, &mut self.bad_header);
        self.lines.push(chunk, &mut self.stats, |line, stats| {
            line_into(layout, bad_header, line, stats, sink)
        });
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        let (layout, bad_header) = (&mut self.layout, &mut self.bad_header);
        self.lines.finish(&mut self.stats, |line, stats| {
            line_into(layout, bad_header, line, stats, sink)
        });
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
    }
}

fn line_into<S: FrameSink>(
    layout: &mut Option<Layout>,
    bad_header: &mut bool,
    line: &[u8],
    stats: &mut ParseStats,
    sink: &mut S,
) {
    let result = match layout {
        Some(layout) => row(layout, line, sink),
        None if *bad_header => Err(BAD_HEADER),
        None => {
            *layout = Layout::from_header(line);
            *bad_header = layout.is_none();
            if *bad_header {
                Err(BAD_HEADER)
            } else {
                return;
            }
        }
    };
    match result {
        Ok(()) => stats.frames += 1,
        Err(reason) => stats.reject(reason),
    }
}

impl Layout {
    fn from_header(line: &[u8]) -> Option<Self> {
        let delimiter = pick_delimiter(line);
        let mut layout = Layout {
            delimiter,
            time: NO_COLUMN,
            time_unit: None,
            id: NO_COLUMN,
            length: None,
            data: Data::Column(NO_COLUMN),
            extended: None,
            remote: None,
            error: None,
            fd: None,
            brs: None,
            esi: None,
            direction: None,
            bus: None,
        };
        let mut byte_columns: Vec<(u32, usize)> = Vec::new();
        let mut has_letters = false;
        for (index, raw) in line.split(|&b| b == delimiter).enumerate() {
            if index == MAX_COLUMNS {
                break;
            }
            let key = normalize(cell(raw));
            has_letters |= key.bytes().any(|b| b.is_ascii_alphabetic());
            // The first column of each role wins, as python-can's `error` must not be
            // overridden by a later `error_code`-style column.
            match role(&key) {
                Role::Time(unit) if layout.time == NO_COLUMN => {
                    layout.time = index;
                    layout.time_unit = unit;
                }
                Role::Id if layout.id == NO_COLUMN => layout.id = index,
                Role::Length if layout.length.is_none() => layout.length = Some(index),
                Role::Data if matches!(layout.data, Data::Column(NO_COLUMN)) => {
                    layout.data = Data::Column(index);
                }
                Role::Byte(n) => byte_columns.push((n, index)),
                Role::Extended if layout.extended.is_none() => layout.extended = Some(index),
                Role::Remote if layout.remote.is_none() => layout.remote = Some(index),
                Role::Error if layout.error.is_none() => layout.error = Some(index),
                Role::Fd if layout.fd.is_none() => layout.fd = Some(index),
                Role::Brs if layout.brs.is_none() => layout.brs = Some(index),
                Role::Esi if layout.esi.is_none() => layout.esi = Some(index),
                Role::Direction if layout.direction.is_none() => layout.direction = Some(index),
                Role::Bus if layout.bus.is_none() => layout.bus = Some(index),
                _ => {}
            }
        }
        if matches!(layout.data, Data::Column(NO_COLUMN)) {
            byte_columns.sort_unstable();
            let consecutive = byte_columns
                .windows(2)
                .all(|pair| pair[1].0 == pair[0].0 + 1 && pair[1].1 == pair[0].1 + 1);
            match byte_columns.first() {
                Some(&(_, first)) if consecutive => {
                    layout.data = Data::Bytes {
                        first,
                        count: byte_columns.len().min(MAX_PAYLOAD),
                    };
                }
                _ => return None,
            }
        }
        (has_letters && layout.time != NO_COLUMN && layout.id != NO_COLUMN).then_some(layout)
    }
}

/// The separator that appears most in the header line, comma by default.
fn pick_delimiter(line: &[u8]) -> u8 {
    b",;\t"
        .iter()
        .copied()
        .max_by_key(|&d| line.iter().filter(|&&b| b == d).count())
        .filter(|&d| line.contains(&d))
        .unwrap_or(b',')
}

/// A cell without surrounding spaces and quotes.
fn cell(raw: &[u8]) -> &[u8] {
    let trimmed = raw.trim_ascii();
    trimmed
        .strip_prefix(b"\"")
        .and_then(|c| c.strip_suffix(b"\""))
        .map_or(trimmed, <[u8]>::trim_ascii)
}

/// A header name in lower case without spaces, underscores and dashes, as a key.
fn normalize(name: &[u8]) -> String {
    name.iter()
        .filter(|&&b| !matches!(b, b' ' | b'_' | b'-' | b'\''))
        .map(|&b| b.to_ascii_lowercase() as char)
        .collect()
}

fn role(key: &str) -> Role {
    if let Some(n) = byte_column(key) {
        return Role::Byte(n);
    }
    if key == "t" || key == "ts" || key.starts_with("time") {
        return Role::Time(time_unit(key));
    }
    let base = key.split('(').next().unwrap_or(key);
    match base {
        "id" | "arbitrationid" | "canid" | "identifier" | "frameid" | "msgid" | "messageid"
        | "arbid" => Role::Id,
        "dlc" | "len" | "length" | "datalength" | "datalen" => Role::Length,
        "data" | "databytes" | "payload" | "bytes" | "hexdata" | "datahex" => Role::Data,
        "extended" | "ext" | "ide" | "isextended" | "isextendedid" | "extendedid"
        | "extendedframe" => Role::Extended,
        "remote" | "rtr" | "isremote" | "remoteframe" | "isremoteframe" => Role::Remote,
        "error" | "err" | "iserror" | "errorframe" | "iserrorframe" => Role::Error,
        "fd" | "isfd" | "canfd" | "edl" => Role::Fd,
        "brs" | "bitrateswitch" => Role::Brs,
        "esi" | "errorstateindicator" => Role::Esi,
        "dir" | "direction" | "rx/tx" | "rxtx" => Role::Direction,
        "bus" | "channel" | "interface" | "buschannel" | "chn" | "ch" => Role::Bus,
        _ => Role::Other,
    }
}

/// `d1`, `b0`, `byte3`, `data[2]`: the byte number of a one-byte column.
fn byte_column(key: &str) -> Option<u32> {
    let digits = ["byte", "data", "d", "b"]
        .iter()
        .find_map(|prefix| key.strip_prefix(prefix))?;
    let digits = digits
        .strip_prefix('[')
        .and_then(|d| d.strip_suffix(']'))
        .unwrap_or(digits);
    (!digits.is_empty() && digits.len() <= 3 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// The unit a time column's name ends with, as a power of ten of nanoseconds.
fn time_unit(key: &str) -> Option<u32> {
    let base = key.trim_end_matches(')');
    if base.ends_with("ns") || base.ends_with("nano") || base.ends_with("nanoseconds") {
        Some(0)
    } else if base.ends_with("us") || base.ends_with("micro") || base.ends_with("microseconds") {
        Some(3)
    } else if base.ends_with("ms") || base.ends_with("milli") || base.ends_with("milliseconds") {
        Some(6)
    } else if base.ends_with("(s") || base.ends_with("sec") || base.ends_with("seconds") {
        Some(9)
    } else {
        None
    }
}

fn row<S: FrameSink>(layout: &Layout, line: &[u8], sink: &mut S) -> Result<(), &'static str> {
    let mut cells: [&[u8]; MAX_COLUMNS] = [&[]; MAX_COLUMNS];
    let mut cells_read = 0;
    for raw in line.split(|&b| b == layout.delimiter) {
        if cells_read == MAX_COLUMNS {
            break;
        }
        cells[cells_read] = cell(raw);
        cells_read += 1;
    }
    let get = |column: usize| (column < cells_read).then(|| cells[column]);
    let flag = |column: Option<usize>, reason| match column.and_then(get) {
        Some(value) => parse_bool(value).ok_or(reason),
        None => Ok(false),
    };

    let ts_ns = parse_time(get(layout.time).ok_or("too few columns")?, layout.time_unit)
        .ok_or("bad timestamp")?;
    let extended = flag(layout.extended, "bad extended flag")?;
    let error = flag(layout.error, "bad error flag")?;
    let raw_id = parse_id(get(layout.id).ok_or("too few columns")?, error).ok_or("bad CAN ID")?;
    let mut frame_flags = 0;
    if flag(layout.remote, "bad remote flag")? {
        frame_flags |= flags::RTR;
    }
    if flag(layout.fd, "bad FD flag")? {
        frame_flags |= flags::FD;
    }
    if flag(layout.brs, "bad BRS flag")? {
        frame_flags |= flags::FD | flags::BRS;
    }
    if flag(layout.esi, "bad ESI flag")? {
        frame_flags |= flags::FD | flags::ESI;
    }
    if layout
        .direction
        .and_then(get)
        .is_some_and(|d| d.eq_ignore_ascii_case(b"tx") || d.eq_ignore_ascii_case(b"t"))
    {
        frame_flags |= flags::TX;
    }
    let length = match layout.length.and_then(get) {
        Some(value) => Some(
            parse_decimal(value)
                .filter(|&n| n <= MAX_PAYLOAD as i64)
                .ok_or("bad length")? as usize,
        ),
        None => None,
    };
    let mut data = [0u8; MAX_PAYLOAD];
    let mut len = match layout.data {
        Data::Column(column) => {
            parse_data(get(column).ok_or("too few columns")?, length, &mut data)?
        }
        Data::Bytes { first, count } => {
            if first >= cells_read {
                return Err("too few columns");
            }
            let mut len = 0;
            for column in first..first + count {
                let Some(value) = get(column).filter(|v| !v.is_empty()) else {
                    break;
                };
                data[len] = parse_byte(value).ok_or("bad data byte")?;
                len += 1;
            }
            len
        }
    };
    if let Some(length) = length {
        len = len.min(length);
    }
    if len > 8 {
        frame_flags |= flags::FD;
    }
    let id = if error {
        frame_flags |= flags::ERROR;
        ERR_FLAG | raw_id
    } else if extended || raw_id > 0x7FF {
        raw_id | EXT_FLAG
    } else {
        raw_id
    };
    let channel = match layout.bus.and_then(get).filter(|b| !b.is_empty()) {
        Some(bus) => match parse_decimal(bus) {
            Some(number) => sink.channel_index(ChannelName::new(number as u64).as_bytes()),
            None => sink.channel_index(bus),
        },
        None => sink.channel_index(b"can1"),
    };
    sink.push(FrameRef {
        ts_ns,
        channel,
        id,
        flags: frame_flags,
        data: &data[..len],
    });
    Ok(())
}

/// A timestamp in the header's unit, or by its shape: a decimal point or exponent
/// (python-can's `1e-05`) means seconds and a whole number microseconds.
fn parse_time(value: &[u8], unit: Option<u32>) -> Option<i64> {
    let (negative, digits) = match value.strip_prefix(b"-") {
        Some(rest) => (true, rest),
        None => (false, value),
    };
    let exponent = digits.iter().any(|&b| b == b'e' || b == b'E');
    let unit = unit.unwrap_or(if exponent || digits.contains(&b'.') {
        9
    } else {
        3
    });
    let magnitude = if exponent {
        let number: f64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
        let ns = number * 10f64.powi(unit as i32);
        (ns.is_finite() && ns.abs() < 9e18).then(|| ns.round() as i64)?
    } else {
        parse_decimal_ns(digits, unit)?
    };
    Some(if negative { -magnitude } else { magnitude })
}

/// A hex ID with or without `0x`. Error frames may carry the error flag and class bits
/// above the 29 ID bits, as python-can writes them.
fn parse_id(value: &[u8], error: bool) -> Option<u32> {
    let digits = value
        .strip_prefix(b"0x")
        .or_else(|| value.strip_prefix(b"0X"))
        .unwrap_or(value);
    let id = parse_hex_u32(digits)?;
    if error {
        Some(id & 0x1FFF_FFFF)
    } else {
        (id <= 0x1FFF_FFFF).then_some(id)
    }
}

fn parse_bool(value: &[u8]) -> Option<bool> {
    const TRUE: [&[u8]; 6] = [b"1", b"true", b"yes", b"y", b"t", b"x"];
    const FALSE: [&[u8]; 7] = [b"0", b"false", b"no", b"n", b"f", b"-", b""];
    if TRUE.iter().any(|t| value.eq_ignore_ascii_case(t)) {
        Some(true)
    } else if FALSE.iter().any(|f| value.eq_ignore_ascii_case(f)) {
        Some(false)
    } else {
        None
    }
}

/// One byte in hex, with or without `0x`.
fn parse_byte(value: &[u8]) -> Option<u8> {
    let digits = value
        .strip_prefix(b"0x")
        .or_else(|| value.strip_prefix(b"0X"))
        .unwrap_or(value);
    (digits.len() <= 2)
        .then(|| parse_hex_u32(digits))
        .flatten()
        .map(|b| b as u8)
}

/// A data column as hex (bytes optionally separated by spaces, colons, dashes or dots, with
/// or without `0x`) or as base64. With a known length, the reading that gives that many
/// bytes wins; otherwise hex is tried first.
fn parse_data(
    value: &[u8],
    length: Option<usize>,
    data: &mut [u8; MAX_PAYLOAD],
) -> Result<usize, &'static str> {
    let hex = parse_hex_data(value, data);
    if hex.is_some_and(|n| length.is_none_or(|l| l == n)) {
        return Ok(hex.unwrap_or(0));
    }
    let mut decoded = [0u8; MAX_PAYLOAD];
    match (hex, parse_base64(value, &mut decoded)) {
        (Some(n), Some(m)) if length != Some(m) => Ok(n),
        (Some(n), None) => Ok(n),
        (_, Some(m)) => {
            *data = decoded;
            Ok(m)
        }
        (None, None) => Err("bad data"),
    }
}

fn parse_hex_data(value: &[u8], data: &mut [u8; MAX_PAYLOAD]) -> Option<usize> {
    let mut len = 0;
    let mut pending: Option<u8> = None;
    let mut bytes = value.iter().copied().peekable();
    while let Some(c) = bytes.next() {
        match c {
            b' ' | b':' | b'-' | b'.' | b',' => {
                if pending.is_some() {
                    return None;
                }
            }
            b'0' if pending.is_none() && matches!(bytes.peek(), Some(b'x' | b'X')) => {
                bytes.next();
            }
            _ => {
                let digit = hex_value(c)?;
                match pending.take() {
                    Some(high) => {
                        if len == MAX_PAYLOAD {
                            return None;
                        }
                        data[len] = (high << 4) | digit;
                        len += 1;
                    }
                    None => pending = Some(digit),
                }
            }
        }
    }
    pending.is_none().then_some(len)
}

fn parse_base64(value: &[u8], data: &mut [u8; MAX_PAYLOAD]) -> Option<usize> {
    let value = value.trim_ascii_end();
    let padding = value.iter().rev().take_while(|&&b| b == b'=').count();
    let digits = &value[..value.len() - padding];
    if digits.len() % 4 == 1 || padding > 2 || !(digits.len() + padding).is_multiple_of(4) {
        return None;
    }
    let mut len = 0;
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &c in digits {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if len == MAX_PAYLOAD {
                return None;
            }
            data[len] = (acc >> bits) as u8;
            len += 1;
        }
    }
    Some(len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    fn parse(input: &str) -> (VecSink, ParseStats) {
        parse_chunked(CsvParser::new(), input.as_bytes(), usize::MAX)
    }

    #[test]
    fn python_can_layout_with_base64_and_hex_data() {
        let (sink, stats) = parse(
            "timestamp,arbitration_id,extended,remote,error,dlc,data\n\
             1483389946.197,0xdadada,1,0,0,4,ABCD/w==\n\
             1483389946.2,0x123,0,0,0,8,AAECAwQFBgc=\n\
             1483389946.3,0x123,0,1,0,4,\n\
             1483389946.4,0x20000080,0,0,1,8,AAAAAAAAAAA=\n\
             1e-05,0x7ff,0,0,0,2,1122\n\
             1483389946.5,0x300,0,0,0,12,000102030405060708090a0b\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 6);
        assert_eq!(sink.channels, [b"can1".to_vec()]);
        assert_eq!(
            sink.frames[0],
            (
                1_483_389_946_197_000_000,
                0,
                0xDADADA | EXT_FLAG,
                0,
                vec![0x00, 0x10, 0x83, 0xFF]
            )
        );
        assert_eq!(sink.frames[1].4, (0..8).collect::<Vec<u8>>());
        assert_eq!((sink.frames[2].3, sink.frames[2].4.len()), (flags::RTR, 0));
        assert_eq!(
            (sink.frames[3].2, sink.frames[3].3, sink.frames[3].4.len()),
            (ERR_FLAG | 0x80, flags::ERROR, 8)
        );
        assert_eq!(sink.frames[4], (10_000, 0, 0x7FF, 0, vec![0x11, 0x22]));
        assert_eq!((sink.frames[5].3, sink.frames[5].4.len()), (flags::FD, 12));
    }

    #[test]
    fn savvycan_layout_in_microseconds_with_byte_columns() {
        let (sink, stats) = parse(
            "Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8\r\n\
             1000000,000000F1,false,Rx,0,8,00,11,22,33,44,55,66,77\r\n\
             1000500,18FEF100,true,Tx,1,3,AA,BB,CC,,,,,\r\n\
             1001000,00000100,false,Rx,0,2,01,02\r\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.channels, [b"can0".to_vec(), b"can1".to_vec()]);
        assert_eq!(
            sink.frames[0],
            (
                1_000_000_000,
                0,
                0xF1,
                0,
                vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]
            )
        );
        assert_eq!(
            sink.frames[1],
            (
                1_000_500_000,
                1,
                0x18FE_F100 | EXT_FLAG,
                flags::TX,
                vec![0xAA, 0xBB, 0xCC]
            )
        );
        assert_eq!(sink.frames[2].4, vec![1, 2]);
    }

    #[test]
    fn generic_headers_units_and_delimiters() {
        let (sink, stats) = parse(
            "\u{FEFF}\"Time (ms)\";\"CAN ID\";\"Channel\";\"Length\";\"Data\";\"FD\";\"BRS\"\n\
             12.5;0x123;vcan0;3;01 02 03;0;0\n\
             13;7FF;vcan0;2;0x01:0x02;no;no\n\
             14;18FEF100;can3;12;00-01-02-03-04-05-06-07-08-09-0a-0b;yes;yes\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.channels, [b"vcan0".to_vec(), b"can3".to_vec()]);
        assert_eq!(sink.frames[0], (12_500_000, 0, 0x123, 0, vec![1, 2, 3]));
        assert_eq!(sink.frames[1], (13_000_000, 0, 0x7FF, 0, vec![1, 2]));
        assert_eq!(
            (
                sink.frames[2].1,
                sink.frames[2].2,
                sink.frames[2].3,
                sink.frames[2].4.len()
            ),
            (1, 0x18FE_F100 | EXT_FLAG, flags::FD | flags::BRS, 12)
        );

        let (sink, stats) = parse("time_us\tid\tbyte0\tbyte1\n7\t1\tff\t\n-3\t2\t00\t01\n");
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames[0], (7_000, 0, 1, 0, vec![0xFF]));
        assert_eq!(sink.frames[1], (-3_000, 0, 2, 0, vec![0, 1]));

        let (sink, _) = parse("timestamp_ns,id,data\n1500,1,\n");
        assert_eq!(sink.frames[0], (1500, 0, 1, 0, vec![]));
        let (sink, _) = parse("Time(s),id,data\n2,1,00\n");
        assert_eq!(sink.frames[0].0, 2_000_000_000);
    }

    #[test]
    fn rejects_rows_with_reasons_and_unknown_headers() {
        let (sink, stats) = parse(
            "timestamp,arbitration_id,extended,remote,error,dlc,data\n\
             x,0x123,0,0,0,1,00\n\
             1.0,0xZZZ,0,0,0,1,00\n\
             1.0,0x20000001,0,0,0,1,00\n\
             1.0,0x123,maybe,0,0,1,00\n\
             1.0,0x123,0,0,0,1,0G\n\
             1.0,0x123,0,0,0,99,00\n\
             1.0,0x123\n\
             1.0,0x123,0,0,0,1,00\n",
        );
        assert_eq!(sink.frames.len(), 1);
        assert_eq!(stats.rejected, 7);
        assert_eq!(stats.first_rejection, Some((2, "bad timestamp")));

        let (sink, stats) = parse("a,b,c\n1,2,3\n4,5,6\n");
        assert!(sink.frames.is_empty());
        assert_eq!(
            (stats.rejected, stats.first_rejection),
            (3, Some((1, BAD_HEADER)))
        );

        let (_, stats) = parse("1,2,3\n4,5,6\n");
        assert_eq!(stats.first_rejection, Some((1, BAD_HEADER)));

        assert!(is_header(
            b"Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8"
        ));
        assert!(is_header(
            b"timestamp,arbitration_id,extended,remote,error,dlc,data"
        ));
        assert!(!is_header(b"timestamp,arbitration_id"));
        assert!(!is_header(b"(1.0) can0 123#00"));
        assert!(
            !is_header(b"time,id,d1,d3"),
            "byte columns must be consecutive"
        );
    }

    #[test]
    fn chunk_boundaries_do_not_matter() {
        let input = "timestamp,arbitration_id,extended,remote,error,dlc,data\r\n\
                     1483389946.197,0xdadada,1,0,0,3,ABCD/w==\r\n\
                     1483389946.2,0x123,0,0,0,8,AAECAwQFBgc=\r\n\
                     1483389946.3,0x123,0,1,0,4,\r\n\
                     bad,0x123,0,0,0,1,00\r\n\
                     1483389946.4,0x20000080,0,0,1,8,AAAAAAAAAAA=";
        let (sink, stats) = assert_chunking_does_not_matter(CsvParser::new, input.as_bytes());
        assert_eq!((sink.frames.len(), stats.rejected), (4, 1));
    }
}
