//! ASAM MDF 4 (MF4) files with CAN bus logging.
//!
//! An MF4 file is a tree of blocks linked by absolute offsets: the header (HD) lists data
//! groups (DG), each with channel groups (CG) that describe the records of its data stream
//! (DT, or compressed DZ, or lists of them) through channels (CN). CAN frames are the
//! records of channel groups whose structure channel is `CAN_DataFrame`, `CAN_RemoteFrame`
//! or `CAN_ErrorFrame`, with members such as `ID`, `DLC`, `DataBytes` and `BusChannel`.
//! Because the links point anywhere in the file, the file is buffered whole and read when
//! it ends. Each data group's records are then read a data block at a time, and the frames
//! of the data groups are merged by time as they are delivered.

use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::text::{dlc_to_len, ChannelName};
use crate::{LogParser, ParseStats};

/// The largest file read; a larger one rejects a record and gives no frames.
pub const MAX_FILE: usize = 1 << 30;
/// One inflated block, or the variable length data of one channel, may not exceed this.
const MAX_STREAM: usize = 1 << 30;
const MAX_COMPOSITION_DEPTH: usize = 4;
const BLOCK_HEADER: usize = 24;
/// Data blocks may give at most this many bytes, inflated, per byte of the file. CAN logs
/// compress far less; this ends files whose data lists repeat a block over and over.
const MAX_DATA_PER_FILE_BYTE: u64 = 100;
/// A channel block takes far more bytes of the file than this, so a file whose links reach
/// more channels than its size allows repeats them.
const FILE_BYTES_PER_CHANNEL: usize = 32;
/// Channel names are compared up to this length; CAN frame member names are far shorter.
const MAX_NAME: usize = 256;
/// A CAN frame record takes at least a byte of the file even compressed (`sample-gen
/// convert` writes 11), so a file whose data gives more frames than bytes repeats them.
const FILE_BYTES_PER_FRAME: usize = 1;
/// CAN frame records are well under a hundred bytes.
const MAX_BUS_RECORD: usize = 1 << 16;
/// Channels of one channel group kept for finding the CAN frame members; CAN frame groups
/// have a few dozen.
const MAX_KEPT_CHANNELS: usize = 1 << 16;
/// Frames read ahead of their turn, shared by the data groups with several CAN frame
/// channel groups.
const REORDER_WINDOW: usize = 1 << 16;

const VLSD_GROUP: u16 = 0x1;

const FINALIZED: &[u8; 8] = b"MDF     ";
const UNFINALIZED: &[u8; 8] = b"UnFinMF ";
/// Unfinalized flags for what this reader does not use: the cycle counters of CG, CA and SR
/// blocks, and the data byte counts of VLSD channel groups.
const UNFINALIZED_UNUSED: u16 = 0x01 | 0x02 | 0x20;

const DATA_FRAME: &str = "can_dataframe";
const REMOTE_FRAME: &str = "can_remoteframe";
const ERROR_FRAME: &str = "can_errorframe";
/// The CAN frame members [`bus_group`] looks for.
const MEMBERS: [&str; 11] = [
    "buschannel",
    "id",
    "ide",
    "dlc",
    "datalength",
    "databytes",
    "dir",
    "edl",
    "fdf",
    "brs",
    "esi",
];

const LINK_REPEATS: &str = "MF4 links lead back to a block already read";
const CUT_SHORT: &str = "record cut short";

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
        if let Err(reason) = read_file(&file, &mut self.stats, sink) {
            self.stats.lines += 1;
            self.stats.reject(reason);
        }
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
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
        let header = file.get(at..at.checked_add(BLOCK_HEADER)?)?;
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

    fn link_count(&self) -> usize {
        self.links.len() / 8
    }
}

/// What reading a file may still cost, so that links which loop or fan out end with an
/// error rather than a hang.
struct Walk {
    /// Data group and channel group blocks read so far.
    seen: HashSet<u64>,
    channels_left: usize,
    data_left: u64,
    frames_left: usize,
}

impl Walk {
    fn new(file_len: usize) -> Self {
        Walk {
            seen: HashSet::new(),
            channels_left: file_len / FILE_BYTES_PER_CHANNEL,
            data_left: (file_len as u64).saturating_mul(MAX_DATA_PER_FILE_BYTE),
            frames_left: file_len / FILE_BYTES_PER_FRAME,
        }
    }

    fn visit(&mut self, at: u64) -> Result<(), &'static str> {
        if self.seen.insert(at) {
            Ok(())
        } else {
            Err(LINK_REPEATS)
        }
    }

    fn take_channel(&mut self) -> Result<(), &'static str> {
        self.channels_left = self
            .channels_left
            .checked_sub(1)
            .ok_or("more channels than the file's size allows")?;
        Ok(())
    }

    fn take_data(&mut self, len: usize) -> Result<(), &'static str> {
        self.data_left = self
            .data_left
            .checked_sub(len as u64)
            .ok_or("more data than the file's size allows")?;
        Ok(())
    }

    fn take_frame(&mut self) -> Result<(), &'static str> {
        self.frames_left = self
            .frames_left
            .checked_sub(1)
            .ok_or("more frames than the file's size allows")?;
        Ok(())
    }
}

