//! The text formats: candump, Vector ASC, PEAK TRC and CSV.

use std::io::{self, Write};

use can_core::{flags, FrameRef, FrameStore, EXT_FLAG};

use crate::text::dlc_to_len;
use crate::LocalTime;

use super::{
    bus_numbers, civil_from_days, is_fd, len_to_dlc, log_frames, plain_name, start_ns,
    write_hex_bytes, write_seconds,
};

/// candump log lines (`candump -l`), as the candump parser and can-utils' `canplayer` read
/// them: Unix seconds with microseconds and the bus name. When any frame was transmitted,
/// every frame ends in ` T` or ` R`, as `candump -x` marks them.
pub(super) fn write_candump(store: &FrameStore, out: &mut impl Write) -> io::Result<()> {
    const CANFD_BRS: u8 = 0x1;
    const CANFD_ESI: u8 = 0x2;
    let names: Vec<_> = store.channels().iter().map(|n| plain_name(n)).collect();
    let marks_direction = log_frames(store).any(|frame| frame.flags & flags::TX != 0);
    let mut line = Vec::with_capacity(256);
    for frame in log_frames(store) {
        line.clear();
        line.push(b'(');
        write_seconds(&mut line, frame.ts_ns)?;
        write!(line, ") {} ", names[usize::from(frame.channel)])?;
        // Error frames keep the error flag in their 29-bit ID, as candump writes them.
        if frame.id & EXT_FLAG != 0 || frame.flags & flags::ERROR != 0 {
            write!(line, "{:08X}", frame.id & !EXT_FLAG)?;
        } else {
            write!(line, "{:03X}", frame.id)?;
        }
        if is_fd(&frame) {
            let mut fd_flags = 0;
            if frame.flags & flags::BRS != 0 {
                fd_flags |= CANFD_BRS;
            }
            if frame.flags & flags::ESI != 0 {
                fd_flags |= CANFD_ESI;
            }
            write!(line, "##{fd_flags:X}")?;
            write_packed_hex(&mut line, frame.data)?;
        } else if frame.flags & flags::RTR != 0 {
            line.extend_from_slice(b"#R");
        } else {
            line.push(b'#');
            write_packed_hex(&mut line, frame.data)?;
        }
        if marks_direction {
            let direction: &[u8] = if frame.flags & flags::TX != 0 {
                b" T"
            } else {
                b" R"
            };
            line.extend_from_slice(direction);
        }
        line.push(b'\n');
        out.write_all(&line)?;
    }
    Ok(())
}

/// Vector ASC, base hex with absolute timestamps from the second of the first frame, which
/// the `date` line gives in local time, as CANoe writes it and CANoe and python-can read it.
pub(super) fn write_asc(
    store: &FrameStore,
    local_time: LocalTime,
    out: &mut impl Write,
) -> io::Result<()> {
    let start_s = start_ns(store)?.div_euclid(1_000_000_000);
    let channels = bus_numbers(store)?;
    let date = asc_date(local_time.to_local(start_s));
    writeln!(out, "date {date}")?;
    writeln!(out, "base hex  timestamps absolute")?;
    writeln!(out, "internal events logged")?;
    writeln!(out, "Begin Triggerblock {date}")?;
    writeln!(out, "   0.000000 Start of measurement")?;
    for frame in log_frames(store) {
        let offset_ns = frame.ts_ns - start_s * 1_000_000_000;
        let channel = channels[usize::from(frame.channel)];
        write!(
            out,
            "{:4}.{:06} ",
            offset_ns / 1_000_000_000,
            offset_ns % 1_000_000_000 / 1000
        )?;
        let direction = if frame.flags & flags::TX != 0 {
            "Tx"
        } else {
            "Rx"
        };
        if frame.flags & flags::ERROR != 0 {
            writeln!(out, "{channel}  ErrorFrame")?;
        } else if is_fd(&frame) {
            let brs = u32::from(frame.flags & flags::BRS != 0);
            let esi = u32::from(frame.flags & flags::ESI != 0);
            let fd_flags = 0x1000 | brs << 13 | esi << 14;
            write!(
                out,
                "CANFD {channel:3} {direction:<4} {:>8}  {brs} {esi} {:x} {:>2}",
                asc_id(&frame),
                len_to_dlc(frame.data.len()),
                frame.data.len()
            )?;
            write_hex_bytes(out, frame.data)?;
            writeln!(out, " 0 0 {fd_flags:X} 0 0 0 0 0")?;
        } else if frame.flags & flags::RTR != 0 {
            writeln!(out, "{channel}  {:<15} {direction:<4} r", asc_id(&frame))?;
        } else {
            write!(
                out,
                "{channel}  {:<15} {direction:<4} d {}",
                asc_id(&frame),
                frame.data.len()
            )?;
            write_hex_bytes(out, frame.data)?;
            writeln!(out)?;
        }
    }
    writeln!(out, "End TriggerBlock")
}

