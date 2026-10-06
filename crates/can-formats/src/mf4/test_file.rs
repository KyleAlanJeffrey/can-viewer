//! Building MF4 files for tests, here and in the crates that read logs in parts.

use super::{UNFINALIZED, VLSD_GROUP};

/// `cg_flags` of a channel group of variable-length values.
pub const VLSD_FLAGS: u16 = VLSD_GROUP;

/// Builds a file block by block; links to blocks not yet written are patched later.
pub struct Builder {
    pub bytes: Vec<u8>,
}

pub const UNSIGNED: u8 = 0;
pub const UNSIGNED_BE: u8 = 1;
pub const FLOAT: u8 = 4;
pub const BYTES: u8 = 10;

/// How a channel is laid out in a record, with its name and type.
pub struct Member {
    pub name: &'static str,
    pub cn_type: u8,
    pub data_type: u8,
    pub byte_offset: u32,
    /// Bits to skip in the first byte.
    pub bit_offset: u8,
    pub bit_count: u32,
    pub conversion: u64,
    pub data: u64,
}

pub fn member(name: &'static str, data_type: u8, byte_offset: u32, bit_count: u32) -> Member {
    Member {
        name,
        cn_type: 0,
        data_type,
        byte_offset,
        bit_offset: 0,
        bit_count,
        conversion: 0,
        data: 0,
    }
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"MDF     4.10    FreeCAN ");
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&410u16.to_le_bytes());
        bytes.resize(64, 0);
        Builder { bytes }
    }

    pub fn block(&mut self, id: &[u8; 4], links: &[u64], data: &[u8]) -> u64 {
        while !self.bytes.len().is_multiple_of(8) {
            self.bytes.push(0);
        }
        let at = self.bytes.len() as u64;
        self.bytes.extend_from_slice(id);
        self.bytes.extend_from_slice(&[0; 4]);
        let length = 24 + links.len() * 8 + data.len();
        self.bytes.extend_from_slice(&(length as u64).to_le_bytes());
        self.bytes
            .extend_from_slice(&(links.len() as u64).to_le_bytes());
        for link in links {
            self.bytes.extend_from_slice(&link.to_le_bytes());
        }
        self.bytes.extend_from_slice(data);
        at
    }

    pub fn set_link(&mut self, block_at: u64, index: usize, target: u64) {
        let at = block_at as usize + 24 + index * 8;
        self.bytes[at..at + 8].copy_from_slice(&target.to_le_bytes());
    }

    pub fn link(&self, block_at: u64, index: usize) -> u64 {
        let at = block_at as usize + 24 + index * 8;
        u64::from_le_bytes(self.bytes[at..at + 8].try_into().unwrap())
    }

    pub fn text(&mut self, text: &str) -> u64 {
        let mut data = text.as_bytes().to_vec();
        data.push(0);
        self.block(b"##TX", &[], &data)
    }

    pub fn header(&mut self, start_ns: u64) -> u64 {
        let mut data = Vec::new();
        data.extend_from_slice(&start_ns.to_le_bytes());
        data.resize(32, 0);
        self.block(b"##HD", &[0; 6], &data)
    }

    pub fn linear(&mut self, offset: f64, factor: f64) -> u64 {
        let mut data = vec![1u8, 0];
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&0f64.to_le_bytes());
        data.extend_from_slice(&0f64.to_le_bytes());
        data.extend_from_slice(&offset.to_le_bytes());
        data.extend_from_slice(&factor.to_le_bytes());
        self.block(b"##CC", &[0; 4], &data)
    }

    pub fn channel(&mut self, member: &Member, next: u64, composition: u64) -> u64 {
        let name = self.text(member.name);
        let mut data = vec![member.cn_type, 1, member.data_type, member.bit_offset];
        data.extend_from_slice(&member.byte_offset.to_le_bytes());
        data.extend_from_slice(&member.bit_count.to_le_bytes());
        data.resize(72, 0);
        self.block(
            b"##CN",
            &[
                next,
                composition,
                name,
                0,
                member.conversion,
                member.data,
                0,
                0,
            ],
            &data,
        )
    }

    /// A chain of channels, the first returned.
    pub fn channels(&mut self, members: &[Member], composition_of_first: u64) -> u64 {
        let mut next = 0;
        for (index, member) in members.iter().enumerate().rev() {
            let composition = if index == 0 { composition_of_first } else { 0 };
            next = self.channel(member, next, composition);
        }
        next
    }

    /// A structure channel whose members form its composition.
    pub fn structure(&mut self, name: &'static str, members: &[Member]) -> u64 {
        let composition = self.channels(members, 0);
        let structure = member(name, BYTES, 0, 0);
        self.channel(&structure, 0, composition)
    }

    pub fn channel_group(
        &mut self,
        record_id: u64,
        flags: u16,
        record_len: u32,
        cn_first: u64,
        next: u64,
    ) -> u64 {
        let mut data = Vec::new();
        data.extend_from_slice(&record_id.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&flags.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&record_len.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        self.block(b"##CG", &[next, cn_first, 0, 0, 0, 0], &data)
    }

    pub fn data_group(&mut self, record_id_size: u8, cg_first: u64, data: u64) -> u64 {
        let mut body = vec![record_id_size];
        body.resize(8, 0);
        self.block(b"##DG", &[0, cg_first, data, 0], &body)
    }

    pub fn data_block(&mut self, records: &[u8]) -> u64 {
        self.block(b"##DT", &[], records)
    }

    pub fn compressed_block(&mut self, kind: &[u8; 2], records: &[u8], columns: u32) -> u64 {
        let transposed = transpose(records, columns as usize);
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&transposed, 6);
        let mut data = kind.to_vec();
        data.push(if columns == 0 { 0 } else { 1 });
        data.push(0);
        data.extend_from_slice(&columns.to_le_bytes());
        data.extend_from_slice(&(records.len() as u64).to_le_bytes());
        data.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        data.extend_from_slice(&compressed);
        self.block(b"##DZ", &[], &data)
    }

    pub fn data_list(&mut self, blocks: &[u64]) -> u64 {
        let mut links = vec![0u64];
        links.extend_from_slice(blocks);
        let mut data = vec![0u8, 0, 0, 0];
        data.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
        for index in 0..blocks.len() {
            data.extend_from_slice(&(index as u64 * 1000).to_le_bytes());
        }
        self.block(b"##DL", &links, &data)
    }

    pub fn variable_data(&mut self, values: &[&[u8]]) -> u64 {
        self.block(b"##SD", &[], &variable_records(values))
    }
}