fn read_file<S: FrameSink>(
    file: &[u8],
    stats: &mut ParseStats,
    sink: &mut S,
) -> Result<(), &'static str> {
    check_identification(file)?;
    let header = Block::typed(file, 64, b"##HD").ok_or("MF4 header block missing")?;
    let start_ns = header
        .data
        .get(..8)
        .and_then(|bytes| i64::try_from(u64_at(bytes, 0)).ok())
        .ok_or("start time out of range")?;
    let mut walk = Walk::new(file.len());
    // The variable length data pass reads the same blocks again, so it has a budget of its own.
    let mut variable_walk = Walk::new(file.len());
    let mut sources = Vec::new();
    let mut dg_at = header.link(0);
    while dg_at != 0 {
        let group = walk
            .visit(dg_at)
            .and_then(|()| Block::typed(file, dg_at, b"##DG").ok_or("bad data group block"));
        let group = match group {
            Ok(group) => group,
            Err(reason) => {
                stats.lines += 1;
                stats.reject(reason);
                break;
            }
        };
        match read_data_group(file, &group, &mut walk, &mut variable_walk) {
            Ok(Some(source)) => sources.push(source),
            Ok(None) => {}
            Err(reason) => {
                stats.lines += 1;
                stats.reject(reason);
            }
        }
        dg_at = group.link(0);
    }
    if sources.is_empty() {
        return Err("no CAN frame channel groups in the file");
    }
    share_reorder_window(&mut sources);
    merge(sources, start_ns, &mut walk, stats, sink);
    Ok(())
}

fn check_identification(file: &[u8]) -> Result<(), &'static str> {
    let finalized = file.starts_with(FINALIZED);
    if file.len() < 64 || !(finalized || file.starts_with(UNFINALIZED)) {
        return Err("not an MF4 file (no MDF signature)");
    }
    if file[8] != b'4' {
        return Err("MDF file version is not 4.x");
    }
    let unfinalized_flags = u16_at(file, 60) & !UNFINALIZED_UNUSED;
    let custom_unfinalized_flags = u16_at(file, 62);
    if !finalized && (unfinalized_flags != 0 || custom_unfinalized_flags != 0) {
        return Err("unfinalized MF4 file; finalize it with the logger's tool");
    }
    Ok(())
}

/// Splits the reorder window between the data groups that need one, since data groups may
/// all link the same data and would otherwise each hold a full window.
fn share_reorder_window(sources: &mut [Source<'_>]) {
    let reordering = sources.iter().filter(|s| s.window_len > 1).count();
    let share = (REORDER_WINDOW / reordering.max(1)).max(1);
    for source in sources.iter_mut().filter(|s| s.window_len > 1) {
        source.window_len = share;
    }
}

/// Delivers the frames of every data group, merged by time.
fn merge<S: FrameSink>(
    mut sources: Vec<Source<'_>>,
    start_ns: i64,
    walk: &mut Walk,
    stats: &mut ParseStats,
    sink: &mut S,
) {
    // Ties go to the earlier data group, as a stable sort would order them.
    let mut next = BinaryHeap::new();
    for (index, source) in sources.iter_mut().enumerate() {
        if let Some(ts_ns) = source.next_time(start_ns, walk, stats) {
            next.push(Reverse((ts_ns, index)));
        }
    }
    while let Some(Reverse((_, index))) = next.pop() {
        let source = &mut sources[index];
        if let Some(frame) = source.take() {
            let channel = sink.channel_index(ChannelName::new(u64::from(frame.bus)).as_bytes());
            sink.push(FrameRef {
                ts_ns: frame.ts_ns,
                channel,
                id: frame.id,
                flags: frame.flags,
                data: &frame.data[..usize::from(frame.len)],
            });
        }
        if let Some(ts_ns) = source.next_time(start_ns, walk, stats) {
            next.push(Reverse((ts_ns, index)));
        }
    }
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

/// The CAN frames of one data group, read a record at a time.
struct Source<'a> {
    groups: Vec<Group<'a>>,
    record_id_size: usize,
    records: BlockReader<'a>,
    /// The variable length data of the VLSD channel groups that frames point into, by the
    /// channel group's block offset.
    variable: Vec<(u64, Vec<u8>)>,
    /// Records read so far in each channel group, for virtual time channels.
    indexes: Vec<usize>,
    /// Frames read and not yet delivered, earliest first, ties in record order: their time,
    /// record number and slot in `held`.
    window: BinaryHeap<Reverse<(i64, u64, usize)>>,
    /// How many frames to read ahead before delivering the earliest. MDF has the times of a
    /// channel group never decrease, so with one CAN frame channel group that is one frame;
    /// with several, their records interleave, as loggers write them when they arrive.
    window_len: usize,
    held: Vec<Frame>,
    free: Vec<usize>,
    records_read: u64,
    ended: bool,
}

struct Frame {
    ts_ns: i64,
    bus: u32,
    id: u32,
    flags: u8,
    len: u8,
    data: [u8; MAX_PAYLOAD],
}

fn read_data_group<'a>(
    file: &'a [u8],
    group: &Block<'a>,
    walk: &mut Walk,
    variable_walk: &mut Walk,
) -> Result<Option<Source<'a>>, &'static str> {
    let record_id_size = usize::from(*group.data.first().ok_or("bad data group block")?);
    if !matches!(record_id_size, 0 | 1 | 2 | 4 | 8) {
        return Err("bad record ID size");
    }
    let mut groups = Vec::new();
    let mut cg_at = group.link(1);
    while cg_at != 0 {
        walk.visit(cg_at)?;
        let block = Block::typed(file, cg_at, b"##CG").ok_or("bad channel group block")?;
        groups.push(read_channel_group(file, cg_at, &block, walk)?);
        cg_at = block.link(0);
    }
    if !groups.iter().any(|g| g.bus.is_some()) {
        return Ok(None);
    }
    if record_id_size == 0 {
        let first = &groups[0];
        if first.bus.is_none() || first.vlsd || first.record_len == 0 {
            return Ok(None);
        }
        groups.truncate(1);
    }
    if groups
        .iter()
        .any(|g| g.bus.is_some() && g.record_len > MAX_BUS_RECORD)
    {
        return Err("CAN frame records too long");
    }
    let frame_groups = groups.iter().filter(|g| g.bus.is_some() && !g.vlsd).count();
    let blocks = data_blocks(file, group.link(2))?;
    let variable = if record_id_size == 0 {
        Vec::new()
    } else {
        variable_data(file, &blocks, record_id_size, &groups, variable_walk)
    };
    Ok(Some(Source {
        indexes: vec![0; groups.len()],
        window: BinaryHeap::new(),
        window_len: if frame_groups > 1 { REORDER_WINDOW } else { 1 },
        held: Vec::new(),
        free: Vec::new(),
        records_read: 0,
        groups,
        record_id_size,
        records: BlockReader::new(file, blocks),
        variable,
        ended: false,
    }))
}

