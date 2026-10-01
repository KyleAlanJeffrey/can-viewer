//! ASAM MDF 4 (MF4) files with CAN bus logging.
//!
//! An MF4 file is a tree of blocks linked by absolute offsets: the header (HD) lists data
//! groups (DG), each with channel groups (CG) that describe the records of its data stream
//! (DT, or compressed DZ, or lists of them) through channels (CN). CAN frames are the
//! records of channel groups whose structure channel is `CAN_DataFrame`, `CAN_RemoteFrame`
//! or `CAN_ErrorFrame`, with members such as `ID`, `DLC`, `DataBytes` and `BusChannel`.
//! Because the links point anywhere in the file, the file is buffered whole and read when
//! it ends, and the frames of every group are sorted by time before they are delivered.

use std::borrow::Cow;

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::text::{dlc_to_len, ChannelName};
use crate::{LogParser, ParseStats};

const MAX_FILE: usize = 1 << 30;
/// A data stream assembled from a list of blocks, or inflated, may not exceed this.
const MAX_STREAM: usize = 1 << 30;
/// Longest chain of linked blocks followed, against files whose links loop.
const MAX_CHAIN: usize = 1 << 20;
const MAX_COMPOSITION_DEPTH: usize = 4;
const BLOCK_HEADER: usize = 24;

const VLSD_GROUP: u16 = 0x1;

const DATA_FRAME: &str = "can_dataframe";
const REMOTE_FRAME: &str = "can_remoteframe";
const ERROR_FRAME: &str = "can_errorframe";

#[derive(Debug, Default)]
pub struct Mf4Parser {
    stats: ParseStats,
    file: Vec<u8>,
    too_large: bool,
}

impl Mf4Parser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl LogParser for Mf4Parser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], _sink: &mut S) {
        self.stats.bytes += chunk.len() as u64;
        if self.too_large {
            return;
        }
        if self.file.len() + chunk.len() > MAX_FILE {
            self.too_large = true;
            self.file = Vec::new();
            self.stats.lines += 1;
            self.stats.reject("MF4 file larger than 1 GiB");
            return;
        }
        self.file.extend_from_slice(chunk);
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        let file = std::mem::take(&mut self.file);
        if self.too_large {
            return;
        }
        let mut frames = Frames::default();
        if let Err(reason) = read_file(&file, &mut self.stats, &mut frames) {
            self.stats.lines += 1;
            self.stats.reject(reason);
        }
        frames.list.sort_by_key(|frame| frame.ts_ns);
        for frame in &frames.list {
            let channel = sink.channel_index(ChannelName::new(u64::from(frame.bus)).as_bytes());
            let data_at = frame.data_at as usize;
            sink.push(FrameRef {
                ts_ns: frame.ts_ns,
                channel,
                id: frame.id,
                flags: frame.flags,
                data: &frames.data[data_at..data_at + usize::from(frame.len)],
            });
        }
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
    }
}

/// Frames collected from every group, with their payloads side by side, until they are
/// sorted.
#[derive(Default)]
struct Frames {
    list: Vec<Pending>,
    data: Vec<u8>,
}

struct Pending {
    ts_ns: i64,
    bus: u32,
    id: u32,
    flags: u8,
    len: u8,
    data_at: u32,
}

impl Frames {
    fn push(&mut self, ts_ns: i64, bus: u32, id: u32, flags: u8, data: &[u8]) {
        let data_at = self.data.len() as u32;
        self.data.extend_from_slice(data);
        self.list.push(Pending {
            ts_ns,
            bus,
            id,
            flags,
            len: data.len() as u8,
            data_at,
        });
    }
}

struct Block<'a> {
    id: [u8; 4],
    links: &'a [u8],
    data: &'a [u8],
}

impl<'a> Block<'a> {
    fn at(file: &'a [u8], at: u64) -> Option<Self> {
        let at = usize::try_from(at).ok()?;
        let header = file.get(at..at + BLOCK_HEADER)?;
        if &header[..2] != b"##" {
            return None;
        }
        let length = usize::try_from(u64_at(header, 8)).ok()?;
        let links_len = usize::try_from(u64_at(header, 16)).ok()?.checked_mul(8)?;
        let body = file.get(at + BLOCK_HEADER..at.checked_add(length)?)?;
        if body.len() < links_len {
            return None;
        }
        Some(Block {
            id: header[..4].try_into().ok()?,
            links: &body[..links_len],
            data: &body[links_len..],
        })
    }

    fn typed(file: &'a [u8], at: u64, id: &[u8; 4]) -> Option<Self> {
        Self::at(file, at).filter(|block| &block.id == id)
    }

    fn link(&self, index: usize) -> u64 {
        self.links
            .get(index * 8..index * 8 + 8)
            .map_or(0, |bytes| u64_at(bytes, 0))
    }
}

