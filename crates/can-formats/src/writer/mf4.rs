//! ASAM MF4 bus logging.

use std::io::{self, Seek, SeekFrom, Write};

use can_core::{flags, FrameRef, FrameStore, EXT_FLAG};

use super::{bus_numbers, is_fd, len_to_dlc, log_frames, start_ns};

/// Bytes per record: t f64, BusChannel u8, ID u32 (bit 31 for 29-bit IDs), DLC u8, DataLength
/// u8, DataBytes [u8; 64], Dir u8, EDL u8, BRS u8, ESI u8.
const RECORD: usize = 83;
/// Records per DZ block, about 1 MB before compression.
const BLOCK_RECORDS: usize = 12_000;

/// One sorted data group each for data, remote and error frames, whose records hold a float64
/// time in seconds from the first frame's second and the `CAN_DataFrame` members with a fixed
/// 64-byte `DataBytes`. The records are written as transposed, deflated DZ blocks in a DL
/// list, a block at a time, and the header's links are filled in last. The channel groups are
/// marked as plain CAN bus events with one shared bus source, as ASAM's bus logging standard
/// asks, and an empty log gets an empty data frame group.
pub(super) fn write_mf4<W: Write + Seek>(store: &FrameStore, out: &mut W) -> io::Result<()> {
    const BUS_EVENT: u16 = 0x02;
    const PLAIN_BUS_EVENT: u16 = 0x04;
    let start_s = start_ns(store).div_euclid(1_000_000_000);
    let mut file = Mf4Out {
        base: out.stream_position()?,
        at: 0,
        out,
    };
    file.write(b"MDF     4.10    FreeCAN ")?;
    file.write(&[0; 4])?;
    file.write(&410u16.to_le_bytes())?;
    file.write(&[0; 34])?;
    let start_time = (start_s * 1_000_000_000) as u64;
    let mut header = Vec::new();
    header.extend_from_slice(&start_time.to_le_bytes());
    header.resize(32, 0);
    let header_at = file.block(b"##HD", &[0; 6], &header)?;
    let history = file.history(start_time)?;
    file.set_link(header_at, 1, history)?;

    let can = file.text("CAN")?;
    let source = file.bus_source(can)?;
    let buses = bus_numbers(store);
    let kinds = [
        ("CAN_DataFrame", flags::RTR | flags::ERROR, 0),
        ("CAN_RemoteFrame", flags::RTR | flags::ERROR, flags::RTR),
        ("CAN_ErrorFrame", flags::ERROR, flags::ERROR),
    ];
    let mut next_group = 0;
    for (name, mask, wanted) in kinds.into_iter().rev() {
        let frames = log_frames(store).filter(|frame| frame.flags & mask == wanted);
        let (data, records) = match file.records(frames, &buses, start_s)? {
            Some(found) => found,
            None if name == "CAN_DataFrame" && next_group == 0 => (0, 0),
            None => continue,
        };
        let channels = file.can_frame_channels(name)?;
        let mut group = Vec::new();
        group.extend_from_slice(&0u64.to_le_bytes());
        group.extend_from_slice(&records.to_le_bytes());
        group.extend_from_slice(&(BUS_EVENT | PLAIN_BUS_EVENT).to_le_bytes());
        group.extend_from_slice(&u16::from(b'.').to_le_bytes());
        group.extend_from_slice(&[0; 4]);
        group.extend_from_slice(&(RECORD as u32).to_le_bytes());
        group.extend_from_slice(&0u32.to_le_bytes());
        let channel_group = file.block(b"##CG", &[0, channels, can, source, 0, 0], &group)?;
        next_group = file.block(b"##DG", &[next_group, channel_group, data, 0], &[0; 8])?;
    }
    file.set_link(header_at, 0, next_group)
}

fn record(out: &mut Vec<u8>, frame: &FrameRef<'_>, bus: u8, start_s: i64) {
    let seconds = (frame.ts_ns - start_s * 1_000_000_000) as f64 / 1e9;
    let id = if frame.flags & flags::ERROR != 0 {
        0
    } else if frame.id & EXT_FLAG != 0 {
        (frame.id & !EXT_FLAG) | 0x8000_0000
    } else {
        frame.id
    };
    let len = frame.data.len().min(64);
    let bit = |flag: u8| u8::from(frame.flags & flag != 0);
    out.extend_from_slice(&seconds.to_le_bytes());
    out.push(bus);
    out.extend_from_slice(&id.to_le_bytes());
    out.push(len_to_dlc(len));
    out.push(len as u8);
    let mut data = [0u8; 64];
    data[..len].copy_from_slice(&frame.data[..len]);
    out.extend_from_slice(&data);
    out.extend_from_slice(&[
        bit(flags::TX),
        u8::from(is_fd(frame)),
        bit(flags::BRS),
        bit(flags::ESI),
    ]);
}

