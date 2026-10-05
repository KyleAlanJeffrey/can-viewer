//! Writers for every format the parsers read, so a log can be saved in another format.
//!
//! A writer takes the frames of a [`FrameStore`] in store order, except the J1939 transfers
//! the store reassembled ([`flags::REASSEMBLED`]): they are not in the log, and reading the
//! file again reassembles them from their packets. What each format keeps is listed under
//! "Exporting logs" in COMPATIBILITY.md.

mod blf;
mod mf4;
mod text;

use std::borrow::Cow;
use std::io::{self, Seek, Write};

use can_core::{flags, FrameRef, FrameStore};

use crate::Format;

/// Writes the frames of `store` to `out` as `format`. BLF and MF4 seek back to fill in links
/// and sizes once their frames are written; the text formats only write forward.
pub fn write_log<W: Write + Seek>(
    format: Format,
    store: &FrameStore,
    out: &mut W,
) -> io::Result<()> {
    match format {
        Format::Candump => text::write_candump(store, out),
        Format::Asc => text::write_asc(store, out),
        Format::Trc => text::write_trc(store, out),
        Format::Csv => text::write_csv(store, out),
        Format::Blf => blf::write_blf(store, out),
        Format::Mf4 => mf4::write_mf4(store, out),
    }
}

/// The frames that came from the log.
fn log_frames(store: &FrameStore) -> impl Iterator<Item = FrameRef<'_>> {
    (0..store.len())
        .map(|index| store.frame(index))
        .filter(|frame| frame.flags & flags::REASSEMBLED == 0)
}

/// The earliest time of a log frame, which the formats with a start time count from. The store
/// is in time order once loaded, unless it was too large to sort.
fn start_ns(store: &FrameStore) -> i64 {
    log_frames(store).map(|f| f.ts_ns).min().unwrap_or(0)
}

/// Whether a frame needs a CAN FD record: a classic frame carries at most 8 bytes, and an MF4
/// file can give one more without marking it CAN FD.
fn is_fd(frame: &FrameRef<'_>) -> bool {
    frame.flags & flags::FD != 0 || frame.data.len() > 8
}

/// The channel number to write for each bus of the store, for the formats that number their
/// buses. When every bus is already named `can<N>` (as those formats name them on reading),
/// with N from 1 to 255 and no two alike, N is kept; otherwise buses are numbered from 1 in
/// order of first appearance.
fn bus_numbers(store: &FrameStore) -> Vec<u8> {
    let named: Option<Vec<u8>> = store
        .channels()
        .iter()
        .map(|name| {
            let number = name.strip_prefix("can")?;
            if number.starts_with('0') {
                return None;
            }
            number.parse::<u8>().ok()
        })
        .collect();
    if let Some(numbers) = named {
        let mut sorted = numbers.clone();
        sorted.sort_unstable();
        sorted.dedup();
        if sorted.len() == numbers.len() {
            return numbers;
        }
    }
    (0..store.channels().len())
        .map(|index| u8::try_from(index + 1).unwrap_or(u8::MAX))
        .collect()
}

/// A bus name fit for a space- or comma-separated field.
fn plain_name(name: &str) -> Cow<'_, str> {
    if name.is_empty() {
        return Cow::Borrowed("can");
    }
    let unfit = |c: char| c.is_whitespace() || c.is_control() || c == ',' || c == '"';
    if name.contains(unfit) {
        Cow::Owned(name.replace(unfit, "_"))
    } else {
        Cow::Borrowed(name)
    }
}

/// `seconds.micros` of a time in nanoseconds, truncated to the microsecond.
fn write_seconds(out: &mut impl Write, ts_ns: i64) -> io::Result<()> {
    let sign = if ts_ns < 0 { "-" } else { "" };
    let ns = ts_ns.unsigned_abs();
    write!(
        out,
        "{sign}{}.{:06}",
        ns / 1_000_000_000,
        ns % 1_000_000_000 / 1000
    )
}

fn write_hex_bytes(out: &mut impl Write, data: &[u8]) -> io::Result<()> {
    for byte in data {
        write!(out, " {byte:02X}")?;
    }
    Ok(())
}

/// The CAN FD DLC code for a payload length, rounding up to the next code.
fn len_to_dlc(len: usize) -> u8 {
    const LENGTHS: [usize; 7] = [12, 16, 20, 24, 32, 48, 64];
    if len <= 8 {
        return len as u8;
    }
    LENGTHS
        .iter()
        .position(|&l| len <= l)
        .map_or(15, |i| 9 + i as u8)
}