fn read_file(file: &[u8], stats: &mut ParseStats, frames: &mut Frames) -> Result<(), &'static str> {
    if file.len() < 64 || !file.starts_with(b"MDF     ") {
        return Err("not an MF4 file (no MDF signature)");
    }
    if file[8] != b'4' {
        return Err("MDF file version is not 4.x");
    }
    let header = Block::typed(file, 64, b"##HD").ok_or("MF4 header block missing")?;
    let start_ns = header
        .data
        .get(..8)
        .and_then(|bytes| i64::try_from(u64_at(bytes, 0)).ok())
        .ok_or("start time out of range")?;
    let mut found_bus_group = false;
    let mut dg_at = header.link(0);
    for _ in 0..MAX_CHAIN {
        if dg_at == 0 {
            break;
        }
        let group = Block::typed(file, dg_at, b"##DG").ok_or("bad data group block")?;
        match read_data_group(file, &group, start_ns, stats, frames) {
            Ok(has_bus_group) => found_bus_group |= has_bus_group,
            Err(reason) => {
                stats.lines += 1;
                stats.reject(reason);
            }
        }
        dg_at = group.link(0);
    }
    if !found_bus_group {
        return Err("no CAN frame channel groups in the file");
    }
    Ok(())
}

/// A channel group's record layout and, for CAN frame groups, where the fields are.
struct Group<'a> {
    block_at: u64,
    record_id: u64,
    record_len: usize,
    vlsd: bool,
    bus: Option<BusGroup<'a>>,
}

struct BusGroup<'a> {
    kind: FrameKind,
    time: Time,
    bus_channel: Option<Field>,
    id: Option<Field>,
    ide: Option<Field>,
    dlc: Option<Field>,
    data_length: Option<Field>,
    data_bytes: Option<DataBytes<'a>>,
    dir: Option<Field>,
    edl: Option<Field>,
    brs: Option<Field>,
    esi: Option<Field>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Data,
    Remote,
    Error,
}

enum Time {
    /// The record index, converted.
    Virtual { offset: f64, factor: f64 },
    Field {
        field: Field,
        offset: f64,
        factor: f64,
    },
    /// No master channel: every record gets the start time.
    None,
}

enum DataBytes<'a> {
    Fixed(Field),
    /// The field holds an offset into variable length data: a block's, or that of a VLSD
    /// channel group in the same data group, found by its block offset.
    Variable {
        field: Field,
        store: VariableStore<'a>,
    },
}

enum VariableStore<'a> {
    Block(Cow<'a, [u8]>),
    Group(u64),
}

#[derive(Clone, Copy)]
struct Field {
    byte_offset: usize,
    bit_offset: u32,
    bit_count: u32,
    data_type: u8,
}

struct Channel {
    name: String,
    cn_type: u8,
    sync_type: u8,
    field: Field,
    conversion_at: u64,
    data_at: u64,
}

fn read_data_group(
    file: &[u8],
    group: &Block<'_>,
    start_ns: i64,
    stats: &mut ParseStats,
    frames: &mut Frames,
) -> Result<bool, &'static str> {
    let record_id_size = usize::from(*group.data.first().ok_or("bad data group block")?);
    if !matches!(record_id_size, 0 | 1 | 2 | 4 | 8) {
        return Err("bad record ID size");
    }
    let mut groups = Vec::new();
    let mut cg_at = group.link(1);
    for _ in 0..MAX_CHAIN {
        if cg_at == 0 {
            break;
        }
        let block = Block::typed(file, cg_at, b"##CG").ok_or("bad channel group block")?;
        groups.push(read_channel_group(file, cg_at, &block)?);
        cg_at = block.link(0);
    }
    if !groups.iter().any(|g| g.bus.is_some()) {
        return Ok(false);
    }
    let stream = data_stream(file, group.link(2), 0)?;

    if record_id_size == 0 {
        let group = &groups[0];
        let Some(bus) = &group.bus else {
            return Ok(false);
        };
        if group.vlsd || group.record_len == 0 {
            return Ok(false);
        }
        for (index, record) in stream.chunks_exact(group.record_len).enumerate() {
            emit(bus, record, index, &[], start_ns, stats, frames);
        }
        return Ok(true);
    }

    // Variable length data lives in records of its own group, interleaved with the frames
    // that point into it, so gather it first.
    let mut variable: Vec<Vec<u8>> = groups.iter().map(|_| Vec::new()).collect();
    each_record(&stream, record_id_size, &groups, |group_index, record| {
        if groups[group_index].vlsd {
            variable[group_index].extend_from_slice(record);
        }
    });
    let variable_groups = variable_lookup(&groups, &variable);
    let mut indexes = vec![0usize; groups.len()];
    let error = each_record(&stream, record_id_size, &groups, |group_index, record| {
        let group = &groups[group_index];
        if let Some(bus) = &group.bus {
            emit(
                bus,
                record,
                indexes[group_index],
                &variable_groups,
                start_ns,
                stats,
                frames,
            );
            indexes[group_index] += 1;
        }
    });
    if let Some(reason) = error {
        stats.lines += 1;
        stats.reject(reason);
    }
    Ok(true)
}

/// The variable length data of each group, by the group's block offset.
fn variable_lookup<'v>(groups: &[Group<'_>], variable: &'v [Vec<u8>]) -> Vec<(u64, &'v [u8])> {
    groups
        .iter()
        .zip(variable)
        .filter(|(group, _)| group.vlsd)
        .map(|(group, data)| (group.block_at, data.as_slice()))
        .collect()
}