/// Writes blocks one after another, keeping their offsets from the start of the file.
struct Mf4Out<'a, W> {
    out: &'a mut W,
    /// Where the file starts in `out`.
    base: u64,
    /// Bytes written so far.
    at: u64,
}

impl<W: Write + Seek> Mf4Out<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.out.write_all(bytes)?;
        self.at += bytes.len() as u64;
        Ok(())
    }

    fn block(&mut self, id: &[u8; 4], links: &[u64], data: &[u8]) -> io::Result<u64> {
        let padding = (8 - self.at % 8) % 8;
        self.write(&[0; 8][..padding as usize])?;
        let at = self.at;
        let length = 24 + links.len() * 8 + data.len();
        self.write(id)?;
        self.write(&[0; 4])?;
        self.write(&(length as u64).to_le_bytes())?;
        self.write(&(links.len() as u64).to_le_bytes())?;
        for link in links {
            self.write(&link.to_le_bytes())?;
        }
        self.write(data)?;
        Ok(at)
    }

    fn set_link(&mut self, block_at: u64, index: usize, target: u64) -> io::Result<()> {
        let link_at = self.base + block_at + 24 + index as u64 * 8;
        self.out.seek(SeekFrom::Start(link_at))?;
        self.out.write_all(&target.to_le_bytes())?;
        self.out
            .seek(SeekFrom::Start(self.base + self.at))
            .map(|_| ())
    }

    fn text(&mut self, text: &str) -> io::Result<u64> {
        let mut data = text.as_bytes().to_vec();
        data.push(0);
        self.block(b"##TX", &[], &data)
    }

    /// An SI block for a CAN bus named by the TX block at `name`.
    fn bus_source(&mut self, name: u64) -> io::Result<u64> {
        const BUS: u8 = 2;
        const CAN: u8 = 2;
        self.block(b"##SI", &[name, 0, 0], &[BUS, CAN, 0, 0, 0, 0, 0, 0])
    }

    /// The file history block that MDF 4 requires, naming this program as the writer.
    fn history(&mut self, time_ns: u64) -> io::Result<u64> {
        let comment = format!(
            "<FHcomment xmlns=\"http://www.asam.net/mdf/v4\"><TX>Exported by FreeCAN Studio.</TX>\
             <tool_id>FreeCAN Studio</tool_id><tool_vendor>FreeCAN Studio</tool_vendor>\
             <tool_version>{}</tool_version></FHcomment>\0",
            env!("CARGO_PKG_VERSION")
        );
        let comment = self.block(b"##MD", &[], comment.as_bytes())?;
        let mut data = time_ns.to_le_bytes().to_vec();
        data.resize(16, 0);
        self.block(b"##FH", &[0, comment], &data)
    }

    /// A CN block. `kind` is (channel type, sync type, data type), `place` is (byte
    /// offset, bit count) and `links` is (next channel, composition).
    fn channel(
        &mut self,
        name: &str,
        kind: (u8, u8, u8),
        place: (u32, u32),
        links: (u64, u64),
        flags: u32,
    ) -> io::Result<u64> {
        let (cn_type, sync_type, data_type) = kind;
        let (byte_offset, bit_count) = place;
        let (next, composition) = links;
        let name = self.text(name)?;
        let mut data = vec![cn_type, sync_type, data_type, 0];
        data.extend_from_slice(&byte_offset.to_le_bytes());
        data.extend_from_slice(&bit_count.to_le_bytes());
        data.extend_from_slice(&flags.to_le_bytes());
        data.resize(72, 0);
        self.block(b"##CN", &[next, composition, name, 0, 0, 0, 0, 0], &data)
    }

    /// The time master channel, then a structure channel named `structure` whose members
    /// describe the rest of the record.
    fn can_frame_channels(&mut self, structure: &str) -> io::Result<u64> {
        const BUS_EVENT: u32 = 0x400;
        const UNSIGNED: u8 = 0;
        const FLOAT: u8 = 4;
        const BYTES: u8 = 10;
        let members: [(&str, u8, u32, u32); 9] = [
            ("BusChannel", UNSIGNED, 8, 8),
            ("ID", UNSIGNED, 9, 32),
            ("DLC", UNSIGNED, 13, 8),
            ("DataLength", UNSIGNED, 14, 8),
            ("DataBytes", BYTES, 15, 512),
            ("Dir", UNSIGNED, 79, 8),
            ("EDL", UNSIGNED, 80, 8),
            ("BRS", UNSIGNED, 81, 8),
            ("ESI", UNSIGNED, 82, 8),
        ];
        let mut next = 0;
        for (member, data_type, byte_offset, bit_count) in members.into_iter().rev() {
            let name = format!("{structure}.{member}");
            next = self.channel(
                &name,
                (0, 0, data_type),
                (byte_offset, bit_count),
                (next, 0),
                0,
            )?;
        }
        let structure = self.channel(structure, (0, 0, BYTES), (8, 600), (0, next), BUS_EVENT)?;
        self.channel("t", (2, 1, FLOAT), (0, 64), (structure, 0), 0)
    }

    /// Writes the records of `frames` in DZ blocks and a DL block listing them. Returns the DL
    /// block's offset and the record count, or None when there are no frames.
    fn records<'s>(
        &mut self,
        frames: impl Iterator<Item = FrameRef<'s>>,
        buses: &[u8],
        start_s: i64,
    ) -> io::Result<Option<(u64, u64)>> {
        let mut records = Vec::with_capacity(BLOCK_RECORDS * RECORD);
        let mut blocks = Vec::new();
        let mut count = 0u64;
        for frame in frames {
            record(
                &mut records,
                &frame,
                buses[usize::from(frame.channel)],
                start_s,
            );
            count += 1;
            if records.len() == BLOCK_RECORDS * RECORD {
                blocks.push(self.data_block(&records)?);
                records.clear();
            }
        }
        if !records.is_empty() {
            blocks.push(self.data_block(&records)?);
        }
        if blocks.is_empty() {
            return Ok(None);
        }
        let mut links = vec![0u64];
        links.extend_from_slice(&blocks);
        let mut data = vec![0u8; 4];
        data.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
        for index in 0..blocks.len() {
            let offset = (index * BLOCK_RECORDS * RECORD) as u64;
            data.extend_from_slice(&offset.to_le_bytes());
        }
        Ok(Some((self.block(b"##DL", &links, &data)?, count)))
    }

    fn data_block(&mut self, records: &[u8]) -> io::Result<u64> {
        let transposed = transpose(records, RECORD);
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&transposed, 6);
        let mut data = b"DT".to_vec();
        data.push(1);
        data.push(0);
        data.extend_from_slice(&(RECORD as u32).to_le_bytes());
        data.extend_from_slice(&(records.len() as u64).to_le_bytes());
        data.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        data.extend_from_slice(&compressed);
        self.block(b"##DZ", &[], &data)
    }
}