/// The variable length data of the VLSD channel groups that CAN frames point into. It lives
/// in records of its own, interleaved with the frames, so it is gathered in a pass of its
/// own before them. Errors are left for the frames' pass to report.
fn variable_data(
    file: &[u8],
    blocks: &[u64],
    record_id_size: usize,
    groups: &[Group<'_>],
    walk: &mut Walk,
) -> Vec<(u64, Vec<u8>)> {
    let mut values: Vec<(u64, Vec<u8>)> = Vec::new();
    for group in groups {
        if let Some(BusGroup {
            data_bytes:
                Some(DataBytes::Variable {
                    store: VariableStore::Group(at),
                    ..
                }),
            ..
        }) = &group.bus
        {
            if !values.iter().any(|(known, _)| known == at) {
                values.push((*at, Vec::new()));
            }
        }
    }
    if values.is_empty() {
        return values;
    }
    let pointed_at: Vec<u64> = values.iter().map(|(at, _)| *at).collect();
    let wanted = |index: usize| groups[index].vlsd && pointed_at.contains(&groups[index].block_at);
    // A group stops gathering at its first value that does not fit, so that the offsets
    // of the values it holds stay right.
    let mut full = vec![false; values.len()];
    let mut records = BlockReader::new(file, blocks.to_vec());
    while let Ok(Some((index, value))) =
        next_record(&mut records, groups, record_id_size, walk, wanted)
    {
        let Some(slot) = values
            .iter()
            .position(|(at, _)| *at == groups[index].block_at)
        else {
            continue;
        };
        if full[slot] {
            continue;
        }
        let data = &mut values[slot].1;
        if data.len() + 4 + value.len() > MAX_STREAM {
            full[slot] = true;
            if full.iter().all(|&f| f) {
                break;
            }
            continue;
        }
        data.extend_from_slice(&(value.len() as u32).to_le_bytes());
        data.extend_from_slice(value);
    }
    values
}

impl Source<'_> {
    /// The time of the next frame to deliver, reading ahead as far as the window asks, or
    /// `None` once the data group has no more.
    fn next_time(&mut self, start_ns: i64, walk: &mut Walk, stats: &mut ParseStats) -> Option<i64> {
        while !self.ended && self.window.len() < self.window_len {
            self.read_frame(start_ns, walk, stats);
        }
        self.window.peek().map(|Reverse((ts_ns, _, _))| *ts_ns)
    }

    /// The earliest frame read ahead. Its slot is reused by the next read.
    fn take(&mut self) -> Option<&Frame> {
        let Reverse((_, _, slot)) = self.window.pop()?;
        self.free.push(slot);
        Some(&self.held[slot])
    }

    /// Reads up to the next frame record and holds its frame, or marks the end.
    fn read_frame(&mut self, start_ns: i64, walk: &mut Walk, stats: &mut ParseStats) {
        let groups = &self.groups;
        let is_frame = |index: usize| groups[index].bus.is_some() && !groups[index].vlsd;
        let next = next_record(
            &mut self.records,
            groups,
            self.record_id_size,
            walk,
            is_frame,
        );
        let (group_index, record) = match next {
            Ok(Some(found)) => found,
            Ok(None) => {
                self.ended = true;
                return;
            }
            Err(reason) => {
                stats.lines += 1;
                stats.reject(reason);
                self.ended = true;
                return;
            }
        };
        let Some(bus) = &groups[group_index].bus else {
            return;
        };
        stats.lines += 1;
        if let Err(reason) = walk.take_frame() {
            stats.reject(reason);
            self.ended = true;
            return;
        }
        let record_index = self.indexes[group_index];
        self.indexes[group_index] += 1;
        match frame_of(bus, record, record_index, &self.variable, start_ns) {
            Ok((ts_ns, bus, id, frame_flags, data)) => {
                stats.frames += 1;
                let mut frame = Frame {
                    ts_ns,
                    bus,
                    id,
                    flags: frame_flags,
                    len: data.len() as u8,
                    data: [0; MAX_PAYLOAD],
                };
                frame.data[..data.len()].copy_from_slice(data);
                let slot = match self.free.pop() {
                    Some(slot) => {
                        self.held[slot] = frame;
                        slot
                    }
                    None => {
                        self.held.push(frame);
                        self.held.len() - 1
                    }
                };
                self.window.push(Reverse((ts_ns, self.records_read, slot)));
                self.records_read += 1;
            }
            Err(reason) => stats.reject(reason),
        }
    }
}