/// Walks the records of an unsorted data stream, each led by its group's record ID, and
/// returns why it stopped early, if it did.
fn each_record(
    stream: &[u8],
    record_id_size: usize,
    groups: &[Group<'_>],
    mut on_record: impl FnMut(usize, &[u8]),
) -> Option<&'static str> {
    let mut pos = 0;
    while pos < stream.len() {
        let Some(id_bytes) = stream.get(pos..pos + record_id_size) else {
            return Some("record cut short");
        };
        let mut record_id = [0u8; 8];
        record_id[..record_id_size].copy_from_slice(id_bytes);
        let record_id = u64::from_le_bytes(record_id);
        pos += record_id_size;
        let Some(group_index) = groups.iter().position(|g| g.record_id == record_id) else {
            return Some("record with an unknown channel group ID");
        };
        let group = &groups[group_index];
        let len = if group.vlsd {
            let Some(len_bytes) = stream.get(pos..pos + 4) else {
                return Some("record cut short");
            };
            4 + u32_at(len_bytes, 0) as usize
        } else {
            group.record_len
        };
        let Some(record) = stream.get(pos..pos + len) else {
            return Some("record cut short");
        };
        on_record(group_index, record);
        pos += len;
    }
    None
}

fn read_channel_group<'a>(
    file: &'a [u8],
    block_at: u64,
    block: &Block<'a>,
) -> Result<Group<'a>, &'static str> {
    if block.data.len() < 32 {
        return Err("bad channel group block");
    }
    let record_id = u64_at(block.data, 0);
    let flags = u16_at(block.data, 16);
    let record_len = u32_at(block.data, 24) as usize + u32_at(block.data, 28) as usize;
    let mut channels = Vec::new();
    read_channels(file, block.link(1), 0, &mut channels)?;
    let bus = bus_group(file, &channels)?;
    Ok(Group {
        block_at,
        record_id,
        record_len,
        vlsd: flags & VLSD_GROUP != 0,
        bus,
    })
}

/// Reads a channel chain and, through compositions, the member channels of structures.
fn read_channels(
    file: &[u8],
    first_at: u64,
    depth: usize,
    out: &mut Vec<Channel>,
) -> Result<(), &'static str> {
    let mut cn_at = first_at;
    for _ in 0..MAX_CHAIN {
        if cn_at == 0 {
            return Ok(());
        }
        let block = Block::typed(file, cn_at, b"##CN").ok_or("bad channel block")?;
        if block.data.len() < 16 {
            return Err("bad channel block");
        }
        let name = Block::typed(file, block.link(2), b"##TX")
            .map(|text| block_text(&text))
            .unwrap_or_default();
        out.push(Channel {
            name,
            cn_type: block.data[0],
            sync_type: block.data[1],
            field: Field {
                data_type: block.data[2],
                bit_offset: u32::from(block.data[3]),
                byte_offset: u32_at(block.data, 4) as usize,
                bit_count: u32_at(block.data, 8),
            },
            conversion_at: block.link(4),
            data_at: block.link(5),
        });
        let composition_at = block.link(1);
        if composition_at != 0 && depth < MAX_COMPOSITION_DEPTH {
            // A composition is either a channel chain (a structure) or an array block.
            if Block::typed(file, composition_at, b"##CN").is_some() {
                read_channels(file, composition_at, depth + 1, out)?;
            }
        }
        cn_at = block.link(0);
    }
    Err("channel chain does not end")
}

/// The text of a TX block, lower-cased, up to its terminating zero.
fn block_text(block: &Block<'_>) -> String {
    let end = block
        .data
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(block.data.len());
    String::from_utf8_lossy(&block.data[..end])
        .trim()
        .to_ascii_lowercase()
}

/// The CAN frame layout of a channel group, if one of its channels is a CAN frame structure.
fn bus_group<'a>(
    file: &'a [u8],
    channels: &[Channel],
) -> Result<Option<BusGroup<'a>>, &'static str> {
    let kinds = [
        (DATA_FRAME, FrameKind::Data),
        (REMOTE_FRAME, FrameKind::Remote),
        (ERROR_FRAME, FrameKind::Error),
    ];
    let Some((prefix, kind)) = kinds.into_iter().find(|(prefix, _)| {
        channels
            .iter()
            .any(|c| c.name == *prefix || c.name.starts_with(&format!("{prefix}.")))
    }) else {
        return Ok(None);
    };
    let member = |name: &str| -> Option<&Channel> {
        let full = format!("{prefix}.{name}");
        channels
            .iter()
            .find(|c| c.name == full)
            .or_else(|| channels.iter().find(|c| member_name(&c.name) == name))
    };
    let field = |name: &str| member(name).map(|c| c.field);

    let data_bytes = match member("databytes") {
        None => None,
        Some(channel) if channel.cn_type == 1 => {
            let store = if Block::typed(file, channel.data_at, b"##CG").is_some() {
                VariableStore::Group(channel.data_at)
            } else {
                VariableStore::Block(data_stream(file, channel.data_at, 0)?)
            };
            Some(DataBytes::Variable {
                field: channel.field,
                store,
            })
        }
        Some(channel) => Some(DataBytes::Fixed(channel.field)),
    };

    let master = channels
        .iter()
        .find(|c| matches!(c.cn_type, 2 | 3) && c.sync_type == 1)
        .or_else(|| channels.iter().find(|c| matches!(c.cn_type, 2 | 3)));
    let time = match master {
        None => Time::None,
        Some(channel) => {
            let (offset, factor) = linear_conversion(file, channel.conversion_at);
            if channel.cn_type == 3 {
                Time::Virtual { offset, factor }
            } else {
                Time::Field {
                    field: channel.field,
                    offset,
                    factor,
                }
            }
        }
    };

    Ok(Some(BusGroup {
        kind,
        time,
        bus_channel: field("buschannel"),
        id: field("id"),
        ide: field("ide"),
        dlc: field("dlc"),
        data_length: field("datalength"),
        data_bytes,
        dir: field("dir"),
        edl: field("edl").or_else(|| field("fdf")),
        brs: field("brs"),
        esi: field("esi"),
    }))
}