/// The proleptic Gregorian date `days` after 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_from_march + 2) / 5 + 1) as u32;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use can_core::{FrameSink, ERR_FLAG, EXT_FLAG};

    use super::*;
    use crate::{AnyParser, LogParser};

    /// 2025-09-30T00:00:00.123456Z
    const T0: i64 = 1_759_190_400_123_456_000;

    /// `(ts_ns, channel, id, flags, data)` of every frame, reassembled ones included.
    type Frame = (i64, u8, u32, u8, Vec<u8>);

    fn frames(store: &FrameStore) -> Vec<Frame> {
        (0..store.len())
            .map(|i| store.frame(i))
            .map(|f| (f.ts_ns, f.channel, f.id, f.flags, f.data.to_vec()))
            .collect()
    }

    fn push(store: &mut FrameStore, us: i64, bus: &str, id: u32, flags: u8, data: &[u8]) {
        let channel = store.channel_index(bus.as_bytes());
        store.push(FrameRef {
            ts_ns: T0 + us * 1000,
            channel,
            id,
            flags,
            data,
        });
    }

    /// A frame of every kind on two buses, and a J1939 BAM transfer of 100 bytes in 15 packets,
    /// which the store reassembles into one frame longer than any CAN frame.
    fn sample_log(buses: [&str; 2]) -> FrameStore {
        let [a, b] = buses;
        let mut store = FrameStore::new();
        push(&mut store, 0, a, 0x123, 0, &[1, 2, 3, 4, 5, 6, 7, 8]);
        push(&mut store, 10, a, 0x0C9, flags::TX, &[0xFF]);
        push(&mut store, 20, b, 0x7FF, flags::RTR, &[]);
        push(&mut store, 30, a, 0x1234_5678 | EXT_FLAG, 0, &[0xAB, 0xCD]);
        let fd = [0x5A; 12];
        push(&mut store, 40, b, 0x321, flags::FD | flags::BRS, &fd);
        let long = [0xC3; 64];
        push(
            &mut store,
            50,
            b,
            0x18DA_F100 | EXT_FLAG,
            flags::FD | flags::ESI,
            &long,
        );
        push(&mut store, 60, a, 0x456, 0, &[]);
        push(
            &mut store,
            70,
            a,
            ERR_FLAG | 0x80,
            flags::ERROR,
            &[0, 0, 8, 0, 0, 0, 0, 0],
        );
        let bam = [32, 100, 0, 15, 0xFF, 0xCA, 0xFE, 0x00];
        push(&mut store, 1000, a, 0x1CEC_FF00 | EXT_FLAG, 0, &bam);
        for packet in 1..=15u8 {
            let mut data = [packet; 8];
            data[0] = packet;
            push(
                &mut store,
                1000 + 50 * i64::from(packet),
                a,
                0x1CEB_FF00 | EXT_FLAG,
                0,
                &data,
            );
        }
        push(
            &mut store,
            2000,
            b,
            0x18FE_F100 | EXT_FLAG,
            flags::TX,
            &[9; 8],
        );
        store.sort_by_time();
        assert_eq!(store.reassembled_frames(), 1);
        store
    }

    fn write(format: Format, store: &FrameStore) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        write_log(format, store, &mut out).unwrap();
        out.into_inner()
    }

    fn read(format: Format, bytes: &[u8]) -> FrameStore {
        let detected = Format::detect(&format!("x.{}", format.extension()), bytes);
        assert_eq!(detected, format);
        let mut parser = AnyParser::new(format);
        let mut store = FrameStore::new();
        for chunk in bytes.chunks(4096) {
            parser.push(chunk, &mut store);
        }
        parser.finish(&mut store);
        store.sort_by_time();
        let stats = parser.stats();
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        store
    }

    /// What reading back an error frame gives in the formats without error classes: the error
    /// flag with no class, and the data bytes if the format keeps them.
    fn classless_errors(frames: &mut [Frame], keep_data: bool) {
        for frame in frames.iter_mut().filter(|f| f.3 & flags::ERROR != 0) {
            frame.2 = ERR_FLAG;
            if !keep_data {
                frame.4.clear();
            }
        }
    }

    fn round_trip(format: Format, buses: [&str; 2]) -> (Vec<Frame>, Vec<Frame>, Vec<String>) {
        let original = sample_log(buses);
        let copy = read(format, &write(format, &original));
        (frames(&original), frames(&copy), copy.channels().to_vec())
    }

    #[test]
    fn candump_and_csv_keep_every_frame_and_bus_name() {
        for format in [Format::Candump, Format::Csv] {
            let (original, copy, channels) = round_trip(format, ["can0", "vcan1"]);
            assert_eq!(copy, original, "{format:?}");
            assert_eq!(channels, ["can0", "vcan1"], "{format:?}");
        }
    }

    #[test]
    fn numbered_formats_keep_frames_but_not_error_classes() {
        for (format, keeps_error_data) in [
            (Format::Asc, false),
            (Format::Trc, true),
            (Format::Blf, true),
            (Format::Mf4, true),
        ] {
            let (mut original, copy, channels) = round_trip(format, ["can0", "vcan1"]);
            classless_errors(&mut original, keeps_error_data);
            assert_eq!(copy, original, "{format:?}");
            assert_eq!(channels, ["can1", "can2"], "{format:?}");
        }
    }

    #[test]
    fn numbered_buses_keep_their_numbers() {
        for format in [Format::Asc, Format::Trc, Format::Blf, Format::Mf4] {
            let (_, _, channels) = round_trip(format, ["can3", "can1"]);
            assert_eq!(channels, ["can3", "can1"], "{format:?}");
        }
    }

    #[test]
    fn blf_and_mf4_keep_nanoseconds_and_the_rest_microseconds() {
        let mut store = FrameStore::new();
        let channel = store.channel_index(b"can1");
        for ts_ns in [T0 + 1, T0 + 3_600_000_000_999] {
            store.push(FrameRef {
                ts_ns,
                channel,
                id: 0x100,
                flags: 0,
                data: &[1],
            });
        }
        for format in [
            Format::Candump,
            Format::Asc,
            Format::Trc,
            Format::Csv,
            Format::Blf,
            Format::Mf4,
        ] {
            let copy = read(format, &write(format, &store));
            let times: Vec<i64> = (0..copy.len()).map(|i| copy.frame(i).ts_ns).collect();
            let expected = if matches!(format, Format::Blf | Format::Mf4) {
                [T0 + 1, T0 + 3_600_000_000_999]
            } else {
                [T0, T0 + 3_600_000_000_000]
            };
            assert_eq!(times, expected, "{format:?}");
        }
    }

    #[test]
    fn reassembled_transfers_are_not_written() {
        let store = sample_log(["can0", "can1"]);
        let text = String::from_utf8(write(Format::Candump, &store)).unwrap();
        assert_eq!(text.lines().count(), store.len() - 1);
        assert!(!text.contains("1CFECA00"), "{text}");
        assert!(text.contains("1CEBFF00#0F0F0F0F0F0F0F0F"));
    }

    #[test]
    fn candump_lines_are_as_candump_writes_them() {
        let store = sample_log(["can0", "can1"]);
        let text = String::from_utf8(write(Format::Candump, &store)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "(1759190400.123456) can0 123#0102030405060708");
        assert_eq!(lines[1], "(1759190400.123466) can0 0C9#FF T");
        assert_eq!(lines[2], "(1759190400.123476) can1 7FF#R");
        assert_eq!(lines[3], "(1759190400.123486) can0 12345678#ABCD");
        assert_eq!(
            lines[4],
            format!("(1759190400.123496) can1 321##1{}", "5A".repeat(12))
        );
        assert!(lines[5].starts_with("(1759190400.123506) can1 18DAF100##2C3C3"));
        assert_eq!(lines[6], "(1759190400.123516) can0 456#");
        assert_eq!(
            lines[7],
            "(1759190400.123526) can0 20000080#0000080000000000"
        );
    }

    #[test]
    fn helpers() {
        assert_eq!(len_to_dlc(8), 8);
        assert_eq!(len_to_dlc(9), 9);
        assert_eq!(len_to_dlc(12), 9);
        assert_eq!(len_to_dlc(33), 14);
        assert_eq!(len_to_dlc(64), 15);
        assert_eq!(plain_name("can0"), "can0");
        assert_eq!(plain_name("CAN 1,\"a\""), "CAN_1__a_");
        assert_eq!(plain_name(""), "can");
        let mut out = Vec::new();
        write_seconds(&mut out, -1_500_000_999).unwrap();
        assert_eq!(out, b"-1.500000");
    }

    #[test]
    fn bus_numbers_come_from_names_only_when_all_are_numbered_alike() {
        let numbers = |names: &[&str]| {
            let mut store = FrameStore::new();
            for name in names {
                store.channel_index(name.as_bytes());
            }
            bus_numbers(&store)
        };
        assert_eq!(numbers(&["can2", "can1"]), [2, 1]);
        assert_eq!(numbers(&["can0", "can1"]), [1, 2]);
        assert_eq!(numbers(&["can01", "can2"]), [1, 2]);
        assert_eq!(numbers(&["can1", "vcan1"]), [1, 2]);
        assert_eq!(numbers(&["can256"]), [1]);
    }
}