/// The next record of a data group's stream: its channel group's index and, if `wanted`
/// picks the group, its bytes (for a VLSD record, the value without its length). Records of
/// other groups are stepped over without being copied.
fn next_record<'r>(
    records: &'r mut BlockReader<'_>,
    groups: &[Group<'_>],
    record_id_size: usize,
    walk: &mut Walk,
    wanted: impl Fn(usize) -> bool,
) -> Result<Option<(usize, &'r [u8])>, &'static str> {
    loop {
        let group_index = if record_id_size == 0 {
            0
        } else {
            let Some(id_bytes) = records.read(record_id_size, walk)? else {
                return Ok(None);
            };
            let mut record_id = [0u8; 8];
            record_id[..record_id_size].copy_from_slice(id_bytes);
            let record_id = u64::from_le_bytes(record_id);
            groups
                .iter()
                .position(|g| g.record_id == record_id)
                .ok_or("record with an unknown channel group ID")?
        };
        let group = &groups[group_index];
        let len = if group.vlsd {
            let len_bytes = records.read(4, walk)?.ok_or(CUT_SHORT)?;
            u32_at(len_bytes, 0) as usize
        } else {
            group.record_len
        };
        if !wanted(group_index) {
            records.skip(len, walk)?;
            continue;
        }
        return match records.read(len, walk)? {
            Some(record) => Ok(Some((group_index, record))),
            None if record_id_size == 0 => Ok(None),
            None => Err(CUT_SHORT),
        };
    }
}

/// The bytes of a list of data blocks as one stream, inflating one block at a time.
struct BlockReader<'a> {
    file: &'a [u8],
    blocks: std::vec::IntoIter<u64>,
    block: Cow<'a, [u8]>,
    pos: usize,
    /// A record that continues from one block into the next, put back together.
    joined: Vec<u8>,
}

impl<'a> BlockReader<'a> {
    fn new(file: &'a [u8], blocks: Vec<u64>) -> Self {
        BlockReader {
            file,
            blocks: blocks.into_iter(),
            block: Cow::Borrowed(&[]),
            pos: 0,
            joined: Vec::new(),
        }
    }

    /// Moves to the next block that is not empty, if there is one.
    fn next_block(&mut self, walk: &mut Walk) -> Result<bool, &'static str> {
        self.block = Cow::Borrowed(&[]);
        self.pos = 0;
        for at in self.blocks.by_ref() {
            let block = block_payload(self.file, at, walk)?;
            if !block.is_empty() {
                self.block = block;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The next `len` bytes, or `None` at the end of the stream.
    fn read(&mut self, len: usize, walk: &mut Walk) -> Result<Option<&[u8]>, &'static str> {
        if len == 0 {
            return Ok(Some(&[]));
        }
        if len > MAX_STREAM {
            return Err("record larger than 1 GiB");
        }
        if self.pos == self.block.len() && !self.next_block(walk)? {
            return Ok(None);
        }
        if self.block.len() - self.pos >= len {
            let start = self.pos;
            self.pos += len;
            return Ok(Some(&self.block[start..self.pos]));
        }
        self.joined.clear();
        while self.joined.len() < len {
            if self.pos == self.block.len() && !self.next_block(walk)? {
                return Err(CUT_SHORT);
            }
            let take = (len - self.joined.len()).min(self.block.len() - self.pos);
            self.joined
                .extend_from_slice(&self.block[self.pos..self.pos + take]);
            self.pos += take;
        }
        Ok(Some(&self.joined))
    }

    fn skip(&mut self, len: usize, walk: &mut Walk) -> Result<(), &'static str> {
        let mut left = len;
        while left > 0 {
            if self.pos == self.block.len() && !self.next_block(walk)? {
                return Err(CUT_SHORT);
            }
            let take = left.min(self.block.len() - self.pos);
            self.pos += take;
            left -= take;
        }
        Ok(())
    }
}

fn read_channel_group<'a>(
    file: &'a [u8],
    block_at: u64,
    block: &Block<'a>,
    walk: &mut Walk,
) -> Result<Group<'a>, &'static str> {
    if block.data.len() < 32 {
        return Err("bad channel group block");
    }
    let record_id = u64_at(block.data, 0);
    let flags = u16_at(block.data, 16);
    let record_len = u64::from(u32_at(block.data, 24)) + u64::from(u32_at(block.data, 28));
    let record_len = usize::try_from(record_len).map_err(|_| "bad channel group block")?;
    let mut channels = Vec::new();
    let mut seen = HashSet::new();
    read_channels(file, block.link(1), 0, &mut seen, walk, &mut channels)?;
    let bus = bus_group(file, &channels, walk)?;
    Ok(Group {
        block_at,
        record_id,
        record_len,
        vlsd: flags & VLSD_GROUP != 0,
        bus,
    })
}