/// The last dotted part of a channel name: `CAN_DataFrame.ID` is the member `id`.
fn member_name(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

/// The offset and factor of a channel's conversion: a linear CC block's, or the identity
/// for no conversion and for the kinds a time channel does not use.
fn linear_conversion(file: &[u8], at: u64) -> (f64, f64) {
    match Block::typed(file, at, b"##CC") {
        Some(block) if block.data.len() >= 40 && block.data[0] == 1 => {
            (f64_at(block.data, 24), f64_at(block.data, 32))
        }
        _ => (0.0, 1.0),
    }
}

fn emit(
    bus: &BusGroup<'_>,
    record: &[u8],
    index: usize,
    variable_groups: &[(u64, &[u8])],
    start_ns: i64,
    stats: &mut ParseStats,
    frames: &mut Frames,
) {
    stats.lines += 1;
    match frame_of(bus, record, index, variable_groups, start_ns) {
        Ok((ts_ns, channel, id, frame_flags, data)) => {
            stats.frames += 1;
            frames.push(ts_ns, channel, id, frame_flags, data);
        }
        Err(reason) => stats.reject(reason),
    }
}

fn frame_of<'r>(
    bus: &'r BusGroup<'_>,
    record: &'r [u8],
    index: usize,
    variable_groups: &[(u64, &'r [u8])],
    start_ns: i64,
) -> Result<(i64, u32, u32, u8, &'r [u8]), &'static str> {
    let seconds = match &bus.time {
        Time::None => 0.0,
        Time::Virtual { offset, factor } => offset + factor * index as f64,
        Time::Field {
            field,
            offset,
            factor,
        } => offset + factor * field_f64(record, field).ok_or("bad time value")?,
    };
    let offset_ns = seconds * 1e9;
    if !offset_ns.is_finite() || offset_ns.abs() > 9e18 {
        return Err("time out of range");
    }
    let ts_ns = start_ns
        .checked_add(offset_ns.round() as i64)
        .ok_or("time out of range")?;

    let flag = |field: &Option<Field>| -> Result<bool, &'static str> {
        match field {
            Some(field) => Ok(field_u64(record, field).ok_or("bad flag value")? != 0),
            None => Ok(false),
        }
    };
    let number = |field: &Option<Field>| -> Result<Option<u64>, &'static str> {
        match field {
            Some(field) => field_u64(record, field).map(Some).ok_or("bad value"),
            None => Ok(None),
        }
    };
    let channel = number(&bus.bus_channel)?.map_or(1, |bus| u32::try_from(bus).unwrap_or(u32::MAX));
    let raw_id = number(&bus.id)?.unwrap_or(0);
    let extended = flag(&bus.ide)? || raw_id & 0x8000_0000 != 0 || raw_id & 0x1FFF_FFFF > 0x7FF;
    let mut frame_flags = 0;
    if flag(&bus.dir)? {
        frame_flags |= flags::TX;
    }
    if flag(&bus.edl)? {
        frame_flags |= flags::FD;
    }
    if flag(&bus.brs)? {
        frame_flags |= flags::FD | flags::BRS;
    }
    if flag(&bus.esi)? {
        frame_flags |= flags::FD | flags::ESI;
    }
    let dlc = number(&bus.dlc)?;
    let data_length = number(&bus.data_length)?;

    let data: &[u8] = match (&bus.kind, &bus.data_bytes) {
        (FrameKind::Remote, _) | (_, None) => &[],
        (_, Some(DataBytes::Fixed(field))) => field_bytes(record, field).ok_or("bad data bytes")?,
        (_, Some(DataBytes::Variable { field, store })) => {
            // The record holds a little-endian offset whatever the value's data type.
            let offset_field = Field {
                data_type: 0,
                ..*field
            };
            let offset = field_bits(record, &offset_field).ok_or("bad data offset")?;
            let store: &[u8] = match store {
                VariableStore::Block(block) => block,
                VariableStore::Group(at) => variable_groups
                    .iter()
                    .find(|(group_at, _)| group_at == at)
                    .map(|(_, data)| *data)
                    .ok_or("data bytes refer to a missing group")?,
            };
            variable_value(store, offset).ok_or("data offset outside the data")?
        }
    };
    let len = match (data_length, dlc) {
        (Some(length), _) => length as usize,
        (None, Some(dlc)) if frame_flags & flags::FD != 0 => dlc_to_len(dlc.min(15) as u8),
        (None, Some(dlc)) => dlc.min(8) as usize,
        (None, None) => data.len(),
    }
    .min(data.len())
    .min(MAX_PAYLOAD);
    if len > 8 {
        frame_flags |= flags::FD;
    }
    let id = match bus.kind {
        FrameKind::Error => {
            frame_flags |= flags::ERROR;
            ERR_FLAG
        }
        FrameKind::Remote => {
            frame_flags |= flags::RTR;
            can_id(raw_id, extended)
        }
        FrameKind::Data => can_id(raw_id, extended),
    };
    Ok((ts_ns, channel, id, frame_flags, &data[..len]))
}

fn can_id(raw: u64, extended: bool) -> u32 {
    let id = (raw as u32) & 0x1FFF_FFFF;
    if extended {
        id | EXT_FLAG
    } else {
        id
    }
}

/// A length-prefixed value in variable length data.
fn variable_value(store: &[u8], offset: u64) -> Option<&[u8]> {
    let at = usize::try_from(offset).ok()?;
    let len = u32_at(store.get(at..at + 4)?, 0) as usize;
    store.get(at + 4..at + 4 + len)
}

/// The bits of a field as an unsigned integer, in the record's byte order for the type.
fn field_bits(record: &[u8], field: &Field) -> Option<u64> {
    if field.bit_count == 0 || field.bit_count > 64 {
        return None;
    }
    let byte_count = (field.bit_offset + field.bit_count).div_ceil(8) as usize;
    if byte_count > 8 {
        return None;
    }
    let bytes = record.get(field.byte_offset..field.byte_offset + byte_count)?;
    let mut buffer = [0u8; 8];
    let big_endian = matches!(field.data_type, 1 | 3 | 5);
    let value = if big_endian {
        buffer[8 - byte_count..].copy_from_slice(bytes);
        u64::from_be_bytes(buffer)
    } else {
        buffer[..byte_count].copy_from_slice(bytes);
        u64::from_le_bytes(buffer)
    };
    let value = value >> field.bit_offset;
    Some(if field.bit_count == 64 {
        value
    } else {
        value & ((1u64 << field.bit_count) - 1)
    })
}

/// An integer field, or a float rounded, as long as it is not negative.
fn field_u64(record: &[u8], field: &Field) -> Option<u64> {
    match field.data_type {
        0 | 1 => field_bits(record, field),
        2 | 3 => {
            let value = field_signed(record, field)?;
            u64::try_from(value).ok()
        }
        4 | 5 => {
            let value = field_float(record, field)?;
            (0.0..1.8e19).contains(&value).then(|| value.round() as u64)
        }
        _ => None,
    }
}

fn field_f64(record: &[u8], field: &Field) -> Option<f64> {
    match field.data_type {
        0 | 1 => field_bits(record, field).map(|v| v as f64),
        2 | 3 => field_signed(record, field).map(|v| v as f64),
        4 | 5 => field_float(record, field),
        _ => None,
    }
}

fn field_signed(record: &[u8], field: &Field) -> Option<i64> {
    let bits = field_bits(record, field)?;
    let shift = 64 - field.bit_count;
    Some(((bits << shift) as i64) >> shift)
}

fn field_float(record: &[u8], field: &Field) -> Option<f64> {
    let bits = field_bits(record, field)?;
    match field.bit_count {
        32 => Some(f64::from(f32::from_bits(bits as u32))),
        64 => Some(f64::from_bits(bits)),
        _ => None,
    }
}

/// A byte array field.
fn field_bytes<'r>(record: &'r [u8], field: &Field) -> Option<&'r [u8]> {
    let len = (field.bit_count / 8) as usize;
    record.get(field.byte_offset..field.byte_offset + len)
}

