//! Vector ASCII logging (`.asc`), as written by CANoe, CANalyzer and python-can.
//!
//! The header gives the number base (`base hex` or `base dec`) and whether timestamps are
//! absolute (seconds since the start of measurement) or relative (seconds since the previous
//! event). Frame lines look like, in base hex:
//!
//! ```text
//! 0.001234 1  123             Rx   d 8 00 11 22 33 44 55 66 77
//! 0.002000 2  18FEF100x       Tx   r
//! 0.003000 1  ErrorFrame  Flags = 0xe CodeExt = 0x20a2 ...
//! 0.004000 CANFD 1 Rx  300  Name  1 0 d 32 00 11 ...  0 0 3000 0 0 0 0 0
//! ```
//!
//! Everything else (statistics, triggers, J1939 transport, comments) is skipped. Buses are
//! named `can<number>` from the file's 1-based channel numbers. Error frames get the ID
//! [`ERR_FLAG`] alone, as the format carries no SocketCAN error class.

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::lines::LineSplitter;
use crate::text::{fields, parse_decimal, parse_decimal_ns, parse_hex_u32, unix_ns, ChannelName};
use crate::{push_frame, LocalTime, LogParser, ParseStats, PartTimes};

/// Bits of the `Flags` field that follows the data of a CAN FD line.
const FD_FLAG_RTR: u32 = 0x10;
const FD_FLAG_EDL: u32 = 0x1000;

#[derive(Debug, Default)]
pub struct AscParser {
    lines: LineSplitter,
    stats: ParseStats,
    header: Header,
}

#[derive(Debug)]
struct Header {
    hex: bool,
    /// Timestamps are seconds since the previous event rather than since the start.
    relative: bool,
    /// The `date` line as nanoseconds since the Unix epoch; 0 without one.
    start_ns: i64,
    /// Time of the previous event, for relative timestamps.
    last_ns: i64,
    /// The time zone of the `date` line.
    local_time: LocalTime,
    /// In a part of the file read apart from the lines before it, how its relative times count
    /// on from theirs: `last_ns` counts from zero in place of the sum they left.
    part: Option<PartTimes>,
}

impl Default for Header {
    fn default() -> Self {
        Self {
            hex: true,
            relative: false,
            start_ns: 0,
            last_ns: 0,
            local_time: LocalTime::UTC,
            part: None,
        }
    }
}

impl AscParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the time zone the `date` line is read in, UTC unless set.
    pub fn set_local_time(&mut self, local_time: LocalTime) {
        self.header.local_time = local_time;
    }

    /// Forgets the lines read so far, keeping what they set, to go on with a part of the file
    /// that starts at a line boundary further on; see [`crate::AnyParser::prime`].
    pub(crate) fn start_part(&mut self) {
        self.stats = ParseStats::default();
        self.lines = LineSplitter::mid_file();
        self.header.last_ns = 0;
        self.header.part = Some(PartTimes::default());
    }

    pub(crate) fn mid_line(&self) -> bool {
        self.lines.mid_line()
    }

    /// What the header lines read so far set, but the time zone, which the host sets, and the
    /// sum of relative times, which [`AscParser::carried_ns`] gives.
    pub(crate) fn state(&self) -> String {
        let Header {
            hex,
            relative,
            start_ns,
            ..
        } = &self.header;
        format!("{hex} {relative} {start_ns}")
    }

    /// The sum of relative times the lines read so far leave for the lines after them.
    pub(crate) fn carried_ns(&self) -> i64 {
        self.header.last_ns
    }

    /// How the times of the part read since [`AscParser::start_part`] count on from the lines
    /// before it.
    pub(crate) fn part_times(&self) -> PartTimes {
        let mut times = self.header.part.unwrap_or_default();
        if times.open {
            times.from_base_ns = self.header.last_ns;
        }
        times.last_ns = self.header.last_ns;
        times
    }
}

impl LogParser for AscParser {
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
    if !line[0].is_ascii_digit() {
        header.apply(line);
        return;
    }
    match event(header, line, sink) {
        Ok(true) => {
            header.count_part_frame(stats.frames);
            stats.frames += 1;
        }
        Ok(false) => {}
        Err(reason) => stats.reject(reason),
    }
}