/// Reads a channel chain and, through compositions, the member channels of structures.
/// Only the channels [`bus_group`] may use are kept: master channels, CAN frame structures
/// and channels named like their members.
fn read_channels(
    file: &[u8],
    first_at: u64,
    depth: usize,
    seen: &mut HashSet<u64>,
    walk: &mut Walk,
    out: &mut Vec<Channel>,
) -> Result<(), &'static str> {
    let mut cn_at = first_at;
    while cn_at != 0 {
        if !seen.insert(cn_at) {
            return Err(LINK_REPEATS);
        }
        walk.take_channel()?;
        let block = Block::typed(file, cn_at, b"##CN").ok_or("bad channel block")?;
        if block.data.len() < 16 {
            return Err("bad channel block");
        }
        let name = Block::typed(file, block.link(2), b"##TX")
            .map(|text| block_text(&text))
            .unwrap_or_default();
        let cn_type = block.data[0];
        let kept = matches!(cn_type, 2 | 3)
            || name.starts_with("can_")
            || MEMBERS.contains(&member_name(&name));
        if kept {
            if out.len() == MAX_KEPT_CHANNELS {
                return Err("channel group with too many CAN frame channels");
            }
            out.push(Channel {
                name,
                cn_type,
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
        }
        let composition_at = block.link(1);
        if composition_at != 0 && depth < MAX_COMPOSITION_DEPTH {
            // A composition is either a channel chain (a structure) or an array block.
            if Block::typed(file, composition_at, b"##CN").is_some() {
                read_channels(file, composition_at, depth + 1, seen, walk, out)?;
            }
        }
        cn_at = block.link(0);
    }
    Ok(())
}

/// The text of a TX block, lower-cased, up to its terminating zero.
fn block_text(block: &Block<'_>) -> String {
    let text = &block.data[..block.data.len().min(MAX_NAME)];
    let end = text.iter().position(|&b| b == 0).unwrap_or(text.len());
    String::from_utf8_lossy(&text[..end])
        .trim()
        .to_ascii_lowercase()
}

/// The CAN frame layout of a channel group, if one of its channels is a CAN frame structure.
fn bus_group<'a>(
    file: &'a [u8],
    channels: &[Channel],
    walk: &mut Walk,
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
                VariableStore::Block(joined_data(file, channel.data_at, walk)?)
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

fn frame_of<'r>(
    bus: &'r BusGroup<'_>,
    record: &'r [u8],
    index: usize,
    variable_groups: &'r [(u64, Vec<u8>)],
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
                    .map(|(_, data)| data.as_slice())
                    .ok_or("data bytes refer to a missing group")?,
            };
            variable_value(store, offset).ok_or("data offset outside the data")?
        }
    };
    let len = match (data_length, dlc) {
        (Some(length), _) => usize::try_from(length).unwrap_or(usize::MAX),
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
    let value_at = at.checked_add(4)?;
    let len = u32_at(store.get(at..value_at)?, 0) as usize;
    store.get(value_at..value_at.checked_add(len)?)
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
    let bytes = record.get(field.byte_offset..field.byte_offset.checked_add(byte_count)?)?;
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
    record.get(field.byte_offset..field.byte_offset.checked_add(len)?)
}

/// The data blocks a data link leads to, in order: the block itself, or the blocks of a
/// list (or of the list a header list leads to).
fn data_blocks(file: &[u8], at: u64) -> Result<Vec<u64>, &'static str> {
    if at == 0 {
        return Ok(Vec::new());
    }
    let block = Block::at(file, at).ok_or("bad data block")?;
    let mut list_at = match &block.id {
        b"##HL" => block.link(0),
        b"##DL" => at,
        _ => return Ok(vec![at]),
    };
    let mut seen = HashSet::new();
    let mut blocks = Vec::new();
    while list_at != 0 {
        if !seen.insert(list_at) {
            return Err(LINK_REPEATS);
        }
        let list = Block::typed(file, list_at, b"##DL").ok_or("bad data list block")?;
        let count = list
            .data
            .get(4..8)
            .map(|bytes| u32_at(bytes, 0) as usize)
            .ok_or("bad data list block")?;
        let listed = count.min(list.link_count().saturating_sub(1));
        blocks.extend(
            (1..=listed)
                .map(|index| list.link(index))
                .filter(|&at| at != 0),
        );
        list_at = list.link(0);
    }
    Ok(blocks)
}

/// A data block's bytes, inflated if it is compressed.
fn block_payload<'a>(
    file: &'a [u8],
    at: u64,
    walk: &mut Walk,
) -> Result<Cow<'a, [u8]>, &'static str> {
    let block = Block::at(file, at).ok_or("bad data block")?;
    match &block.id {
        b"##DT" | b"##DV" | b"##SD" | b"##RD" => {
            walk.take_data(block.data.len())?;
            Ok(Cow::Borrowed(block.data))
        }
        b"##DZ" => inflate(&block, walk).map(Cow::Owned),
        b"##DL" | b"##HL" => Err("data list inside a data list"),
        _ => Err("unknown data block type"),
    }
}

