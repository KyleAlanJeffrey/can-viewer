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
    out.resize(out.len() + padding(object_size), 0);
}

/// The zero bytes after an object: its size mod 4, as CANoe and binlog write them, rather
/// than what would align the next object.
fn padding(object_size: u32) -> usize {
    object_size as usize % 4
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
    out.write_all(&[0; 3][..padding(object_size)])
}

#[cfg(test)]
mod tests {
    use can_core::FrameSink;

    use super::*;

    const T0: i64 = 1_759_190_400_000_000_000;

    /// The objects in `bytes` from `at`, checking that each is followed by its size mod 4 in
    /// zero bytes. Returns each object's type and padding.
    fn walk(bytes: &[u8], mut at: usize) -> Vec<(u32, usize)> {
        let mut objects = Vec::new();
        while at < bytes.len() {
            assert_eq!(&bytes[at..at + 4], b"LOBJ", "object at {at}");
            let size = u32::from_le_bytes(bytes[at + 8..at + 12].try_into().unwrap());
            let kind = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().unwrap());
            let end = at + size as usize;
            let pad = size as usize % 4;
            assert!(bytes[end..end + pad].iter().all(|&b| b == 0));
            objects.push((kind, pad));
            at = end + pad;
        }
        assert_eq!(at, bytes.len());
        objects
    }

    #[test]
    fn objects_are_padded_by_their_size_mod_4() {
        let mut container_pads = Vec::new();
        for extra in 0..16u8 {
            let mut store = FrameStore::new();
            let channel = store.channel_index(b"can1");
            // CAN FD lengths a DLC does not give make objects of 81, 82 and 83 bytes.
            for (i, len) in [9, 10, 11, 8].into_iter().enumerate() {
                let data: Vec<u8> = (0..len as u8).map(|b| b.wrapping_mul(extra)).collect();
                store.push(FrameRef {
                    ts_ns: T0 + i as i64,
                    channel,
                    id: 0x100 + u32::from(extra),
                    flags: flags::FD,
                    data: &data,
                });
            }
            let mut out = io::Cursor::new(Vec::new());
            write_blf(&store, &mut out).unwrap();
            let file = out.into_inner();
            let containers = walk(&file, 144);
            assert_eq!(containers.len(), 1);
            container_pads.push(containers[0].1);

            let objects = miniz_oxide::inflate::decompress_to_vec_zlib(&file[144 + 32..]).unwrap();
            let pads: Vec<usize> = walk(&objects, 0).iter().map(|&(_, pad)| pad).collect();
            assert_eq!(pads, [1, 2, 3, 0]);
        }
        // Sizes of 1 and 3 mod 4 tell this padding from what would align the next object.
        assert!(
            container_pads.iter().any(|&pad| pad % 2 == 1),
            "{container_pads:?}"
        );
    }
}