impl Header {
    fn apply(&mut self, line: &[u8]) {
        let mut words = fields(line);
        let Some(first) = words.next() else {
            return;
        };
        if first.eq_ignore_ascii_case(b"base") {
            match words.next() {
                Some(base) if base.eq_ignore_ascii_case(b"dec") => self.hex = false,
                Some(base) if base.eq_ignore_ascii_case(b"hex") => self.hex = true,
                _ => {}
            }
            if words
                .next()
                .is_some_and(|w| w.eq_ignore_ascii_case(b"timestamps"))
            {
                self.relative = words
                    .next()
                    .is_some_and(|w| w.eq_ignore_ascii_case(b"relative"));
            }
        } else if first.eq_ignore_ascii_case(b"date") {
            self.start_ns = parse_date(words).map_or(0, |local_ns| {
                let local_s = local_ns.div_euclid(1_000_000_000);
                let shift_s = self.local_time.to_unix(local_s) - local_s;
                local_ns.saturating_add(shift_s.saturating_mul(1_000_000_000))
            });
        } else if first.eq_ignore_ascii_case(b"begin") {
            if let Some(part) = self.part.as_mut().filter(|part| part.open) {
                part.open = false;
                part.from_base_ns = self.last_ns;
            }
            self.last_ns = 0;
        }
    }

    /// Counts a part's frame, the one after its first `frames_before`, among those timed from
    /// the sum the lines before the part left.
    fn count_part_frame(&mut self, frames_before: u64) {
        let Some(part) = &mut self.part else {
            return;
        };
        if self.relative && part.open {
            if part.frames == frames_before {
                part.frames += 1;
            } else {
                part.scattered = true;
            }
        }
    }

    /// The absolute time of an event stamped `ts_ns` in the file.
    fn event_time(&mut self, ts_ns: i64) -> i64 {
        if self.relative {
            self.last_ns = self.last_ns.saturating_add(ts_ns);
            self.start_ns.saturating_add(self.last_ns)
        } else {
            self.start_ns.saturating_add(ts_ns)
        }
    }
}

/// Whether `line` is a `date` header line with a date this parser reads.
pub(crate) fn is_date_line(line: &[u8]) -> bool {
    let mut words = fields(line);
    words
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case(b"date"))
        && parse_date(words).is_some()
}

/// `Mon Sep 1 10:00:00.123 am 2025`, with or without the weekday, milliseconds and am/pm,
/// as nanoseconds since the Unix epoch.
fn parse_date<'a>(words: impl Iterator<Item = &'a [u8]>) -> Option<i64> {
    let words: Vec<&[u8]> = words.collect();
    let month_at = words.iter().position(|w| month_number(w).is_some())?;
    let month = month_number(words[month_at])?;
    let day = parse_decimal(words.get(month_at + 1)?)?;
    let (mut hour, minute, second_ns) = parse_time(words.get(month_at + 2)?)?;
    let mut rest = words[month_at + 3..].iter();
    let mut word = rest.next()?;
    if word.eq_ignore_ascii_case(b"am") || word.eq_ignore_ascii_case(b"pm") {
        if hour == 12 {
            hour = 0;
        }
        if word.eq_ignore_ascii_case(b"pm") {
            hour += 12;
        }
        word = rest.next()?;
    }
    let year = parse_decimal(word)?;
    if !(1..=31).contains(&day) || hour > 23 || minute > 59 || second_ns >= 61_000_000_000 {
        return None;
    }
    unix_ns(
        year,
        month,
        day as u32,
        (hour * 3600 + minute * 60) * 1_000_000_000 + second_ns,
    )
}

fn month_number(word: &[u8]) -> Option<u32> {
    const MONTHS: [&[u8]; 12] = [
        b"jan", b"feb", b"mar", b"apr", b"may", b"jun", b"jul", b"aug", b"sep", b"oct", b"nov",
        b"dec",
    ];
    const GERMAN: [(&[u8], u32); 3] = [(b"mai", 5), (b"okt", 10), (b"dez", 12)];
    if word.len() < 3 {
        return None;
    }
    let short = &word[..3];
    MONTHS
        .iter()
        .position(|m| short.eq_ignore_ascii_case(m))
        .map(|i| i as u32 + 1)
        .or_else(|| {
            GERMAN
                .iter()
                .find(|(m, _)| short.eq_ignore_ascii_case(m))
                .map(|&(_, n)| n)
        })
}