/// The bytes a data link leads to, joined into one, for variable length data whose offsets
/// count from the start of the first block.
fn joined_data<'a>(
    file: &'a [u8],
    at: u64,
    walk: &mut Walk,
) -> Result<Cow<'a, [u8]>, &'static str> {
    let blocks = data_blocks(file, at)?;
    if let [only] = blocks[..] {
        return block_payload(file, only, walk);
    }
    let mut out = Vec::new();
    for at in blocks {
        let part = block_payload(file, at, walk)?;
        if out.len() + part.len() > MAX_STREAM {
            return Err("data larger than 1 GiB");
        }
        out.extend_from_slice(&part);
    }
    Ok(Cow::Owned(out))
}

/// A DZ block's content: zlib-inflated, and transposed back when the writer transposed it
/// so that same-column bytes of consecutive records compressed better.
fn inflate(block: &Block<'_>, walk: &mut Walk) -> Result<Vec<u8>, &'static str> {
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
        .get(
            24..24usize
                .checked_add(compressed_len)
                .ok_or("bad compressed data block")?,
        )
        .ok_or("bad compressed data block")?;
    // Charged for the compressed bytes too: a stream of empty stored blocks inflates to
    // nothing but still takes time.
    walk.take_data(original_len.max(compressed_len))?;
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

        fn link(&self, block_at: u64, index: usize) -> u64 {
            let at = block_at as usize + 24 + index * 8;
            u64::from_le_bytes(self.bytes[at..at + 8].try_into().unwrap())
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
        assert_eq!(stats.first_rejection, Some((1, "bad data block")));
    }

    struct OneGroup {
        dg: u64,
        cg: u64,
        dt: u64,
        records: Vec<u8>,
    }

    /// A file with one sorted data group of `count` data frames on `bus`, 1 ms apart from
    /// `first_ms`, carrying the bytes 1 and 2.
    fn one_group(b: &mut Builder, bus: u8, first_ms: u32, count: u32) -> OneGroup {
        let sd = b.variable_data(&[&[1, 2]]);
        let records: Vec<u8> = (0..count)
            .flat_map(|i| {
                let t = f64::from(first_ms + i) / 1000.0;
                data_record(t, bus, 0x100, false, (2, 2), 0, [false; 4])
            })
            .collect();
        let dt = b.data_block(&records);
        let structure = b.structure("CAN_DataFrame", &data_frame_members(sd));
        let time = b.channel(&master("t", FLOAT, 0, 64), structure, 0);
        let cg = b.channel_group(0, 0, DATA_RECORD_LEN, time, 0);
        let dg = b.data_group(0, cg, dt);
        OneGroup {
            dg,
            cg,
            dt,
            records,
        }
    }

    fn file_of_one_group(count: u32) -> (Builder, OneGroup) {
        let mut b = Builder::new();
        let hd = b.header(0);
        let group = one_group(&mut b, 1, 0, count);
        b.set_link(hd, 0, group.dg);
        (b, group)
    }

    fn times(sink: &VecSink) -> Vec<i64> {
        sink.frames
            .iter()
            .map(|frame| frame.0 / 1_000_000)
            .collect()
    }

    #[test]
    fn records_split_across_blocks_are_put_back_together() {
        let (mut b, group) = file_of_one_group(5);
        let (first, rest) = group.records.split_at(13);
        let (second, third) = rest.split_at(DATA_RECORD_LEN as usize * 2 + 5);
        let first = b.data_block(first);
        let second = b.compressed_block(b"DT", second, 3);
        let empty = b.data_block(&[]);
        let third = b.data_block(third);
        let dl = b.data_list(&[first, second, empty, third]);
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2, 3, 4]);
        assert!(sink.frames.iter().all(|frame| frame.4 == [1, 2]));

        let cut = b.data_block(&group.records[..DATA_RECORD_LEN as usize + 3]);
        b.set_link(group.dg, 2, cut);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(times(&sink), [0]);
        assert_eq!(stats.first_rejection, Some((2, CUT_SHORT)));
    }

    #[test]
    fn frames_of_several_data_groups_are_merged_by_time() {
        let mut b = Builder::new();
        let hd = b.header(0);
        let even = one_group(&mut b, 1, 0, 3);
        let odd = one_group(&mut b, 2, 1, 4);
        let late = one_group(&mut b, 3, 10, 1);
        b.set_link(hd, 0, late.dg);
        b.set_link(late.dg, 0, odd.dg);
        b.set_link(odd.dg, 0, even.dg);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 1, 2, 2, 3, 4, 10]);
        let buses: Vec<u8> = sink.frames.iter().map(|frame| frame.1).collect();
        assert_eq!(
            buses,
            [0, 1, 0, 1, 0, 1, 1, 2],
            "ties go to the earlier data group"
        );
    }

    #[test]
    fn a_channel_group_without_records_does_not_hold_back_the_others() {
        let mut b = Builder::new();
        let hd = b.header(0);
        let sd = b.variable_data(&[&[1, 2]]);
        let count = REORDER_WINDOW as u32 + 10;
        let mut records = Vec::new();
        for i in 0..count {
            records.push(1);
            let t = f64::from(i) / 1000.0;
            records.extend(data_record(t, 1, 0x100, false, (2, 2), 0, [false; 4]));
        }
        let dt = b.data_block(&records);
        let data_structure = b.structure("CAN_DataFrame", &data_frame_members(sd));
        let data_time = b.channel(&master("t", FLOAT, 0, 64), data_structure, 0);
        let remote_members = [member("CAN_RemoteFrame.ID", UNSIGNED, 0, 16)];
        let remote_structure = b.structure("CAN_RemoteFrame", &remote_members);
        let remote_cg = b.channel_group(2, 0, 2, remote_structure, 0);
        let data_cg = b.channel_group(1, 0, DATA_RECORD_LEN, data_time, remote_cg);
        let dg = b.data_group(1, data_cg, dt);
        b.set_link(hd, 0, dg);

        let mut walk = Walk::new(b.bytes.len());
        let group = Block::typed(&b.bytes, dg, b"##DG").unwrap();
        let mut source = read_data_group(&b.bytes, &group, &mut walk, &mut walk_of(&b))
            .unwrap()
            .unwrap();
        let mut stats = ParseStats::default();
        assert_eq!(source.next_time(0, &mut walk, &mut stats), Some(0));
        assert_eq!(
            source.held.len(),
            REORDER_WINDOW,
            "read no further than the window"
        );

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), count as usize);
        assert!(sink.frames.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    }

    fn walk_of(b: &Builder) -> Walk {
        Walk::new(b.bytes.len())
    }

    #[test]
    fn data_groups_share_the_reorder_window() {
        // Four data groups, each with a data and a remote frame channel group, all linking
        // the same data block.
        let mut b = Builder::new();
        let hd = b.header(0);
        let sd = b.variable_data(&[&[1, 2]]);
        let count = REORDER_WINDOW as u32 / 4 + 10;
        let mut records = Vec::new();
        for i in 0..count {
            records.push(1);
            let t = f64::from(i) / 1000.0;
            records.extend(data_record(t, 1, 0x100, false, (2, 2), 0, [false; 4]));
        }
        let dt = b.data_block(&records);
        let mut groups = Vec::new();
        let mut next_dg = 0;
        for _ in 0..4 {
            let data_structure = b.structure("CAN_DataFrame", &data_frame_members(sd));
            let data_time = b.channel(&master("t", FLOAT, 0, 64), data_structure, 0);
            let remote_members = [member("CAN_RemoteFrame.ID", UNSIGNED, 0, 16)];
            let remote_structure = b.structure("CAN_RemoteFrame", &remote_members);
            let remote_cg = b.channel_group(2, 0, 2, remote_structure, 0);
            let data_cg = b.channel_group(1, 0, DATA_RECORD_LEN, data_time, remote_cg);
            next_dg = b.data_group(1, data_cg, dt);
            groups.push(next_dg);
        }
        for pair in groups.windows(2) {
            b.set_link(pair[1], 0, pair[0]);
        }
        b.set_link(hd, 0, next_dg);

        let mut walk = walk_of(&b);
        let mut variable_walk = walk_of(&b);
        let mut sources: Vec<Source<'_>> = groups
            .iter()
            .map(|&dg| {
                let group = Block::typed(&b.bytes, dg, b"##DG").unwrap();
                read_data_group(&b.bytes, &group, &mut walk, &mut variable_walk)
                    .unwrap()
                    .unwrap()
            })
            .collect();
        share_reorder_window(&mut sources);
        let mut stats = ParseStats::default();
        for source in &mut sources {
            assert_eq!(source.next_time(0, &mut walk, &mut stats), Some(0));
            assert_eq!(source.held.len(), REORDER_WINDOW / 4);
        }

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), 4 * count as usize);
        assert!(sink.frames.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    }

    #[test]
    fn data_giving_more_frames_than_the_file_has_bytes_ends_with_an_error() {
        // Records of nothing but a 1-byte record ID, from a block the data list repeats.
        let mut b = Builder::new();
        let hd = b.header(0);
        let dt = b.data_block(&[1; 1000]);
        let dl = b.data_list(&[dt; 100]);
        let structure = b.structure("CAN_DataFrame", &[]);
        let cg = b.channel_group(1, 0, 0, structure, 0);
        let dg = b.data_group(1, cg, dl);
        b.set_link(hd, 0, dg);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(
            stats.first_rejection.map(|(_, reason)| reason),
            Some("more frames than the file's size allows")
        );
        assert_eq!(sink.frames.len(), b.bytes.len() / FILE_BYTES_PER_FRAME);
    }

    /// A zlib stream of `data` in a stored block, after `empty` empty stored blocks.
    fn stored_zlib(data: &[u8], empty: usize) -> Vec<u8> {
        let mut out = vec![0x78, 0x01];
        for _ in 0..empty {
            out.extend_from_slice(&[0x00, 0x00, 0x00, 0xFF, 0xFF]);
        }
        let len = data.len() as u16;
        out.push(0x01);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(data);
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in data {
            a = (a + u32::from(byte)) % 65521;
            b = (b + a) % 65521;
        }
        out.extend_from_slice(&((b << 16) | a).to_be_bytes());
        out
    }

    #[test]
    fn compressed_blocks_are_charged_for_their_compressed_size() {
        let (mut b, group) = file_of_one_group(1);
        let compressed = stored_zlib(&group.records, 2000);
        let mut data = b"DT".to_vec();
        data.extend_from_slice(&[0, 0]);
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&(group.records.len() as u64).to_le_bytes());
        data.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        data.extend_from_slice(&compressed);
        let dz = b.block(b"##DZ", &[], &data);
        b.set_link(group.dg, 2, dz);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), 1);

        let dl = b.data_list(&[dz; 1000]);
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(
            stats.first_rejection.map(|(_, reason)| reason),
            Some("more data than the file's size allows")
        );
        let read = sink.frames.len() as u64 * compressed.len() as u64;
        assert!(read <= b.bytes.len() as u64 * MAX_DATA_PER_FILE_BYTE);
    }

    /// A chain of `count` channels that all share one name block.
    fn chain_of_one_name(b: &mut Builder, name: &str, count: usize) -> u64 {
        let text = b.text(name);
        let mut data = vec![0, 1, UNSIGNED, 0];
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&8u32.to_le_bytes());
        data.resize(72, 0);
        let mut next = 0;
        for _ in 0..count {
            next = b.block(b"##CN", &[next, 0, text, 0, 0, 0, 0, 0], &data);
        }
        next
    }

    #[test]
    fn channel_groups_keep_only_the_channels_a_frame_needs() {
        let (mut b, group) = file_of_one_group(3);
        let time = b.link(group.cg, 1);
        let structure = b.link(time, 0);
        let others = chain_of_one_name(&mut b, "EngineSpeed", MAX_KEPT_CHANNELS + 1);
        b.set_link(structure, 0, others);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        let ids = chain_of_one_name(&mut b, "Extra.ID", MAX_KEPT_CHANNELS);
        b.set_link(structure, 0, ids);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(
            stats.first_rejection,
            Some((1, "channel group with too many CAN frame channels"))
        );
    }

    #[test]
    fn links_that_lead_back_end_with_an_error() {
        let (mut b, group) = file_of_one_group(3);
        b.set_link(group.dg, 0, group.dg);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(times(&sink), [0, 1, 2]);
        assert_eq!(stats.first_rejection, Some((1, LINK_REPEATS)));

        let (mut b, group) = file_of_one_group(3);
        b.set_link(group.cg, 0, group.cg);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(stats.first_rejection, Some((1, LINK_REPEATS)));

        let (mut b, group) = file_of_one_group(3);
        let dl = b.data_list(&[group.dt]);
        b.set_link(dl, 0, dl);
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(stats.first_rejection, Some((1, LINK_REPEATS)));

        let (mut b, group) = file_of_one_group(3);
        let dl = b.data_list(&[group.dt]);
        let hl = b.block(b"##HL", &[dl], &[0; 8]);
        b.set_link(dl, 0, dl);
        b.set_link(group.dg, 2, hl);
        let (_, stats) = parse(&b.bytes);
        assert_eq!(stats.first_rejection, Some((1, LINK_REPEATS)));
    }

    #[test]
    fn compositions_that_lead_back_end_with_an_error() {
        // Every channel of a chain of 40 has the chain itself as its composition, which
        // would read 40^5 channels.
        let (mut b, group) = file_of_one_group(3);
        let members: Vec<Member> = (0..40).map(|_| member("x", UNSIGNED, 0, 8)).collect();
        let head = b.channels(&members, 0);
        let mut at = head;
        while at != 0 {
            b.set_link(at, 1, head);
            at = b.link(at, 0);
        }
        b.set_link(group.cg, 1, head);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(stats.first_rejection, Some((1, LINK_REPEATS)));
    }

    #[test]
    fn data_lists_read_no_more_blocks_than_they_link() {
        let (mut b, group) = file_of_one_group(3);
        let dl = b.data_list(&[group.dt]);
        let count_at = dl as usize + 24 + 2 * 8 + 4;
        b.bytes[count_at..count_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);
    }

    #[test]
    fn data_lists_that_repeat_a_block_stop_at_the_data_budget() {
        // Records padded past the data budget's share of a frame, so that the data budget
        // rather than the frame budget ends the file.
        const RECORD_LEN: usize = 4 * MAX_DATA_PER_FILE_BYTE as usize;
        let (mut b, group) = file_of_one_group(200);
        let padded: Vec<u8> = group
            .records
            .chunks(DATA_RECORD_LEN as usize)
            .flat_map(|record| {
                let mut record = record.to_vec();
                record.resize(RECORD_LEN, 0);
                record
            })
            .collect();
        let record_len_at = group.cg as usize + 24 + 6 * 8 + 24;
        b.bytes[record_len_at..record_len_at + 4]
            .copy_from_slice(&(RECORD_LEN as u32).to_le_bytes());
        let dt = b.data_block(&padded);
        let dl = b.data_list(&[dt; 1000]);
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(
            stats.first_rejection.map(|(_, reason)| reason),
            Some("more data than the file's size allows")
        );
        let read = sink.frames.len() as u64 * RECORD_LEN as u64;
        assert!(read <= b.bytes.len() as u64 * MAX_DATA_PER_FILE_BYTE);
        assert!(sink.frames.len() < 200 * 1000);
    }

    #[test]
    fn unfinalized_files_are_read_when_the_data_is_usable() {
        let (mut b, _) = file_of_one_group(2);
        b.bytes[..8].copy_from_slice(UNFINALIZED);
        b.bytes[60..62].copy_from_slice(&0x0001u16.to_le_bytes());
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1]);

        b.bytes[60..62].copy_from_slice(&0x0004u16.to_le_bytes());
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(
            stats.first_rejection,
            Some((
                1,
                "unfinalized MF4 file; finalize it with the logger's tool"
            ))
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