/// PEAK TRC 2.1 with a bus column, offsets in milliseconds from the UTC midnight before the
/// first frame so that `$STARTTIME` is a whole number of days. The length column is a DLC, so
/// a CAN FD frame whose length no DLC gives is padded with zeros to the next one that does.
pub(super) fn write_trc(store: &FrameStore, out: &mut impl Write) -> io::Result<()> {
    const NS_PER_DAY: i64 = 86_400 * 1_000_000_000;
    let start_day = start_ns(store)?.div_euclid(NS_PER_DAY);
    let buses = bus_numbers(store)?;
    writeln!(out, ";$FILEVERSION=2.1")?;
    writeln!(out, ";$STARTTIME={}", start_day + 25_569)?;
    writeln!(out, ";$COLUMNS=N,O,T,B,I,d,R,L,D")?;
    writeln!(out, ";")?;
    writeln!(out, ";   Generated by FreeCAN Studio")?;
    writeln!(
        out,
        ";---+-- ------+------ +- +- --+----- +- +- +--- +- -- -- -- -- -- -- --"
    )?;
    for (number, frame) in log_frames(store).enumerate() {
        let offset_ns = frame.ts_ns - start_day * NS_PER_DAY;
        let direction = if frame.flags & flags::TX != 0 {
            "Tx"
        } else {
            "Rx"
        };
        let fd = is_fd(&frame);
        let dlc = len_to_dlc(frame.data.len());
        let kind = match frame.flags & (flags::BRS | flags::ESI | flags::RTR | flags::ERROR) {
            f if f & flags::ERROR != 0 => "ER",
            f if f & flags::RTR != 0 && !fd => "RR",
            _ if !fd => "DT",
            f if f & (flags::BRS | flags::ESI) == flags::BRS | flags::ESI => "BI",
            f if f & flags::BRS != 0 => "FB",
            f if f & flags::ESI != 0 => "FE",
            _ => "FD",
        };
        let id = if frame.flags & flags::ERROR != 0 {
            "-".to_owned()
        } else if frame.id & EXT_FLAG != 0 {
            format!("{:08X}", frame.id & !EXT_FLAG)
        } else {
            format!("{:04X}", frame.id)
        };
        write!(
            out,
            "{:7} {:9}.{:03} {kind} {:>2} {id:>8} {direction} -  {:<4}",
            number + 1,
            offset_ns / 1_000_000,
            offset_ns % 1_000_000 / 1000,
            buses[usize::from(frame.channel)],
            dlc
        )?;
        write_hex_bytes(out, frame.data)?;
        for _ in frame.data.len()..dlc_to_len(dlc) {
            write!(out, " 00")?;
        }
        writeln!(out)?;
    }
    Ok(())
}

/// CSV with a column for everything a frame holds (bus, flags, direction), Unix seconds and
/// hex data, so that every frame of a log survives the trip. It is for spreadsheets and this
/// app: python-can's CSVReader expects its own columns with base64 data and cannot read it.
pub(super) fn write_csv(store: &FrameStore, out: &mut impl Write) -> io::Result<()> {
    let names: Vec<_> = store.channels().iter().map(|n| plain_name(n)).collect();
    writeln!(
        out,
        "timestamp,channel,arbitration_id,extended,remote,error,fd,brs,esi,dlc,dir,data"
    )?;
    for frame in log_frames(store) {
        let bit = |flag: u8| u8::from(frame.flags & flag != 0);
        write_seconds(out, frame.ts_ns)?;
        write!(
            out,
            ",{},0x{:x},{},{},{},{},{},{},{},{},",
            names[usize::from(frame.channel)],
            frame.id & !EXT_FLAG,
            u8::from(frame.id & EXT_FLAG != 0),
            bit(flags::RTR),
            bit(flags::ERROR),
            bit(flags::FD),
            bit(flags::BRS),
            bit(flags::ESI),
            frame.data.len(),
            if frame.flags & flags::TX != 0 {
                "Tx"
            } else {
                "Rx"
            }
        )?;
        for byte in frame.data {
            write!(out, "{byte:02x}")?;
        }
        writeln!(out)?;
    }
    Ok(())
}

fn write_packed_hex(out: &mut impl Write, data: &[u8]) -> io::Result<()> {
    for byte in data {
        write!(out, "{byte:02X}")?;
    }
    Ok(())
}

fn asc_id(frame: &FrameRef<'_>) -> String {
    if frame.id & EXT_FLAG != 0 {
        format!("{:X}x", frame.id & !EXT_FLAG)
    } else {
        format!("{:X}", frame.id)
    }
}

/// `Tue Sep 30 00:00:00.000 2025` for a time in seconds since 1970-01-01 00:00.
fn asc_date(epoch_s: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = epoch_s.div_euclid(86_400);
    let seconds = epoch_s.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{} {} {day} {:02}:{:02}:{:02}.000 {year}",
        DAYS[(days + 4).rem_euclid(7) as usize],
        MONTHS[month as usize - 1],
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asc_dates() {
        assert_eq!(asc_date(0), "Thu Jan 1 00:00:00.000 1970");
        assert_eq!(asc_date(1_759_190_400), "Tue Sep 30 00:00:00.000 2025");
        assert_eq!(asc_date(951_782_400 + 3661), "Tue Feb 29 01:01:01.000 2000");
    }
}