/// The bytes a data link leads to: one block, or the blocks of a list joined, inflated
/// where compressed.
fn data_stream(file: &[u8], at: u64, depth: usize) -> Result<Cow<'_, [u8]>, &'static str> {
    if at == 0 {
        return Ok(Cow::Borrowed(&[]));
    }
    if depth > 2 {
        return Err("data block lists nest too deep");
    }
    let block = Block::at(file, at).ok_or("bad data block")?;
    match &block.id {
        b"##DT" | b"##DV" | b"##SD" | b"##RD" => Ok(Cow::Borrowed(block.data)),
        b"##DZ" => inflate(&block).map(Cow::Owned),
        b"##HL" => data_stream(file, block.link(0), depth + 1),
        b"##DL" => {
            let mut out = Vec::new();
            let mut list_at = at;
            for _ in 0..MAX_CHAIN {
                if list_at == 0 {
                    break;
                }
                let list = Block::typed(file, list_at, b"##DL").ok_or("bad data list block")?;
                let count = list
                    .data
                    .get(4..8)
                    .map(|bytes| u32_at(bytes, 0) as usize)
                    .ok_or("bad data list block")?;
                for index in 0..count {
                    let part = data_stream(file, list.link(1 + index), depth + 1)?;
                    if out.len() + part.len() > MAX_STREAM {
                        return Err("data larger than 1 GiB");
                    }
                    out.extend_from_slice(&part);
                }
                list_at = list.link(0);
            }
            Ok(Cow::Owned(out))
        }
        _ => Err("unknown data block type"),
    }
}