/// `10:00:00.123` as (hour, minute, nanoseconds within the minute).
fn parse_time(word: &[u8]) -> Option<(i64, i64, i64)> {
    let mut parts = word.split(|&b| b == b':');
    let hour = parse_decimal(parts.next()?)?;
    let minute = parse_decimal(parts.next()?)?;
    let second_ns = parse_decimal_ns(parts.next()?, 9)?;
    parts.next().is_none().then_some((hour, minute, second_ns))
}

/// A line that starts with a timestamp. Returns whether it held a frame.
fn event<S: FrameSink>(
    header: &mut Header,
    line: &[u8],
    sink: &mut S,
) -> Result<bool, &'static str> {
    let mut words = fields(line);
    let ts = words.next().unwrap_or_default();
    let ts_ns = parse_decimal_ns(ts, 9).ok_or("bad timestamp")?;
    let ts_ns = header.event_time(ts_ns);
    let Some(second) = words.next() else {
        return Ok(false);
    };
    if second.eq_ignore_ascii_case(b"CANFD") {
        return fd_frame(header, ts_ns, words, sink).map(|()| true);
    }
    let Some(channel) = parse_decimal(second) else {
        return Ok(false);
    };
    let Some(third) = words.next() else {
        return Ok(false);
    };
    if third.eq_ignore_ascii_case(b"ErrorFrame") {
        push_error(ts_ns, channel, sink);
        return Ok(true);
    }
    let Some(direction) = words.next().and_then(parse_direction) else {
        return Ok(false);
    };
    let id = parse_id(third, header.hex).ok_or("bad CAN ID")?;
    let mut frame_flags = direction;
    let mut data = [0u8; MAX_PAYLOAD];
    let mut remote_dlc = None;
    let len = match words
        .next()
        .ok_or("missing frame type after the direction")?
    {
        b"d" | b"D" => {
            // CAN FD frames come on CANFD lines; a classic frame with a DLC of 9 to 15
            // carries 8 bytes.
            let dlc = parse_dlc(words.next().ok_or("missing DLC")?, header.hex)?;
            read_bytes(&mut words, usize::from(dlc.min(8)), header.hex, &mut data)?
        }
        b"r" | b"R" => {
            frame_flags |= flags::RTR;
            // The DLC is optional, and other text may follow the `r`.
            remote_dlc = words.next().and_then(|w| parse_dlc(w, header.hex).ok());
            0
        }
        _ => return Err("expected 'd' or 'r' after the direction"),
    };
    let channel = sink.channel_index(ChannelName::new(channel as u64).as_bytes());
    let frame = FrameRef {
        ts_ns,
        channel,
        id,
        flags: frame_flags,
        data: &data[..len],
    };
    push_frame(sink, frame, remote_dlc);
    Ok(true)
}

/// The rest of a `CANFD` line after its timestamp.
fn fd_frame<'a, S: FrameSink>(
    header: &Header,
    ts_ns: i64,
    mut words: impl Iterator<Item = &'a [u8]>,
    sink: &mut S,
) -> Result<(), &'static str> {
    let channel = words
        .next()
        .and_then(parse_decimal)
        .ok_or("bad CAN FD channel")?;
    let direction = words
        .next()
        .and_then(parse_direction)
        .ok_or("bad CAN FD direction")?;
    let id = words.next().ok_or("missing CAN ID")?;
    if id.eq_ignore_ascii_case(b"ErrorFrame") {
        push_error(ts_ns, channel, sink);
        return Ok(());
    }
    let id = parse_id(id, header.hex).ok_or("bad CAN ID")?;
    // A symbolic name may come before the BRS bit.
    let mut brs = words.next().ok_or("missing BRS")?;
    if !matches!(brs, b"0" | b"1") {
        brs = words.next().ok_or("missing BRS")?;
    }
    let esi = words.next().ok_or("missing ESI")?;
    let dlc = parse_dlc(words.next().ok_or("missing DLC")?, header.hex)?;
    let len = words
        .next()
        .and_then(parse_decimal)
        .filter(|&n| n <= MAX_PAYLOAD as i64)
        .ok_or("bad data length")? as usize;
    let mut data = [0u8; MAX_PAYLOAD];
    read_bytes(&mut words, len, header.hex, &mut data)?;
    let mut frame_flags = direction | flags::FD;
    if brs == b"1" {
        frame_flags |= flags::BRS;
    }
    if esi == b"1" {
        frame_flags |= flags::ESI;
    }
    // After the message duration and length, the flags field says whether the frame really
    // used CAN FD: classic frames on an FD channel are logged as CANFD lines without EDL.
    let after_data = (words.next(), words.next(), words.next());
    if let (Some(_), Some(_), Some(fd_flags)) = after_data {
        if let Some(fd_flags) = parse_hex_u32(fd_flags) {
            if fd_flags & FD_FLAG_EDL == 0 {
                frame_flags &= !(flags::FD | flags::BRS | flags::ESI);
            }
            if fd_flags & FD_FLAG_RTR != 0 {
                frame_flags |= flags::RTR;
            }
        }
    }
    let channel = sink.channel_index(ChannelName::new(channel as u64).as_bytes());
    let frame = FrameRef {
        ts_ns,
        channel,
        id,
        flags: frame_flags,
        data: &data[..len],
    };
    push_frame(sink, frame, (frame_flags & flags::RTR != 0).then_some(dlc));
    Ok(())
}