pub fn transpose(data: &[u8], columns: usize) -> Vec<u8> {
    if columns == 0 || columns >= data.len() {
        return data.to_vec();
    }
    let rows = data.len() / columns;
    let mut out = vec![0u8; data.len()];
    for row in 0..rows {
        for column in 0..columns {
            out[column * rows + row] = data[row * columns + column];
        }
    }
    out[rows * columns..].copy_from_slice(&data[rows * columns..]);
    out
}

pub fn variable_records(values: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for value in values {
        out.extend_from_slice(&(value.len() as u32).to_le_bytes());
        out.extend_from_slice(value);
    }
    out
}

pub fn master(name: &'static str, data_type: u8, byte_offset: u32, bit_count: u32) -> Member {
    Member {
        cn_type: 2,
        ..member(name, data_type, byte_offset, bit_count)
    }
}

/// A data frame record: t (f64 s), bus u8, id u32, ide u8, dlc u8, length u8,
/// data offset u64, dir u8, edl u8, brs u8, esi u8.
pub fn data_record(
    t: f64,
    bus: u8,
    id: u32,
    ide: bool,
    (dlc, length): (u8, u8),
    data_offset: u64,
    flags: [bool; 4],
) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&t.to_le_bytes());
    record.push(bus);
    record.extend_from_slice(&id.to_le_bytes());
    record.push(u8::from(ide));
    record.push(dlc);
    record.push(length);
    record.extend_from_slice(&data_offset.to_le_bytes());
    record.extend(flags.iter().map(|&f| u8::from(f)));
    record
}

pub const DATA_RECORD_LEN: u32 = 28;

pub fn data_frame_members(data_bytes_at: u64) -> Vec<Member> {
    vec![
        member("CAN_DataFrame.BusChannel", UNSIGNED, 8, 8),
        member("CAN_DataFrame.ID", UNSIGNED, 9, 32),
        member("CAN_DataFrame.IDE", UNSIGNED, 13, 8),
        member("CAN_DataFrame.DLC", UNSIGNED, 14, 8),
        member("CAN_DataFrame.DataLength", UNSIGNED, 15, 8),
        Member {
            cn_type: 1,
            data: data_bytes_at,
            ..member("CAN_DataFrame.DataBytes", BYTES, 16, 64)
        },
        member("CAN_DataFrame.Dir", UNSIGNED, 24, 8),
        member("CAN_DataFrame.EDL", UNSIGNED, 25, 8),
        member("CAN_DataFrame.BRS", UNSIGNED, 26, 8),
        member("CAN_DataFrame.ESI", UNSIGNED, 27, 8),
    ]
}

pub fn unfinalize(b: &mut Builder, flags: u16, custom_flags: u16) {
    b.bytes[..8].copy_from_slice(UNFINALIZED);
    b.bytes[60..62].copy_from_slice(&flags.to_le_bytes());
    b.bytes[62..64].copy_from_slice(&custom_flags.to_le_bytes());
}

pub fn set_length(b: &mut Builder, block_at: u64, length: u64) {
    let at = block_at as usize + 8;
    b.bytes[at..at + 8].copy_from_slice(&length.to_le_bytes());
}

pub fn set_count(b: &mut Builder, list_at: u64, links: usize, count: u32) {
    let at = list_at as usize + 24 + links * 8 + 4;
    b.bytes[at..at + 4].copy_from_slice(&count.to_le_bytes());
}