/// The bytes of `columns`-byte rows regrouped column by column, as a transposing DZ block
/// stores them.
fn transpose(data: &[u8], columns: usize) -> Vec<u8> {
    let rows = data.len() / columns;
    let mut out = data.to_vec();
    for row in 0..rows {
        for column in 0..columns {
            out[column * rows + row] = data[row * columns + column];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use can_core::FrameSink;

    use super::*;

    fn u64_at(file: &[u8], at: u64) -> u64 {
        let at = at as usize;
        u64::from_le_bytes(file[at..at + 8].try_into().unwrap())
    }

    /// The offset of link `index` of the block at `at`, checking the block's ID.
    fn link(file: &[u8], at: u64, id: &[u8; 4], index: u64) -> u64 {
        assert_eq!(&file[at as usize..at as usize + 4], id);
        u64_at(file, at + 24 + 8 * index)
    }

    #[test]
    fn groups_are_plain_can_bus_events_from_one_source_with_a_file_history() {
        let mut store = FrameStore::new();
        let channel = store.channel_index(b"can1");
        for (frame_flags, data) in [(flags::RTR, &[][..]), (0, &[1, 2][..])] {
            store.push(FrameRef {
                ts_ns: 1_759_190_400_000_000_000,
                channel,
                id: 0x100,
                flags: frame_flags,
                data,
            });
        }
        let mut out = Cursor::new(Vec::new());
        write_mf4(&store, &mut out).unwrap();
        let file = out.into_inner();

        let history = link(&file, 64, b"##HD", 1);
        let comment = link(&file, history, b"##FH", 1);
        let xml =
            &file[comment as usize + 24..u64_at(&file, comment + 8) as usize + comment as usize];
        let xml = std::str::from_utf8(xml).unwrap();
        assert!(xml.starts_with("<FHcomment xmlns=\"http://www.asam.net/mdf/v4\"><TX>"));
        assert!(xml.ends_with("</FHcomment>\0"), "{xml}");

        // The data frame group, then the remote frame group.
        let mut sources = Vec::new();
        let mut group = link(&file, 64, b"##HD", 0);
        let mut groups = 0;
        while group != 0 {
            let channel_group = link(&file, group, b"##DG", 1);
            let data = &file[channel_group as usize + 24 + 6 * 8..];
            assert_eq!(&data[16..20], &[0x06, 0, b'.', 0]);
            let source = link(&file, channel_group, b"##CG", 3);
            assert_eq!(&file[source as usize + 48..source as usize + 50], &[2, 2]);
            let name = link(&file, source, b"##SI", 0);
            assert_eq!(link(&file, channel_group, b"##CG", 2), name);
            assert_eq!(&file[name as usize + 24..name as usize + 28], b"CAN\0");
            sources.push(source);
            groups += 1;
            group = link(&file, group, b"##DG", 0);
        }
        assert_eq!(groups, 2);
        assert_eq!(sources[0], sources[1]);
    }
}