fn push_error<S: FrameSink>(ts_ns: i64, channel: i64, sink: &mut S) {
    let channel = sink.channel_index(ChannelName::new(channel as u64).as_bytes());
    sink.push(FrameRef {
        ts_ns,
        channel,
        id: ERR_FLAG,
        flags: flags::ERROR,
        data: &[],
    });
}

fn parse_direction(word: &[u8]) -> Option<u8> {
    if word.eq_ignore_ascii_case(b"Rx") {
        Some(0)
    } else if word.eq_ignore_ascii_case(b"Tx") || word.eq_ignore_ascii_case(b"TxRq") {
        Some(flags::TX)
    } else {
        None
    }
}

/// `123`, `18FEF100x` (or decimal in base dec). An ID above 0x7FF is extended even without
/// the `x`, since no 11-bit ID can be.
fn parse_id(word: &[u8], hex: bool) -> Option<u32> {
    let (digits, extended) = match word.split_last() {
        Some((b'x' | b'X', digits)) => (digits, true),
        _ => (word, false),
    };
    let id = parse_number(digits, hex)?;
    if id > 0x1FFF_FFFF {
        None
    } else if extended || id > 0x7FF {
        Some(id | EXT_FLAG)
    } else {
        Some(id)
    }
}

fn parse_number(word: &[u8], hex: bool) -> Option<u32> {
    if hex {
        parse_hex_u32(word)
    } else {
        parse_decimal(word).and_then(|n| u32::try_from(n).ok())
    }
}

fn parse_dlc(word: &[u8], hex: bool) -> Result<u8, &'static str> {
    match parse_number(word, hex) {
        Some(dlc) if dlc <= 15 => Ok(dlc as u8),
        _ => Err("bad DLC"),
    }
}

