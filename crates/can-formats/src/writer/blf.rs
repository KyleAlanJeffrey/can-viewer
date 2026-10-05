//! Vector BLF.

use std::io::{self, Seek, SeekFrom, Write};

use can_core::{flags, FrameRef, FrameStore, EXT_FLAG};

use super::{bus_numbers, civil_from_days, is_fd, len_to_dlc, log_frames, start_ns};

/// Objects with version 1 headers and nanosecond timestamps from the second of the first
/// frame, packed into zlib log containers of about 128 KiB. Classic frames go in CAN_MESSAGE
/// objects, CAN FD frames in CAN_FD_MESSAGE_64 and error frames in CAN_ERROR_EXT. The file
/// header is written again at the end with the sizes and object count.
pub(super) fn write_blf<W: Write + Seek>(store: &FrameStore, out: &mut W) -> io::Result<()> {
    const CONTAINER_BYTES: usize = 128 << 10;
    let start_s = start_ns(store).div_euclid(1_000_000_000);
    let end_s = log_frames(store)
        .map(|f| f.ts_ns)
        .max()
        .unwrap_or(0)
        .div_euclid(1_000_000_000);
    let channels = bus_numbers(store);
    let header_at = out.stream_position()?;
    out.write_all(&blf_file_header(start_s, end_s, 0, 0, 0))?;
    let mut objects = Vec::with_capacity(CONTAINER_BYTES + 256);
    let mut uncompressed_bytes = 0u64;
    let mut object_count = 0u32;
    for frame in log_frames(store) {
        let timestamp = (frame.ts_ns - start_s * 1_000_000_000) as u64;
        frame_object(
            &mut objects,
            &frame,
            channels[usize::from(frame.channel)],
            timestamp,
        );
        object_count = object_count.saturating_add(1);
        if objects.len() >= CONTAINER_BYTES {
            uncompressed_bytes += objects.len() as u64;
            write_container(out, &objects)?;
            objects.clear();
        }
    }
    if !objects.is_empty() {
        uncompressed_bytes += objects.len() as u64;
        write_container(out, &objects)?;
    }
    let end_at = out.stream_position()?;
    out.seek(SeekFrom::Start(header_at))?;
    out.write_all(&blf_file_header(
        start_s,
        end_s,
        end_at - header_at,
        uncompressed_bytes,
        object_count,
    ))?;
    out.seek(SeekFrom::Start(end_at)).map(|_| ())
}

fn blf_file_header(
    start_s: i64,
    end_s: i64,
    file_bytes: u64,
    uncompressed_bytes: u64,
    object_count: u32,
) -> [u8; 144] {
    let mut header = [0u8; 144];
    header[..4].copy_from_slice(b"LOGG");
    header[4..8].copy_from_slice(&144u32.to_le_bytes());
    header[12] = 2;
    header[16..24].copy_from_slice(&file_bytes.to_le_bytes());
    header[24..32].copy_from_slice(&uncompressed_bytes.to_le_bytes());
    header[32..36].copy_from_slice(&object_count.to_le_bytes());
    header[40..56].copy_from_slice(&system_time(start_s));
    header[56..72].copy_from_slice(&system_time(end_s));
    header
}

/// A Windows SYSTEMTIME, in UTC, for a Unix time in seconds.
fn system_time(epoch_s: i64) -> [u8; 16] {
    let days = epoch_s.div_euclid(86_400);
    let seconds = epoch_s.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let fields = [
        year as u16,
        month as u16,
        (days + 4).rem_euclid(7) as u16,
        day as u16,
        (seconds / 3600) as u16,
        (seconds % 3600 / 60) as u16,
        (seconds % 60) as u16,
        0,
    ];
    let mut out = [0u8; 16];
    for (i, field) in fields.iter().enumerate() {
        out[i * 2..i * 2 + 2].copy_from_slice(&field.to_le_bytes());
    }
    out
}

fn frame_object(out: &mut Vec<u8>, frame: &FrameRef<'_>, channel: u8, timestamp: u64) {
    const CAN_MESSAGE: u32 = 1;
    const CAN_ERROR_EXT: u32 = 73;
    const CAN_FD_MESSAGE_64: u32 = 101;
    const NANOSECONDS: u32 = 2;

    let id = if frame.id & EXT_FLAG != 0 {
        (frame.id & !EXT_FLAG) | 0x8000_0000
    } else {
        frame.id
    };
    let transmitted = frame.flags & flags::TX != 0;
    let mut body = Vec::with_capacity(104);
    let kind = if frame.flags & flags::ERROR != 0 {
        body.extend_from_slice(&u16::from(channel).to_le_bytes());
        body.extend_from_slice(&[0; 8]);
        body.push(frame.data.len().min(8) as u8);
        body.extend_from_slice(&[0; 13]);
        body.extend_from_slice(&frame.data[..frame.data.len().min(8)]);
        body.resize(32, 0);
        CAN_ERROR_EXT
    } else if is_fd(frame) {
        let mut fd_flags = 0x1000u32;
        if frame.flags & flags::BRS != 0 {
            fd_flags |= 0x2000;
        }
        if frame.flags & flags::ESI != 0 {
            fd_flags |= 0x4000;
        }
        body.push(channel);
        body.push(len_to_dlc(frame.data.len()));
        body.push(frame.data.len() as u8);
        body.push(0);
        body.extend_from_slice(&id.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&fd_flags.to_le_bytes());
        body.extend_from_slice(&[0; 18]);
        body.push(u8::from(transmitted));
        body.push(0);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(frame.data);
        CAN_FD_MESSAGE_64
    } else {
        let mut message_flags = 0u8;
        if transmitted {
            message_flags |= 0x01;
        }
        if frame.flags & flags::RTR != 0 {
            message_flags |= 0x80;
        }
        body.extend_from_slice(&u16::from(channel).to_le_bytes());
        body.push(message_flags);
        body.push(frame.data.len() as u8);
        body.extend_from_slice(&id.to_le_bytes());
        body.extend_from_slice(frame.data);
        body.resize(16, 0);
        CAN_MESSAGE
    };
    let object_size = (32 + body.len()) as u32;
    out.extend_from_slice(b"LOBJ");
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&object_size.to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&NANOSECONDS.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&timestamp.to_le_bytes());
    out.extend_from_slice(&body);
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
}

fn write_container(out: &mut impl Write, objects: &[u8]) -> io::Result<()> {
    const LOG_CONTAINER: u32 = 10;
    const ZLIB: u16 = 2;
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(objects, 6);
    let object_size = (32 + compressed.len()) as u32;
    out.write_all(b"LOBJ")?;
    out.write_all(&16u16.to_le_bytes())?;
    out.write_all(&1u16.to_le_bytes())?;
    out.write_all(&object_size.to_le_bytes())?;
    out.write_all(&LOG_CONTAINER.to_le_bytes())?;
    out.write_all(&ZLIB.to_le_bytes())?;
    out.write_all(&[0; 6])?;
    out.write_all(&(objects.len() as u32).to_le_bytes())?;
    out.write_all(&[0; 4])?;
    out.write_all(&compressed)?;
    let padding = (4 - object_size as usize % 4) % 4;
    out.write_all(&[0; 3][..padding])
}