/// A DZ block's content: zlib-inflated, and transposed back when the writer transposed it
/// so that same-column bytes of consecutive records compressed better.
fn inflate(block: &Block<'_>) -> Result<Vec<u8>, &'static str> {
    if block.data.len() < 24 {
        return Err("bad compressed data block");
    }
    let zip_type = block.data[2];
    let columns = u32_at(block.data, 4) as usize;
    let original_len =
        usize::try_from(u64_at(block.data, 8)).map_err(|_| "compressed data too large")?;
    let compressed_len =
        usize::try_from(u64_at(block.data, 16)).map_err(|_| "bad compressed data block")?;
    if original_len > MAX_STREAM {
        return Err("compressed data larger than 1 GiB");
    }
    let compressed = block
        .data
        .get(24..24 + compressed_len)
        .ok_or("bad compressed data block")?;
    let data = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(compressed, original_len)
        .map_err(|_| "compressed data does not inflate")?;
    if data.len() != original_len {
        return Err("compressed data has the wrong length");
    }
    match zip_type {
        0 => Ok(data),
        1 => Ok(untranspose(&data, columns)),
        _ => Err("unknown data compression"),
    }
}

fn untranspose(data: &[u8], columns: usize) -> Vec<u8> {
    if columns == 0 || columns >= data.len() {
        return data.to_vec();
    }
    let rows = data.len() / columns;
    let mut out = vec![0u8; data.len()];
    for column in 0..columns {
        for row in 0..rows {
            out[row * columns + column] = data[column * rows + row];
        }
    }
    out[rows * columns..].copy_from_slice(&data[rows * columns..]);
    out
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("eight bytes"))
}