fn read_bytes<'a>(
    words: &mut impl Iterator<Item = &'a [u8]>,
    len: usize,
    hex: bool,
    data: &mut [u8; MAX_PAYLOAD],
) -> Result<usize, &'static str> {
    for byte in &mut data[..len] {
        let word = words.next().ok_or("too few data bytes")?;
        *byte = match parse_number(word, hex) {
            Some(value) if value <= 0xFF && word.len() <= 3 => value as u8,
            _ => return Err("bad data byte"),
        };
    }
    Ok(len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    fn parse(input: &str) -> (VecSink, ParseStats) {
        parse_chunked(AscParser::new(), input.as_bytes(), usize::MAX)
    }

    const HEADER: &str = "date Tue Sep 30 00:00:00.000 2025\nbase hex  timestamps absolute\ninternal events logged\nBegin Triggerblock Tue Sep 30 00:00:00.000 2025\n   0.000000 Start of measurement\n";

    #[test]
    fn classic_frames_with_date_base_hex() {
        let (sink, stats) = parse(&format!(
            "{HEADER}\
             0.001234 1  123             Rx   d 8 00 11 22 33 44 55 66 77  Length = 123910 BitCount = 125 ID = 291\n\
             0.002000 2  18FEF100x       Tx   d 2 AA BB\n\
             0.003000 1  7FF             TxRq d 0\n\
             0.004000 1  1FFFFFFF        Rx   d 1 FF\n\
             0.005000 2  123             Rx   r\n\
             0.006000 2  123             Rx   r 8\n\
             0.006500 2  123             Rx   d F 00 11 22 33 44 55 66 77\n\
             0.007000 1  ErrorFrame  Flags = 0xe CodeExt = 0x20a2 Code = 0x82 ID = 0 DLC = 0 Position = 5 Length = 11300\n\
             End TriggerBlock\n"
        ));
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 8);
        assert_eq!(sink.channels, [b"can1".to_vec(), b"can2".to_vec()]);
        let start = 1_759_190_400_000_000_000;
        assert_eq!(
            sink.frames[0],
            (
                start + 1_234_000,
                0,
                0x123,
                0,
                vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]
            )
        );
        assert_eq!(
            sink.frames[1],
            (
                start + 2_000_000,
                1,
                0x18FE_F100 | EXT_FLAG,
                flags::TX,
                vec![0xAA, 0xBB]
            )
        );
        assert_eq!(
            sink.frames[2],
            (start + 3_000_000, 0, 0x7FF, flags::TX, vec![])
        );
        assert_eq!(
            sink.frames[3].2,
            0x1FFF_FFFF | EXT_FLAG,
            "extended without x"
        );
        assert_eq!(sink.frames[4].3, flags::RTR);
        assert_eq!(sink.frames[5].3, flags::RTR);
        assert_eq!(sink.remote_dlcs[4..6], [None, Some(8)]);
        assert_eq!(
            (sink.frames[6].3, sink.frames[6].4.len()),
            (0, 8),
            "a classic DLC above 8 carries 8 bytes"
        );
        assert_eq!(
            sink.frames[7],
            (start + 7_000_000, 0, ERR_FLAG, flags::ERROR, vec![])
        );
    }

    #[test]
    fn base_dec_and_relative_timestamps() {
        let (sink, stats) = parse(
            "date Mon Jan 1 12:00:00.500 am 2024\n\
             base dec  timestamps relative\n\
             0.5 1  291  Rx   d 3 255 0 16\n\
             0.25 1  Statistic: D 1 R 0 XD 0 XR 0 E 0 O 0 B 0.00%\n\
             0.25 1  305419896x Rx d 1 1\n\
             1.0 CANFD 1 Rx 291 1 0 15 64 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        let midnight = 1_704_067_200_000_000_000;
        assert_eq!(sink.frames[0].0, midnight + 1_000_000_000);
        assert_eq!(sink.frames[0].2, 0x123);
        assert_eq!(sink.frames[0].4, vec![255, 0, 16]);
        assert_eq!(
            sink.frames[1].0,
            midnight + 1_500_000_000,
            "skipped events still advance time"
        );
        assert_eq!(sink.frames[1].2, 0x1234_5678 | EXT_FLAG);
        assert_eq!(sink.frames[2].0, midnight + 2_500_000_000);
        assert_eq!(sink.frames[2].4.len(), 64);
        assert_eq!(sink.frames[2].4[63], 63);
    }

    #[test]
    fn can_fd_lines_in_every_variant() {
        let (sink, stats) = parse(
            "base hex  timestamps absolute\n\
             0.1 CANFD 1 Rx  300  EngineData  1 0 d 32 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F  200000  400 3000 1234abcd 460800 2000000 460800 2000000\n\
             0.2 CANFD 2 Tx  18FEF100x 0 1 8 8 11 22 33 44 55 66 77 88\n\
             0.3 CANFD 1 Rx  123 0 0 8 8 11 22 33 44 55 66 77 88 0 0 0 0 0 0 0 0\n\
             0.4 CANFD 1 Rx  123 0 0 8 0 0 0 10 0 0 0 0 0\n\
             0.5 CANFD 1 Rx ErrorFrame Not Acknowledge error, dominant error flag\n\
             0.6 CANFD 1 Rx  300 1 1 f 64 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F\n",
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 6);
        let named = &sink.frames[0];
        assert_eq!(
            (named.2, named.3, named.4.len()),
            (0x300, flags::FD | flags::BRS, 32)
        );
        assert_eq!(named.4[31], 0x1F);
        let unnamed = &sink.frames[1];
        assert_eq!(
            (unnamed.1, unnamed.2, unnamed.3),
            (
                1,
                0x18FE_F100 | EXT_FLAG,
                flags::FD | flags::ESI | flags::TX
            )
        );
        assert_eq!(
            sink.frames[2].3, 0,
            "no EDL flag: a classic frame on an FD channel"
        );
        assert_eq!(
            sink.frames[3].3,
            flags::RTR,
            "remote frame via the flags field"
        );
        assert_eq!(sink.frames[3].4, vec![]);
        assert_eq!(sink.remote_dlcs[3], Some(8));
        assert_eq!(
            (sink.frames[4].2, sink.frames[4].3),
            (ERR_FLAG, flags::ERROR)
        );
        assert_eq!(sink.frames[5].3, flags::FD | flags::BRS | flags::ESI);
        assert_eq!(sink.frames[5].4.len(), 64);
    }

    #[test]
    fn rejects_malformed_frame_lines_and_skips_other_events() {
        let (sink, stats) = parse(
            "date Tue Sep 30 00:00:00.000 2025\n\
             base hex  timestamps absolute\n\
             // a comment\n\
             0.1 1  12G             Rx   d 1 00\n\
             0.2 1  123             Rx   d 9 00\n\
             0.3 1  123             Rx   d 3 00 11\n\
             0.4 1  123             Rx   d 1 0G\n\
             0.5 1  123             Rx   x 1 00\n\
             0.6 1  123             Rx\n\
             0.7 CANFD 1 Rx 123 0 0 8 8 11\n\
             0.8 CANFD 1 Rx 123 0 0 8 99 11\n\
             0.9 1  J1939TP  18ECFF00x  7  20 10 00 02 FF 00 EE 00\n\
             1.0 1  SDS   something else\n\
             1.1 Start of measurement\n\
             1.2 CAN 1 Status:chip status error active\n\
             0.x 1  123             Rx   d 1 00\n\
             1.3 1  123             Rx   d 1 00\n",
        );
        assert_eq!(sink.frames.len(), 1);
        assert_eq!(stats.rejected, 9);
        assert_eq!(stats.first_rejection, Some((4, "bad CAN ID")));
        assert_eq!(stats.lines, 17);
    }

    #[test]
    fn dates_in_their_variants() {
        let date = |s: &str| parse_date(fields(s.as_bytes()));
        let noon = Some(1_704_110_400_000_000_000);
        assert_eq!(date("Mon Jan 1 12:00:00.000 pm 2024"), noon);
        assert_eq!(date("Mon Jan 1 12:00:00 2024"), noon);
        assert_eq!(date("Jan 1 12:00:00 2024"), noon);
        assert_eq!(
            date("Mon Jan 1 11:59:59.999 am 2024"),
            Some(1_704_110_399_999_000_000)
        );
        assert_eq!(
            date("Mo Dez 24 00:00:00.000 2024"),
            Some(1_735_000_000_000_000_000 - 1_000_000_000 * (1_735_000_000 - 1_734_998_400))
        );
        assert_eq!(date("Mon Jan 32 12:00:00 2024"), None);
        assert_eq!(date("Mon Foo 1 12:00:00 2024"), None);
        assert_eq!(date("Mon Jan 1 12:00 2024"), None);
        assert_eq!(date("Mon Jan 1 12:00:00 999999999999999999"), None);
        assert_eq!(date("Mon Jan 1 12:00:00 1601"), None);
        assert_eq!(date(""), None);
    }

    #[test]
    fn chunk_boundaries_do_not_matter() {
        let input = format!(
            "{HEADER}\
             0.001234 1  123             Rx   d 8 00 11 22 33 44 55 66 77\n\
             0.002000 2  18FEF100x       Tx   r\n\
             0.003000 1  ErrorFrame\n\
             0.004000 CANFD 1 Rx  300  1 0 d 32 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 0 0 3000 0 0 0 0 0\n\
             0.005000 1  123             Rx   d 9 00\n\
             End TriggerBlock\n"
        );
        let (sink, stats) = assert_chunking_does_not_matter(AscParser::new, input.as_bytes());
        assert_eq!((sink.frames.len(), stats.frames, stats.rejected), (4, 4, 1));
    }
}