fn f64_at(bytes: &[u8], at: usize) -> f64 {
    f64::from_bits(u64_at(bytes, at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    /// Builds a file block by block; links to blocks not yet written are patched later.
    struct Builder {
        bytes: Vec<u8>,
    }

    const UNSIGNED: u8 = 0;
    const UNSIGNED_BE: u8 = 1;
    const FLOAT: u8 = 4;
    const BYTES: u8 = 10;

    /// How a channel is laid out in a record, with its name and type.
    struct Member {
        name: &'static str,
        cn_type: u8,
        data_type: u8,
        byte_offset: u32,
        bit_count: u32,
        conversion: u64,
        data: u64,
    }

    fn member(name: &'static str, data_type: u8, byte_offset: u32, bit_count: u32) -> Member {
        Member {
            name,
            cn_type: 0,
            data_type,
            byte_offset,
            bit_count,
            conversion: 0,
            data: 0,
        }
    }

    impl Builder {
        fn new() -> Self {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(b"MDF     4.10    FreeCAN ");
            bytes.extend_from_slice(&[0; 4]);
            bytes.extend_from_slice(&0u16.to_le_bytes());
            bytes.extend_from_slice(&0u16.to_le_bytes());
            bytes.extend_from_slice(&410u16.to_le_bytes());
            bytes.resize(64, 0);
            Builder { bytes }
        }

        fn block(&mut self, id: &[u8; 4], links: &[u64], data: &[u8]) -> u64 {
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

        fn set_link(&mut self, block_at: u64, index: usize, target: u64) {
            let at = block_at as usize + 24 + index * 8;
            self.bytes[at..at + 8].copy_from_slice(&target.to_le_bytes());
        }

        fn text(&mut self, text: &str) -> u64 {
            let mut data = text.as_bytes().to_vec();
            data.push(0);
            self.block(b"##TX", &[], &data)
        }

        fn header(&mut self, start_ns: u64) -> u64 {
            let mut data = Vec::new();
            data.extend_from_slice(&start_ns.to_le_bytes());
            data.resize(32, 0);
            self.block(b"##HD", &[0; 6], &data)
        }

        fn linear(&mut self, offset: f64, factor: f64) -> u64 {
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

        fn channel(&mut self, member: &Member, next: u64, composition: u64) -> u64 {
            let name = self.text(member.name);
            let mut data = vec![member.cn_type, 1, member.data_type, 0];
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
        fn channels(&mut self, members: &[Member], composition_of_first: u64) -> u64 {
            let mut next = 0;
            for (index, member) in members.iter().enumerate().rev() {
                let composition = if index == 0 { composition_of_first } else { 0 };
                next = self.channel(member, next, composition);
            }
            next
        }

        /// A structure channel whose members form its composition.
        fn structure(&mut self, name: &'static str, members: &[Member]) -> u64 {
            let composition = self.channels(members, 0);
            let structure = member(name, BYTES, 0, 0);
            self.channel(&structure, 0, composition)
        }

        fn channel_group(
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

        fn data_group(&mut self, record_id_size: u8, cg_first: u64, data: u64) -> u64 {
            let mut body = vec![record_id_size];
            body.resize(8, 0);
            self.block(b"##DG", &[0, cg_first, data, 0], &body)
        }

        fn data_block(&mut self, records: &[u8]) -> u64 {
            self.block(b"##DT", &[], records)
        }

        fn compressed_block(&mut self, kind: &[u8; 2], records: &[u8], columns: u32) -> u64 {
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

        fn data_list(&mut self, blocks: &[u64]) -> u64 {
            let mut links = vec![0u64];
            links.extend_from_slice(blocks);
            let mut data = vec![0u8, 0, 0, 0];
            data.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
            for index in 0..blocks.len() {
                data.extend_from_slice(&(index as u64 * 1000).to_le_bytes());
            }
            self.block(b"##DL", &links, &data)
        }

        fn variable_data(&mut self, values: &[&[u8]]) -> u64 {
            self.block(b"##SD", &[], &variable_records(values))
        }
    }

    fn transpose(data: &[u8], columns: usize) -> Vec<u8> {
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

    fn variable_records(values: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for value in values {
            out.extend_from_slice(&(value.len() as u32).to_le_bytes());
            out.extend_from_slice(value);
        }
        out
    }

    fn master(name: &'static str, data_type: u8, byte_offset: u32, bit_count: u32) -> Member {
        Member {
            cn_type: 2,
            ..member(name, data_type, byte_offset, bit_count)
        }
    }

    /// A data frame record: t (f64 s), bus u8, id u32, ide u8, dlc u8, length u8,
    /// data offset u64, dir u8, edl u8, brs u8, esi u8.
    fn data_record(
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

    const DATA_RECORD_LEN: u32 = 28;

    fn data_frame_members(data_bytes_at: u64) -> Vec<Member> {
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

    fn parse(input: &[u8]) -> (VecSink, ParseStats) {
        parse_chunked(Mf4Parser::new(), input, usize::MAX)
    }

    #[test]
    fn sorted_data_group_with_variable_length_data_in_an_sd_block() {
        let mut b = Builder::new();
        let hd = b.header(1_000_000_000_000);
        let values: [&[u8]; 3] = [&[1, 2, 3], &[0; 12], &[]];
        let sd = b.variable_data(&values);
        let records = [
            data_record(0.5, 1, 0x123, false, (3, 3), 0, [false; 4]),
            data_record(
                0.75,
                2,
                0x18FE_F100,
                true,
                (9, 12),
                7,
                [true, true, true, false],
            ),
            data_record(1.0, 1, 0x7FF, false, (0, 0), 23, [false; 4]),
        ]
        .concat();
        let dt = b.data_block(&records);
        let structure = b.structure("CAN_DataFrame", &data_frame_members(sd));
        let time = b.channel(&master("t", FLOAT, 0, 64), structure, 0);
        let cg = b.channel_group(0, 0, DATA_RECORD_LEN, time, 0);
        let dg = b.data_group(0, cg, dt);
        b.set_link(hd, 0, dg);

        let (sink, stats) = assert_chunking_does_not_matter(Mf4Parser::new, &b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!((stats.lines, stats.frames), (3, 3));
        assert_eq!(sink.channels, [b"can1".to_vec(), b"can2".to_vec()]);
        assert_eq!(
            sink.frames,
            [
                (1_000_500_000_000, 0, 0x123, 0, vec![1, 2, 3]),
                (
                    1_000_750_000_000,
                    1,
                    0x18FE_F100 | EXT_FLAG,
                    flags::TX | flags::FD | flags::BRS,
                    vec![0; 12]
                ),
                (1_001_000_000_000, 0, 0x7FF, 0, vec![]),
            ]
        );
    }

    #[test]
    fn unsorted_data_group_with_record_ids_lists_and_compression() {
        // Data frames with a fixed 8-byte array, remote frames with a virtual master, and
        // error frames whose bytes come from a VLSD channel group, all in one data group.
        let mut b = Builder::new();
        let hd = b.header(0);
        let ms = b.linear(0.0, 0.001);
        let data_members = vec![
            member("ID", UNSIGNED_BE, 4, 32),
            member("DLC", UNSIGNED, 8, 8),
            member("DataBytes", BYTES, 9, 64),
            member("Dir", UNSIGNED, 17, 8),
        ];
        let data_structure = b.structure("CAN_DataFrame", &data_members);
        let data_time = b.channel(
            &Member {
                conversion: ms,
                ..master("t", UNSIGNED, 0, 32)
            },
            data_structure,
            0,
        );
        let remote_members = vec![
            member("CAN_RemoteFrame.ID", UNSIGNED, 0, 16),
            member("CAN_RemoteFrame.DLC", UNSIGNED, 2, 8),
        ];
        let remote_structure = b.structure("CAN_RemoteFrame", &remote_members);
        let remote_time = b.channel(
            &Member {
                cn_type: 3,
                conversion: ms,
                ..member("t", UNSIGNED, 0, 0)
            },
            remote_structure,
            0,
        );
        let vlsd_cg = b.channel_group(9, VLSD_GROUP, 0, 0, 0);
        let error_members = vec![
            Member {
                cn_type: 1,
                data: vlsd_cg,
                ..member("CAN_ErrorFrame.DataBytes", BYTES, 4, 64)
            },
            member("CAN_ErrorFrame.DataLength", UNSIGNED, 12, 8),
        ];
        let error_structure = b.structure("CAN_ErrorFrame", &error_members);
        let error_time = b.channel(&master("t", FLOAT, 0, 32), error_structure, 0);
        let error_cg = b.channel_group(3, 0, 13, error_time, vlsd_cg);
        let remote_cg = b.channel_group(2, 0, 3, remote_time, error_cg);
        let data_cg = b.channel_group(1, 0, 18, data_time, remote_cg);

        let mut records = Vec::new();
        // t = 5 ms, ID 0x100 big-endian, 8 bytes, Tx.
        records.push(1);
        records.extend_from_slice(&5u32.to_le_bytes());
        records.extend_from_slice(&0x100u32.to_be_bytes());
        records.push(8);
        records.extend_from_slice(&[9, 8, 7, 6, 5, 4, 3, 2]);
        records.push(1);
        // Remote frame 0x7FF, DLC 4, at index 0 so t = 0.
        records.push(2);
        records.extend_from_slice(&0x7FFu16.to_le_bytes());
        records.push(4);
        // VLSD record of 2 bytes, then the error frame that points at offset 0.
        records.push(9);
        records.extend_from_slice(&variable_records(&[&[0xDE, 0xAD]]));
        records.push(3);
        records.extend_from_slice(&0.002f32.to_le_bytes());
        records.extend_from_slice(&0u64.to_le_bytes());
        records.push(2);
        // A second remote frame, index 1 so t = 1 ms.
        records.push(2);
        records.extend_from_slice(&0x200u16.to_le_bytes());
        records.push(0);
        let (first, second) = records.split_at(20);
        let dz = b.compressed_block(b"DT", first, 7);
        let dt = b.data_block(second);
        let dl = b.data_list(&[dz, dt]);
        let hl = b.block(b"##HL", &[dl], &[0; 8]);
        let dg = b.data_group(1, data_cg, hl);
        b.set_link(hd, 0, dg);

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 4);
        assert_eq!(
            sink.frames,
            [
                (0, 0, 0x7FF, flags::RTR, vec![]),
                (1_000_000, 0, 0x200, flags::RTR, vec![]),
                (2_000_000, 0, ERR_FLAG, flags::ERROR, vec![0xDE, 0xAD]),
                (5_000_000, 0, 0x100, flags::TX, vec![9, 8, 7, 6, 5, 4, 3, 2]),
            ]
        );
    }

    #[test]
    fn groups_without_frames_are_skipped_and_files_without_any_rejected() {
        let mut b = Builder::new();
        let hd = b.header(0);
        let dt = b.data_block(&[0; 16]);
        let speed = b.channels(
            &[
                master("t", FLOAT, 0, 64),
                member("EngineSpeed", UNSIGNED, 8, 16),
            ],
            0,
        );
        let cg = b.channel_group(0, 0, 10, speed, 0);
        let dg = b.data_group(0, cg, dt);
        b.set_link(hd, 0, dg);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(
            stats.first_rejection,
            Some((1, "no CAN frame channel groups in the file"))
        );

        let (_, stats) = parse(b"(1.0) can0 123#00\n");
        assert_eq!(
            stats.first_rejection,
            Some((1, "not an MF4 file (no MDF signature)"))
        );
        let mut old = Builder::new().bytes;
        old[8] = b'3';
        let (_, stats) = parse(&old);
        assert_eq!(
            stats.first_rejection,
            Some((1, "MDF file version is not 4.x"))
        );
        let (_, stats) = parse(&Builder::new().bytes);
        assert_eq!(stats.first_rejection, Some((1, "MF4 header block missing")));
    }

    #[test]
    fn bad_records_and_blocks_are_rejected_with_reasons() {
        let mut b = Builder::new();
        let hd = b.header(0);
        let sd = b.variable_data(&[&[1]]);
        let records = [
            data_record(1.0, 1, 0x123, false, (1, 1), 0, [false; 4]),
            data_record(2.0, 1, 0x123, false, (1, 1), 500, [false; 4]),
            data_record(f64::INFINITY, 1, 0x123, false, (1, 1), 0, [false; 4]),
        ]
        .concat();
        let dt = b.data_block(&records);
        let structure = b.structure("CAN_DataFrame", &data_frame_members(sd));
        let time = b.channel(&master("t", FLOAT, 0, 64), structure, 0);
        let cg = b.channel_group(0, 0, DATA_RECORD_LEN, time, 0);
        let dg = b.data_group(0, cg, dt);
        let broken_cg = b.channel_group(0, 0, DATA_RECORD_LEN, time, 0);
        let broken_dg = b.data_group(0, broken_cg, 12);
        b.set_link(dg, 0, broken_dg);
        b.set_link(hd, 0, dg);

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(sink.frames.len(), 1);
        assert_eq!(stats.rejected, 3);
        assert_eq!(
            stats.first_rejection,
            Some((2, "data offset outside the data"))
        );
    }

    #[test]
    fn untransposing_restores_the_records() {
        let records: Vec<u8> = (0..23).collect();
        assert_eq!(untranspose(&transpose(&records, 5), 5), records);
        assert_eq!(untranspose(&transpose(&records, 23), 23), records);
        assert_eq!(untranspose(&records, 0), records);
    }
}
