//! ASAM MDF 4 (MF4) files with CAN bus logging.
//!
//! An MF4 file is a tree of blocks linked by absolute offsets: the header (HD) lists data
//! groups (DG), each with channel groups (CG) that describe the records of its data stream
//! (DT, or compressed DZ, or lists of them) through channels (CN). CAN frames are the
//! records of channel groups whose structure channel is `CAN_DataFrame`, `CAN_RemoteFrame`
//! or `CAN_ErrorFrame`, with members such as `ID`, `DLC`, `DataBytes` and `BusChannel`.
//! Because the links point anywhere in the file, the file is buffered whole and read when
//! it ends. Each data group's records are then read a data block at a time, and the frames
//! of the data groups are merged by time as they are delivered. A large file's records can
//! instead be read in parts by other workers and merged here (see [`parts`]).

use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::text::{dlc_to_len, ChannelName};
use crate::{push_frame, LogParser, ParseStats};

mod parts;
#[cfg(any(test, feature = "test-util"))]
pub mod test_file;

pub use parts::{read_part, Joined, PartTask};

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
/// channel groups. Frames further out of order reach the sink out of order, for it to sort.
const REORDER_WINDOW: usize = 1 << 16;

const VLSD_GROUP: u16 = 0x1;

const BLOCK_IDS: [[u8; 4]; 25] = [
    *b"##HD", *b"##MD", *b"##TX", *b"##FH", *b"##CH", *b"##AT", *b"##EV", *b"##DG", *b"##CG",
    *b"##SI", *b"##CN", *b"##CC", *b"##CA", *b"##DT", *b"##SR", *b"##RD", *b"##SD", *b"##DL",
    *b"##DZ", *b"##HL", *b"##LD", *b"##DV", *b"##DI", *b"##RV", *b"##RI",
];
/// The blocks [`block_payload`] reads.
const DATA_BLOCKS: [[u8; 4]; 5] = [*b"##DT", *b"##DV", *b"##SD", *b"##RD", *b"##DZ"];

const FINALIZED: &[u8; 8] = b"MDF     ";
const UNFINALIZED: &[u8; 8] = b"UnFinMF ";
/// Unfinalized flags for what this reader does not use: the cycle counters of CG, CA and SR
/// blocks, the length of the last RD block, and the data byte counts of VLSD channel groups.
const UNFINALIZED_UNUSED: u16 = 0x01 | 0x02 | 0x08 | 0x20;
const UNFINALIZED_LAST_DT: u16 = 0x04;
const UNFINALIZED_LAST_DL: u16 = 0x10;
const UNFINALIZED_VLSD_OFFSETS: u16 = 0x40;

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
    /// The frames, once the file is planned to be read in parts, until they are all joined.
    join: Option<Box<parts::Join>>,
    /// Every part is joined, so `finish` reads nothing.
    joined: bool,
}

impl Mf4Parser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve the file buffer for a file of `total_bytes`, so that it does not double as
    /// chunks arrive. A file over [`MAX_FILE`] reserves nothing, and a failed reservation
    /// leaves the buffer to grow as usual.
    pub fn expect_bytes(&mut self, total_bytes: u64) {
        let Ok(total_bytes) = usize::try_from(total_bytes) else {
            return;
        };
        if total_bytes > MAX_FILE {
            return;
        }
        let missing = total_bytes.saturating_sub(self.file.len());
        let _ = self.file.try_reserve_exact(missing);
    }

    /// Plans reading the frames of the file pushed so far in parts of about `part_bytes` of
    /// its data each, by [`read_part`] in other workers, and returns how many parts there are.
    /// The parser then lets the file go and takes the parts through [`Mf4Parser::join_part`]
    /// instead of reading it in `finish`. None, the parser left as it was, for a file that
    /// must be read whole: see [`parts`].
    pub fn plan_parts(&mut self, part_bytes: u64) -> Option<usize> {
        if self.too_large || self.reads_in_parts() {
            return None;
        }
        let mut stats = self.stats.clone();
        let join = parts::plan(&self.file, &mut stats, part_bytes)?;
        let count = join.tasks.len();
        self.stats = stats;
        self.file = Vec::new();
        self.join = Some(Box::new(join));
        Some(count)
    }

    /// Part `index` of the plan, for [`read_part`].
    #[must_use]
    pub fn part_task(&self, index: usize) -> Option<&PartTask> {
        self.join.as_ref()?.tasks.get(index)
    }

    /// Merges the frames of part `index`, read by [`read_part`], with those of the parts
    /// joined before it, as far as they go, and says which part to join next. Parts must be
    /// joined in the order asked for, starting with part 0. None when the part can't be
    /// joined, and the file must be read again whole in a new parser.
    pub fn join_part<S: FrameSink>(
        &mut self,
        index: usize,
        part: &[u8],
        sink: &mut S,
    ) -> Option<Joined> {
        let joined = self
            .join
            .as_mut()?
            .join(index, part, &mut self.stats, sink)
            .ok()?;
        if joined == Joined::Done {
            // Its windows, reads and variable length data would otherwise live as long as
            // the parser, which is kept for its stats.
            self.join = None;
            self.joined = true;
        }
        Some(joined)
    }

    /// Whether the frames are read in parts, so `finish` reads none.
    #[must_use]
    pub fn reads_in_parts(&self) -> bool {
        self.join.is_some() || self.joined
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
        if self.too_large || self.reads_in_parts() {
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
    at: u64,
    id: [u8; 4],
    links: &'a [u8],
    data: &'a [u8],
}

impl<'a> Block<'a> {
    fn at(file: &'a [u8], at: u64) -> Option<Self> {
        let start = usize::try_from(at).ok()?;
        let header = file.get(start..start.checked_add(BLOCK_HEADER)?)?;
        let length = usize::try_from(u64_at(header, 8)).ok()?;
        Self::ending_at(file, at, start.checked_add(length)?)
    }

    /// The block at `at` as though its length field said it ends at `end`.
    fn ending_at(file: &'a [u8], at: u64, end: usize) -> Option<Self> {
        let start = usize::try_from(at).ok()?;
        let header = file.get(start..start.checked_add(BLOCK_HEADER)?)?;
        if &header[..2] != b"##" {
            return None;
        }
        let links_len = usize::try_from(u64_at(header, 16)).ok()?.checked_mul(8)?;
        let body = file.get(start + BLOCK_HEADER..end)?;
        if body.len() < links_len {
            return None;
        }
        Some(Block {
            at,
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

/// The ID of the block whose header is at `at`, whether or not its length fits the file.
fn block_id(file: &[u8], at: u64) -> Option<[u8; 4]> {
    let at = usize::try_from(at).ok()?;
    let header = file.get(at..at.checked_add(BLOCK_HEADER)?)?;
    if &header[..2] != b"##" {
        return None;
    }
    header[..4].try_into().ok()
}

/// What the writer of an unfinalized file left for a finalizer to fix, which the reader
/// works around instead.
#[derive(Clone, Copy, Default)]
struct Repairs {
    /// The length of the last DT block of each data group was not updated (flag 0x04).
    last_data_block: bool,
    /// The last DL block of each list may have a count or links not updated (flag 0x10).
    last_data_list: bool,
    /// The offsets of VLSD values in frame records were not written (flag 0x40).
    vlsd_offsets: bool,
}

/// What reading a file may still cost, so that links which loop or fan out end with an
/// error rather than a hang, and what an unfinalized file needs repaired.
struct Walk {
    /// Data group and channel group blocks read so far.
    seen: HashSet<u64>,
    channels_left: usize,
    data_left: u64,
    frames_left: usize,
    repairs: Repairs,
    /// Where the blocks linked from the blocks read start, kept only to find where a last
    /// data block whose length was not updated ends. Sorted only once every block is read.
    starts: Vec<u64>,
    /// The blocks whose links are in `starts`, so that a block read again adds none.
    linked: HashSet<u64>,
    links_left: usize,
    /// Data lists read and the block links they list, charged each time a list is read,
    /// since data groups may all link the same list.
    listed_left: usize,
    /// Each charge of data, in order, kept when a part's charges are made in the core
    /// worker instead (see [`parts`]).
    charges: Option<Vec<u64>>,
}

impl Walk {
    fn new(file_len: usize, repairs: Repairs) -> Self {
        Walk {
            seen: HashSet::new(),
            channels_left: file_len / FILE_BYTES_PER_CHANNEL,
            data_left: (file_len as u64).saturating_mul(MAX_DATA_PER_FILE_BYTE),
            frames_left: file_len / FILE_BYTES_PER_FRAME,
            repairs,
            starts: Vec::new(),
            linked: HashSet::new(),
            links_left: file_len / 8,
            listed_left: file_len / 8,
            charges: None,
        }
    }

    /// A walk that never runs out.
    fn unlimited(repairs: Repairs) -> Self {
        Walk {
            channels_left: usize::MAX,
            data_left: u64::MAX,
            frames_left: usize::MAX,
            links_left: usize::MAX,
            listed_left: usize::MAX,
            ..Walk::new(0, repairs)
        }
    }

    fn found_links(&mut self, block: &Block<'_>) -> Result<(), &'static str> {
        if !self.repairs.last_data_block || !self.linked.insert(block.at) {
            return Ok(());
        }
        self.links_left = self
            .links_left
            .checked_sub(block.link_count())
            .ok_or("more links than the file's size allows")?;
        self.starts.extend(
            (0..block.link_count())
                .map(|index| block.link(index))
                .filter(|&at| at != 0),
        );
        Ok(())
    }

    fn take_listed(&mut self, count: usize) -> Result<(), &'static str> {
        self.listed_left = self
            .listed_left
            .checked_sub(count)
            .ok_or("more data block links than the file's size allows")?;
        Ok(())
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
        if let Some(charges) = &mut self.charges {
            charges.push(len as u64);
        }
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
    let Prepared {
        start_ns,
        mut walk,
        sources,
    } = prepare(file, stats, false)?;
    merge(sources, start_ns, &mut walk, stats, sink);
    Ok(())
}

/// A file read up to its frames: the data groups that have CAN frames, ready to be read.
struct Prepared<'a> {
    start_ns: i64,
    walk: Walk,
    sources: Vec<Source<'a>>,
}

/// When `for_parts`, a file whose records can't be read in parts ends with an error before
/// its variable length data is read (see [`parts::splittable`]).
fn prepare<'a>(
    file: &'a [u8],
    stats: &mut ParseStats,
    for_parts: bool,
) -> Result<Prepared<'a>, &'static str> {
    let repairs = check_identification(file)?;
    let header = Block::typed(file, 64, b"##HD").ok_or("MF4 header block missing")?;
    let start_ns = header
        .data
        .get(..8)
        .and_then(|bytes| i64::try_from(u64_at(bytes, 0)).ok())
        .ok_or("start time out of range")?;
    let mut walk = Walk::new(file.len(), repairs);
    // The variable length data pass reads the same blocks again, so it has a budget of its own.
    let mut variable_walk = Walk::new(file.len(), repairs);
    walk.found_links(&header)?;
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
        match read_data_group(file, &group, &mut walk) {
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
    // Where an unfinished data block ends depends on every block linked, so this waits for
    // all the data groups.
    walk.starts.sort_unstable();
    walk.starts.dedup();
    for source in &mut sources {
        let reader = &mut source.reader;
        if repairs.last_data_block {
            reader.records.run_on_last_block(&walk.starts);
        }
        if for_parts && !parts::splittable(file, reader, repairs) {
            return Err(parts::NOT_SPLITTABLE);
        }
        if reader.record_id_size != 0 {
            reader.variable = variable_data(
                &reader.records,
                reader.record_id_size,
                &reader.groups,
                &mut variable_walk,
            );
        }
    }
    share_reorder_window(&mut sources);
    Ok(Prepared {
        start_ns,
        walk,
        sources,
    })
}

fn check_identification(file: &[u8]) -> Result<Repairs, &'static str> {
    let finalized = file.starts_with(FINALIZED);
    if file.len() < 64 || !(finalized || file.starts_with(UNFINALIZED)) {
        return Err("not an MF4 file (no MDF signature)");
    }
    if file[8] != b'4' {
        return Err("MDF file version is not 4.x");
    }
    if finalized {
        return Ok(Repairs::default());
    }
    // The custom flags (bytes 62 and 63) are the writer's own, so the file is read as it is.
    let flags = u16_at(file, 60);
    let repaired = UNFINALIZED_LAST_DT | UNFINALIZED_LAST_DL | UNFINALIZED_VLSD_OFFSETS;
    if flags & !(UNFINALIZED_UNUSED | repaired) != 0 {
        return Err("unfinalized MF4 file; finalize it with the logger's tool");
    }
    Ok(Repairs {
        last_data_block: flags & UNFINALIZED_LAST_DT != 0,
        last_data_list: flags & UNFINALIZED_LAST_DL != 0,
        vlsd_offsets: flags & UNFINALIZED_VLSD_OFFSETS != 0,
    })
}

/// Splits the reorder window between the data groups that need one, since data groups may
/// all link the same data and would otherwise each hold a full window.
fn share_reorder_window(sources: &mut [Source<'_>]) {
    let reordering = sources.iter().filter(|s| s.window.len > 1).count();
    let share = (REORDER_WINDOW / reordering.max(1)).max(1);
    for source in sources.iter_mut().filter(|s| s.window.len > 1) {
        source.window.len = share;
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
    let mut buses = Buses::default();
    for (index, source) in sources.iter_mut().enumerate() {
        if let Some(ts_ns) = source.next_time(start_ns, walk, stats) {
            next.push(Reverse((ts_ns, index)));
        }
    }
    while let Some(Reverse((_, index))) = next.pop() {
        let source = &mut sources[index];
        if let Some(frame) = source.window.take() {
            deliver(frame, &mut buses, sink);
        }
        if let Some(ts_ns) = source.next_time(start_ns, walk, stats) {
            next.push(Reverse((ts_ns, index)));
        }
    }
}

fn deliver<S: FrameSink>(frame: &Frame, buses: &mut Buses, sink: &mut S) {
    let frame_ref = FrameRef {
        ts_ns: frame.ts_ns,
        channel: buses.channel(frame.bus, sink),
        id: frame.id,
        flags: frame.flags,
        data: &frame.data[..usize::from(frame.len)],
    };
    push_frame(sink, frame_ref, frame.remote_dlc);
}

/// The sink's channel for each of the first few bus numbers met, so that a frame's bus name
/// is made and looked up once per bus rather than once per frame.
#[derive(Default)]
struct Buses(Vec<(u32, u8)>);

impl Buses {
    const KEPT: usize = 16;

    fn channel<S: FrameSink>(&mut self, bus: u32, sink: &mut S) -> u8 {
        if let Some(&(_, channel)) = self.0.iter().find(|(known, _)| *known == bus) {
            return channel;
        }
        let channel = sink.channel_index(ChannelName::new(u64::from(bus)).as_bytes());
        if self.0.len() < Self::KEPT {
            self.0.push((bus, channel));
        }
        channel
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
    reader: RecordReader<'a>,
    window: Window,
    ended: bool,
}

/// Reads the records of a data group's stream, making frames of those of CAN frame groups.
struct RecordReader<'a> {
    groups: Vec<Group<'a>>,
    record_id_size: usize,
    records: BlockReader<'a>,
    /// The variable length data of the VLSD channel groups that frames point into.
    variable: Vec<VariableGroup>,
    /// Records read so far in each channel group, for virtual time channels.
    indexes: Vec<usize>,
    /// Leaves payloads in variable length data for the core worker to find (see [`parts`]).
    defer_variable: bool,
}

/// Frames read and not yet delivered, earliest first, ties in record order.
struct Window {
    /// Each frame's time, record number and slot in `held`.
    order: BinaryHeap<Reverse<(i64, u64, usize)>>,
    /// How many frames to read ahead before delivering the earliest. MDF has the times of a
    /// channel group never decrease, so with one CAN frame channel group that is one frame;
    /// with several, their records interleave, as loggers write them when they arrive.
    len: usize,
    held: Vec<Frame>,
    free: Vec<usize>,
    records_read: u64,
}

impl Window {
    fn new(len: usize) -> Self {
        Window {
            order: BinaryHeap::new(),
            len,
            held: Vec::new(),
            free: Vec::new(),
            records_read: 0,
        }
    }

    fn is_full(&self) -> bool {
        self.order.len() >= self.len
    }

    fn hold(&mut self, frame: Frame) {
        let ts_ns = frame.ts_ns;
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
        self.order.push(Reverse((ts_ns, self.records_read, slot)));
        self.records_read += 1;
    }

    fn earliest(&self) -> Option<i64> {
        self.order.peek().map(|Reverse((ts_ns, _, _))| *ts_ns)
    }

    /// The earliest frame held. Its slot is reused by the next frame held.
    fn take(&mut self) -> Option<&Frame> {
        let Reverse((_, _, slot)) = self.order.pop()?;
        self.free.push(slot);
        Some(&self.held[slot])
    }
}

/// What reading up to the next frame record of a data group came to.
enum Outcome {
    /// The data group has no more records.
    End,
    /// An error that ends the data group.
    Failed(&'static str),
    Frame(Frame),
    /// A frame record that makes no frame.
    Rejected(&'static str),
    /// A frame record whose payload is still to be found in variable length data.
    Pending(PendingFrame),
}

struct PendingFrame {
    /// The record's channel group.
    group: usize,
    offset: u64,
    fields: RecordFields,
}

/// Counts `outcome` and holds its frame. Returns whether it ends the data group.
fn account(outcome: Outcome, window: &mut Window, walk: &mut Walk, stats: &mut ParseStats) -> bool {
    match outcome {
        Outcome::End => true,
        Outcome::Failed(reason) => {
            stats.lines += 1;
            stats.reject(reason);
            true
        }
        Outcome::Frame(_) | Outcome::Rejected(_) | Outcome::Pending(_) => {
            stats.lines += 1;
            if let Err(reason) = walk.take_frame() {
                stats.reject(reason);
                return true;
            }
            match outcome {
                Outcome::Frame(frame) => {
                    stats.frames += 1;
                    window.hold(frame);
                }
                Outcome::Rejected(reason) => stats.reject(reason),
                Outcome::End | Outcome::Failed(_) | Outcome::Pending(_) => {}
            }
            false
        }
    }
}

/// The values of a VLSD channel group, each after its length as in an SD block.
struct VariableGroup {
    /// The channel group's block offset.
    at: u64,
    data: Vec<u8>,
    /// Where the next frame record's value starts, for records whose offsets were never
    /// written (unfinalized flag 0x40): values are written in the order of their records.
    next: usize,
}

struct Frame {
    ts_ns: i64,
    bus: u32,
    id: u32,
    flags: u8,
    len: u8,
    data: [u8; MAX_PAYLOAD],
    remote_dlc: Option<u8>,
}

fn read_data_group<'a>(
    file: &'a [u8],
    group: &Block<'a>,
    walk: &mut Walk,
) -> Result<Option<Source<'a>>, &'static str> {
    let record_id_size = usize::from(*group.data.first().ok_or("bad data group block")?);
    if !matches!(record_id_size, 0 | 1 | 2 | 4 | 8) {
        return Err("bad record ID size");
    }
    walk.found_links(group)?;
    let mut groups = Vec::new();
    let mut cg_at = group.link(1);
    while cg_at != 0 {
        walk.visit(cg_at)?;
        let block = Block::typed(file, cg_at, b"##CG").ok_or("bad channel group block")?;
        walk.found_links(&block)?;
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
    let blocks = data_blocks(file, group.link(2), walk)?;
    Ok(Some(Source {
        reader: RecordReader {
            indexes: vec![0; groups.len()],
            groups,
            record_id_size,
            records: BlockReader::new(file, blocks),
            variable: Vec::new(),
            defer_variable: false,
        },
        window: Window::new(if frame_groups > 1 { REORDER_WINDOW } else { 1 }),
        ended: false,
    }))
}

/// The variable length data of the VLSD channel groups that CAN frames point into. It lives
/// in records of its own, interleaved with the frames, so it is gathered in a pass of its
/// own before them. Errors are left for the frames' pass to report.
fn variable_data(
    records: &BlockReader<'_>,
    record_id_size: usize,
    groups: &[Group<'_>],
    walk: &mut Walk,
) -> Vec<VariableGroup> {
    let mut values: Vec<VariableGroup> = Vec::new();
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
            if !values.iter().any(|known| known.at == *at) {
                values.push(VariableGroup {
                    at: *at,
                    data: Vec::new(),
                    next: 0,
                });
            }
        }
    }
    if values.is_empty() {
        return values;
    }
    let pointed_at: Vec<u64> = values.iter().map(|group| group.at).collect();
    let wanted = |index: usize| groups[index].vlsd && pointed_at.contains(&groups[index].block_at);
    // A group stops gathering at its first value that does not fit, so that the offsets
    // of the values it holds stay right.
    let mut full = vec![false; values.len()];
    let mut records = records.unread_copy();
    while let Ok(Some((index, value))) =
        next_record(&mut records, groups, record_id_size, walk, wanted)
    {
        let Some(slot) = values
            .iter()
            .position(|group| group.at == groups[index].block_at)
        else {
            continue;
        };
        if full[slot] {
            continue;
        }
        let data = &mut values[slot].data;
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
        while !self.ended && !self.window.is_full() {
            let outcome = self.reader.next_outcome(start_ns, walk);
            self.ended = account(outcome, &mut self.window, walk, stats);
        }
        self.window.earliest()
    }
}

impl RecordReader<'_> {
    /// Reads up to the next frame record and makes its frame.
    fn next_outcome(&mut self, start_ns: i64, walk: &mut Walk) -> Outcome {
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
            Ok(None) => return Outcome::End,
            Err(reason) => return Outcome::Failed(reason),
        };
        let Some(bus) = &groups[group_index].bus else {
            return Outcome::End;
        };
        let record_index = self.indexes[group_index];
        self.indexes[group_index] += 1;
        let offsets_unwritten = walk.repairs.vlsd_offsets;
        let outcome = match record_fields(bus, record, record_index, start_ns) {
            Err(reason) => Outcome::Rejected(reason),
            Ok((fields, Payload::Bytes(data))) => {
                Outcome::Frame(frame_from(bus.kind, &fields, data))
            }
            Ok((fields, Payload::Variable(offset))) if self.defer_variable => {
                Outcome::Pending(PendingFrame {
                    group: group_index,
                    offset,
                    fields,
                })
            }
            Ok((fields, Payload::Variable(offset))) => {
                let Some(DataBytes::Variable { store, .. }) = &bus.data_bytes else {
                    return Outcome::End;
                };
                match variable_payload(store, &self.variable, offsets_unwritten, offset) {
                    Ok(data) => Outcome::Frame(frame_from(bus.kind, &fields, data)),
                    Err(reason) => Outcome::Rejected(reason),
                }
            }
        };
        if offsets_unwritten {
            if let Some(DataBytes::Variable {
                store: VariableStore::Group(at),
                ..
            }) = &bus.data_bytes
            {
                if let Some(group) = self.variable.iter_mut().find(|g| g.at == *at) {
                    if let Some(value) = variable_value(&group.data, group.next as u64) {
                        group.next += 4 + value.len();
                    }
                }
            }
        }
        outcome
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
    let ends_open = records.ends_open();
    loop {
        // A writer that preallocates its file leaves zeros past what it wrote, so in a last
        // block that runs on, a record of nothing but zeros ends the data.
        let in_open_block = records.next_starts_in_open_block(walk)?;
        let (group_index, zero_id) = if record_id_size == 0 {
            (0, true)
        } else {
            let Some(id_bytes) = records.read(record_id_size, walk)? else {
                return Ok(None);
            };
            let mut record_id = [0u8; 8];
            record_id[..record_id_size].copy_from_slice(id_bytes);
            let record_id = u64::from_le_bytes(record_id);
            match groups.iter().position(|g| g.record_id == record_id) {
                Some(index) => (index, record_id == 0),
                None if record_id == 0 && in_open_block => return Ok(None),
                None => return Err("record with an unknown channel group ID"),
            }
        };
        let group = &groups[group_index];
        let len = if group.vlsd {
            match records.read(4, walk)? {
                Some(len_bytes) => u32_at(len_bytes, 0) as usize,
                None if ends_open => return Ok(None),
                None => return Err(CUT_SHORT),
            }
        } else {
            group.record_len
        };
        if !wanted(group_index) {
            records.skip(len, walk)?;
            continue;
        }
        return match records.read(len, walk)? {
            Some(record) if zero_id && in_open_block && record.iter().all(|&b| b == 0) => Ok(None),
            Some(record) => Ok(Some((group_index, record))),
            None if record_id_size == 0 || ends_open => Ok(None),
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
    /// Where `block` starts in the stream.
    block_start: u64,
    /// A record that continues from one block into the next, put back together.
    joined: Vec<u8>,
    /// Where the last block ends when it is a DT block whose length was not updated
    /// (unfinalized flag 0x04). A record cut short there ends the data quietly, as the
    /// writer was stopped while writing it.
    open_end: Option<usize>,
}

impl<'a> BlockReader<'a> {
    fn new(file: &'a [u8], blocks: Vec<u64>) -> Self {
        BlockReader {
            file,
            blocks: blocks.into_iter(),
            block: Cow::Borrowed(&[]),
            pos: 0,
            block_start: 0,
            joined: Vec::new(),
            open_end: None,
        }
    }

    /// A reader of the same blocks from the start, for a reader that has not read yet.
    fn unread_copy(&self) -> Self {
        BlockReader {
            file: self.file,
            blocks: self.blocks.clone(),
            block: Cow::Borrowed(&[]),
            pos: 0,
            block_start: 0,
            joined: Vec::new(),
            open_end: self.open_end,
        }
    }

    /// Has a last DT block run on to the next block in `starts` (sorted), or to the end of
    /// the file, rather than end where its length field says.
    fn run_on_last_block(&mut self, starts: &[u64]) {
        let Some(&at) = self.blocks.as_slice().last() else {
            return;
        };
        if block_id(self.file, at) != Some(*b"##DT") {
            return;
        }
        let Ok(start) = usize::try_from(at) else {
            return;
        };
        let limit = starts
            .get(starts.partition_point(|&next| next <= at))
            .and_then(|&next| usize::try_from(next).ok())
            .map_or(self.file.len(), |next| next.min(self.file.len()));
        let stated_end = usize::try_from(u64_at(self.file, start + 8))
            .ok()
            .and_then(|length| start.checked_add(length));
        // A length that reaches the next block, but for padding, or that ends where another
        // block starts was updated after all. One too short for the block's header never was.
        let stated_is_right = stated_end.is_some_and(|end| {
            if end > limit || Block::ending_at(self.file, at, end).is_none() {
                return false;
            }
            let aligned = end.next_multiple_of(8);
            aligned >= limit
                || Block::at(self.file, aligned as u64)
                    .is_some_and(|block| BLOCK_IDS.contains(&block.id))
        });
        self.open_end = Some(match stated_end {
            Some(end) if stated_is_right => end,
            _ => limit,
        });
    }

    fn ends_open(&self) -> bool {
        self.open_end.is_some()
    }

    /// The stream bytes read so far.
    fn position(&self) -> u64 {
        self.block_start + self.pos as u64
    }

    /// Whether the next byte read is in a last block that runs on.
    fn next_starts_in_open_block(&mut self, walk: &mut Walk) -> Result<bool, &'static str> {
        if !self.ends_open() || (self.pos == self.block.len() && !self.next_block(walk)?) {
            return Ok(false);
        }
        Ok(self.blocks.as_slice().is_empty())
    }

    /// Moves to the next block that is not empty, if there is one.
    fn next_block(&mut self, walk: &mut Walk) -> Result<bool, &'static str> {
        self.block_start += self.block.len() as u64;
        self.block = Cow::Borrowed(&[]);
        self.pos = 0;
        while let Some(at) = self.blocks.next() {
            let block = match self.open_end {
                Some(end) if self.blocks.as_slice().is_empty() => {
                    open_block_payload(self.file, at, end, walk)?
                }
                _ => block_payload(self.file, at, walk)?,
            };
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
                return if self.ends_open() {
                    Ok(None)
                } else {
                    Err(CUT_SHORT)
                };
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
                return if self.ends_open() {
                    Ok(())
                } else {
                    Err(CUT_SHORT)
                };
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
        walk.found_links(&block)?;
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

/// A frame record's fields, up to its payload.
#[derive(Clone, Copy)]
struct RecordFields {
    ts_ns: i64,
    bus: u32,
    raw_id: u64,
    extended: bool,
    flags: u8,
    dlc: Option<u64>,
    data_length: Option<u64>,
}

/// Where a frame record's payload is.
enum Payload<'r> {
    Bytes(&'r [u8]),
    /// At this offset in the channel group's variable length data.
    Variable(u64),
}

fn record_fields<'r>(
    bus: &BusGroup<'_>,
    record: &'r [u8],
    index: usize,
    start_ns: i64,
) -> Result<(RecordFields, Payload<'r>), &'static str> {
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

    let payload = match (&bus.kind, &bus.data_bytes) {
        (FrameKind::Remote, _) | (_, None) => Payload::Bytes(&[]),
        (_, Some(DataBytes::Fixed(field))) => {
            Payload::Bytes(field_bytes(record, field).ok_or("bad data bytes")?)
        }
        (_, Some(DataBytes::Variable { field, .. })) => {
            // The record holds a little-endian offset whatever the value's data type.
            let offset_field = Field {
                data_type: 0,
                ..*field
            };
            Payload::Variable(field_bits(record, &offset_field).ok_or("bad data offset")?)
        }
    };
    let fields = RecordFields {
        ts_ns,
        bus: channel,
        raw_id,
        extended,
        flags: frame_flags,
        dlc,
        data_length,
    };
    Ok((fields, payload))
}

/// The payload a frame record's offset points at in variable length data.
fn variable_payload<'v>(
    store: &'v VariableStore<'_>,
    variable_groups: &'v [VariableGroup],
    offsets_unwritten: bool,
    offset: u64,
) -> Result<&'v [u8], &'static str> {
    let (store, offset): (&[u8], u64) = match store {
        VariableStore::Block(block) => (block, offset),
        VariableStore::Group(at) => {
            let group = variable_groups
                .iter()
                .find(|group| group.at == *at)
                .ok_or("data bytes refer to a missing group")?;
            if offsets_unwritten {
                (&group.data, group.next as u64)
            } else {
                (&group.data, offset)
            }
        }
    };
    variable_value(store, offset).ok_or("data offset outside the data")
}

/// The frame of a record of `kind` with `fields` and the payload `data`.
fn frame_from(kind: FrameKind, fields: &RecordFields, data: &[u8]) -> Frame {
    let mut frame_flags = fields.flags;
    let len = match (fields.data_length, fields.dlc) {
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
    let mut remote_dlc = None;
    let id = match kind {
        FrameKind::Error => {
            frame_flags |= flags::ERROR;
            ERR_FLAG
        }
        FrameKind::Remote => {
            frame_flags |= flags::RTR;
            remote_dlc = fields.dlc.map(|dlc| dlc.min(15) as u8);
            can_id(fields.raw_id, fields.extended)
        }
        FrameKind::Data => can_id(fields.raw_id, fields.extended),
    };
    let mut frame = Frame {
        ts_ns: fields.ts_ns,
        bus: fields.bus,
        id,
        flags: frame_flags,
        len: len as u8,
        data: [0; MAX_PAYLOAD],
        remote_dlc,
    };
    frame.data[..len].copy_from_slice(&data[..len]);
    frame
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
    // Bytes read past the field's own are masked off below.
    let word = field
        .byte_offset
        .checked_add(8)
        .and_then(|end| record.get(field.byte_offset..end));
    let value = match word {
        _ if big_endian => {
            buffer[8 - byte_count..].copy_from_slice(bytes);
            u64::from_be_bytes(buffer)
        }
        Some(word) => u64_at(word, 0),
        None => {
            buffer[..byte_count].copy_from_slice(bytes);
            u64::from_le_bytes(buffer)
        }
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
fn data_blocks(file: &[u8], at: u64, walk: &mut Walk) -> Result<Vec<u64>, &'static str> {
    if at == 0 {
        return Ok(Vec::new());
    }
    let Some(block) = Block::at(file, at) else {
        // The length of an unfinished last DT block may not fit the file.
        let unfinished = walk.repairs.last_data_block && block_id(file, at) == Some(*b"##DT");
        return if unfinished {
            Ok(vec![at])
        } else {
            Err("bad data block")
        };
    };
    let mut list_at = match &block.id {
        b"##HL" => {
            walk.found_links(&block)?;
            block.link(0)
        }
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
        walk.found_links(&list)?;
        let next_list = list.link(0);
        let links = list.link_count().saturating_sub(1);
        if next_list == 0 && walk.repairs.last_data_list {
            walk.take_listed(1 + links)?;
            // Its count and links may not have been updated, so it lists the blocks up to the
            // first link that leads to no data block.
            blocks.extend(
                (1..=links).map(|index| list.link(index)).take_while(|&at| {
                    block_id(file, at).is_some_and(|id| DATA_BLOCKS.contains(&id))
                }),
            );
        } else {
            let count = list
                .data
                .get(4..8)
                .map(|bytes| u32_at(bytes, 0) as usize)
                .ok_or("bad data list block")?;
            let listed = count.min(links);
            walk.take_listed(1 + listed)?;
            blocks.extend(
                (1..=listed)
                    .map(|index| list.link(index))
                    .filter(|&at| at != 0),
            );
        }
        list_at = next_list;
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

/// The bytes of a DT block that runs to `end`, whatever its length field says.
fn open_block_payload<'a>(
    file: &'a [u8],
    at: u64,
    end: usize,
    walk: &mut Walk,
) -> Result<Cow<'a, [u8]>, &'static str> {
    let block = Block::ending_at(file, at, end).ok_or("bad data block")?;
    walk.take_data(block.data.len())?;
    Ok(Cow::Borrowed(block.data))
}

/// The bytes a data link leads to, joined into one, for variable length data whose offsets
/// count from the start of the first block.
fn joined_data<'a>(
    file: &'a [u8],
    at: u64,
    walk: &mut Walk,
) -> Result<Cow<'a, [u8]>, &'static str> {
    let blocks = data_blocks(file, at, walk)?;
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
    // Rows are rebuilt a band at a time, so that the bytes of each column for a band are read
    // from a cache line or two rather than one line per row.
    const BAND_ROWS: usize = 64;
    let rows = data.len() / columns;
    let mut out = vec![0u8; data.len()];
    let (records, rest) = out.split_at_mut(rows * columns);
    for (band_index, band) in records.chunks_mut(BAND_ROWS * columns).enumerate() {
        let first_row = band_index * BAND_ROWS;
        let band_rows = band.len() / columns;
        for (column, column_bytes) in data.chunks_exact(rows).take(columns).enumerate() {
            let column_bytes = &column_bytes[first_row..first_row + band_rows];
            for (record, &byte) in band.chunks_exact_mut(columns).zip(column_bytes) {
                record[column] = byte;
            }
        }
    }
    rest.copy_from_slice(&data[rows * columns..]);
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
    use super::parts::MAX_PARTS;
    use super::test_file::*;
    use super::*;
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    /// Parses `input` whole, checking that it reads the same in parts of any size.
    fn parse(input: &[u8]) -> (VecSink, ParseStats) {
        let (whole, stats) = parse_chunked(Mf4Parser::new(), input, usize::MAX);
        assert_parts_read_as_whole(input, &whole, &stats);
        (whole, stats)
    }

    /// Parts more than this take long to read in a debug build.
    const MAX_TEST_PARTS: usize = 3000;

    /// Reads `input` in parts of `part_bytes` of stream, as the web app's workers do. None for
    /// a file read whole, or in more than [`MAX_TEST_PARTS`] parts.
    pub(super) fn parse_in_parts(input: &[u8], part_bytes: u64) -> Option<(VecSink, ParseStats)> {
        let mut parser = Mf4Parser::new();
        let mut sink = VecSink::default();
        parser.push(input, &mut sink);
        let count = parser.plan_parts(part_bytes)?;
        if count > MAX_TEST_PARTS {
            return None;
        }
        let reads: Vec<Vec<u8>> = (0..count)
            .map(|index| {
                let task = parser.part_task(index).unwrap();
                let fetched: Vec<u8> = task
                    .ranges
                    .iter()
                    .flat_map(|&(at, end)| input[at as usize..end as usize].iter().copied())
                    .collect();
                read_part(&task.task, &fetched).expect("part read")
            })
            .collect();
        let mut needs = 0;
        while let Joined::Needs(next) = parser
            .join_part(needs, &reads[needs], &mut sink)
            .expect("part joined")
        {
            needs = next;
        }
        assert!(parser.join.is_none(), "the join is dropped once done");
        assert!(parser.part_task(0).is_none() && parser.reads_in_parts());
        parser.finish(&mut sink);
        Some((sink, parser.stats().clone()))
    }

    /// Checks that `input` reads as `whole` and `stats` in parts of many sizes, and returns how
    /// many of the sizes it was read in parts at.
    fn assert_parts_read_as_whole(input: &[u8], whole: &VecSink, stats: &ParseStats) -> usize {
        let mut in_parts = 0;
        for part_bytes in [1, 2, 3, 5, 8, 13, 40, 100, 333, 1000, 4096, 1 << 20] {
            let Some((parts, parts_stats)) = parse_in_parts(input, part_bytes) else {
                continue;
            };
            in_parts += 1;
            assert_eq!(parts.frames, whole.frames, "parts of {part_bytes}");
            assert_eq!(
                parts.remote_dlcs, whole.remote_dlcs,
                "parts of {part_bytes}"
            );
            assert_eq!(parts.channels, whole.channels, "parts of {part_bytes}");
            assert_eq!(&parts_stats, stats, "parts of {part_bytes}");
        }
        in_parts
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
        assert!(assert_parts_read_as_whole(&b.bytes, &sink, &stats) > 0);
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
    fn fields_that_start_inside_a_byte_are_read_from_their_bit_offset() {
        // The ID's 29 bits start 3 bits into its first byte, below 3 bits of other data.
        let mut b = Builder::new();
        let hd = b.header(0);
        let sd = b.variable_data(&[&[5]]);
        let records: Vec<u8> = (0..300u32)
            .flat_map(|i| {
                let id = ((0x7F0 + i % 16) << 3) | (i % 8);
                data_record(f64::from(i) / 1e3, 1, id, false, (1, 1), 0, [false; 4])
            })
            .collect();
        let mut members = data_frame_members(sd);
        members[1] = Member {
            bit_offset: 3,
            ..member("CAN_DataFrame.ID", UNSIGNED, 9, 29)
        };
        let dt = b.data_block(&records);
        let structure = b.structure("CAN_DataFrame", &members);
        let time = b.channel(&master("t", FLOAT, 0, 64), structure, 0);
        let cg = b.channel_group(0, 0, DATA_RECORD_LEN, time, 0);
        let dg = b.data_group(0, cg, dt);
        b.set_link(hd, 0, dg);

        let (sink, stats) = parse(&b.bytes);
        assert!(parse_in_parts(&b.bytes, 1000).is_some(), "read in parts");
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        let ids: Vec<u32> = sink.frames.iter().map(|frame| frame.2).collect();
        let expected: Vec<u32> = (0..300).map(|i| 0x7F0 + i % 16).collect();
        assert_eq!(ids, expected);
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
        assert_eq!(sink.remote_dlcs[..2], [Some(4), Some(0)]);
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

        let mut walk = walk_of(&b);
        let group = Block::typed(&b.bytes, dg, b"##DG").unwrap();
        let mut source = read_data_group(&b.bytes, &group, &mut walk)
            .unwrap()
            .unwrap();
        let mut stats = ParseStats::default();
        assert_eq!(source.next_time(0, &mut walk, &mut stats), Some(0));
        assert_eq!(
            source.window.held.len(),
            REORDER_WINDOW,
            "read no further than the window"
        );

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), count as usize);
        assert!(sink.frames.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    }

    fn walk_of(b: &Builder) -> Walk {
        Walk::new(b.bytes.len(), Repairs::default())
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
        let mut sources: Vec<Source<'_>> = groups
            .iter()
            .map(|&dg| {
                let group = Block::typed(&b.bytes, dg, b"##DG").unwrap();
                read_data_group(&b.bytes, &group, &mut walk)
                    .unwrap()
                    .unwrap()
            })
            .collect();
        share_reorder_window(&mut sources);
        let mut stats = ParseStats::default();
        for source in &mut sources {
            assert_eq!(source.next_time(0, &mut walk, &mut stats), Some(0));
            assert_eq!(source.window.held.len(), REORDER_WINDOW / 4);
        }

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), 4 * count as usize);
        assert!(sink.frames.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    }

    #[test]
    fn records_further_out_of_order_than_the_window_are_left_for_the_store_to_sort() {
        // Data frames from 1 ms, then a remote frame at 0 (the first of its virtual master).
        let mut b = Builder::new();
        let hd = b.header(0);
        let ms = b.linear(0.0, 0.001);
        let sd = b.variable_data(&[&[1, 2]]);
        let count = REORDER_WINDOW as u32 + 10;
        let mut records = Vec::new();
        for i in 0..count {
            records.push(1);
            let t = f64::from(i + 1) / 1000.0;
            records.extend(data_record(t, 1, 0x100, false, (2, 2), 0, [false; 4]));
        }
        records.push(2);
        records.extend_from_slice(&0x7FFu16.to_le_bytes());
        let data_structure = b.structure("CAN_DataFrame", &data_frame_members(sd));
        let data_time = b.channel(&master("t", FLOAT, 0, 64), data_structure, 0);
        let remote_members = [member("CAN_RemoteFrame.ID", UNSIGNED, 0, 16)];
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
        let remote_cg = b.channel_group(2, 0, 2, remote_time, 0);
        let data_cg = b.channel_group(1, 0, DATA_RECORD_LEN, data_time, remote_cg);
        let dt = b.data_block(&records);
        let dg = b.data_group(1, data_cg, dt);
        b.set_link(hd, 0, dg);

        let (sink, stats) = parse(&b.bytes);
        assert!(
            parse_in_parts(&b.bytes, 1 << 14).is_some(),
            "the window spans parts"
        );
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), count as usize + 1);
        let remote = sink.frames.iter().position(|frame| frame.0 == 0).unwrap();
        assert!(remote > 0, "frames were delivered before it was read");

        let mut store = can_core::FrameStore::new();
        let mut parser = Mf4Parser::new();
        parser.push(&b.bytes, &mut store);
        parser.finish(&mut store);
        store.sort_by_time();
        assert_eq!(store.len(), count as usize + 1);
        assert_eq!((store.frame(0).id, store.frame(0).ts_ns), (0x7FF, 0));
        assert!((1..store.len()).all(|i| store.frame(i - 1).ts_ns <= store.frame(i).ts_ns));
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

    /// Plans `input` in parts of `part_bytes`, checking that the plan is small and quick to
    /// make, and returns how many parts it has (0 for a file read whole).
    fn plan_of(input: &[u8], part_bytes: u64, max_parts: usize) -> usize {
        let mut parser = Mf4Parser::new();
        parser.push(input, &mut VecSink::default());
        let started = std::time::Instant::now();
        let Some(count) = parser.plan_parts(part_bytes) else {
            return 0;
        };
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(count <= max_parts, "{count} parts");
        let task_bytes: usize = (0..count)
            .map(|index| parser.part_task(index).unwrap().task.len())
            .sum();
        assert!(task_bytes < 1 << 20, "{task_bytes} bytes of tasks");
        count
    }

    /// A file whose data list links `block` `links` times, in one data group of `members`
    /// with records of `record_len` (and record IDs of 1 byte when `record_id`).
    fn fan_out(block: &[u8], links: usize, record_len: u32, record_id: bool) -> Vec<u8> {
        let mut b = Builder::new();
        let hd = b.header(0);
        let dt = b.data_block(block);
        let dl = b.data_list(&vec![dt; links]);
        let mut members = data_frame_members(0);
        members[5].cn_type = 0;
        let structure = b.structure("CAN_DataFrame", &members);
        let time = b.channel(&master("t", FLOAT, 0, 64), structure, 0);
        let id = u64::from(record_id);
        let cg = b.channel_group(id, 0, record_len, time, 0);
        let dg = b.data_group(u8::from(record_id), cg, dl);
        b.set_link(hd, 0, dg);
        b.bytes
    }

    #[test]
    fn data_lists_that_fan_out_are_planned_only_as_far_as_the_budgets_allow() {
        // A sorted group whose data list links one block 20,000 times: a read stops at the
        // frame budget, a tenth of the way into the stream.
        let records: Vec<u8> = (0..2000)
            .flat_map(|i| data_record(f64::from(i) / 1e3, 1, 0x100, false, (8, 8), 7, [false; 4]))
            .collect();
        let sorted = fan_out(&records, 20_000, DATA_RECORD_LEN, false);
        // An unsorted one whose records hold 1,000 bytes after their ID, from a block of 1 MiB
        // linked 2,000 times: a read stops at the data budget.
        let record: Vec<u8> = [
            &[1u8][..],
            &data_record(0.5, 1, 0x100, false, (8, 8), 7, [false; 4]),
        ]
        .concat();
        let mut block = Vec::new();
        while block.len() + record.len() + 1000 - DATA_RECORD_LEN as usize <= 1 << 20 {
            block.extend_from_slice(&record);
            block.resize(block.len() + 1000 - DATA_RECORD_LEN as usize, 0);
        }
        let unsorted = fan_out(&block, 2000, 1000, true);
        // Records of nothing but an ID, each rejected, until a read stops at the frame budget.
        let ids = fan_out(&[1; 1 << 20], 2000, 0, true);
        for (input, reason, part_bytes) in [
            (&sorted, "more frames than the file's size allows", 4 << 20),
            (&unsorted, "more data than the file's size allows", 4 << 20),
            (&ids, "bad time value", 1 << 18),
        ] {
            let (whole, stats) = parse_chunked(Mf4Parser::new(), input, usize::MAX);
            assert_eq!(
                stats.first_rejection.map(|(_, reason)| reason),
                Some(reason)
            );
            assert!(
                stats.lines < input.len() as u64 + 2,
                "{reason}: stopped by a budget"
            );
            let parts = plan_of(input, part_bytes, 64);
            assert!(parts > 1, "{reason}: read whole");
            plan_of(input, 1 << 16, MAX_PARTS);
            // Parts so small that there would be too many are read whole.
            assert_eq!(plan_of(input, 1, MAX_PARTS), 0);
            for part_bytes in [part_bytes, 1 << 17] {
                let (joined, joined_stats) = parse_in_parts(input, part_bytes).unwrap();
                assert_eq!(joined.frames, whole.frames, "{reason}");
                assert_eq!(joined_stats, stats, "{reason}");
            }
        }
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
    fn data_groups_that_share_a_data_list_stop_at_the_links_budget() {
        const LINKS: usize = 1 << 15;
        const DATA_GROUPS: usize = 600;
        let (mut b, group) = file_of_one_group(1);
        let dl = b.data_list(&[group.dt; LINKS]);
        b.set_link(group.dg, 2, dl);
        let channels = b.link(group.cg, 1);
        let mut previous = group.dg;
        for _ in 1..DATA_GROUPS {
            let cg = b.channel_group(0, 0, DATA_RECORD_LEN, channels, 0);
            let dg = b.data_group(0, cg, dl);
            b.set_link(previous, 0, dg);
            previous = dg;
        }
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(
            stats.first_rejection.map(|(_, reason)| reason),
            Some("more data block links than the file's size allows")
        );
        // Each data group read gives a frame per link.
        let groups_read = sink.frames.len() / LINKS;
        assert!(groups_read >= 1);
        assert!(groups_read * LINKS <= b.bytes.len() / 8);
        assert_eq!(stats.rejected, (DATA_GROUPS - groups_read) as u64);

        // Data groups that each list their own blocks fit the budget however many there are.
        let mut b = Builder::new();
        let hd = b.header(0);
        let mut previous = hd;
        for index in 0..DATA_GROUPS as u32 {
            let group = one_group(&mut b, 1, index * 2, 2);
            let half = DATA_RECORD_LEN as usize;
            let first = b.data_block(&group.records[..half]);
            let second = b.data_block(&group.records[half..]);
            let dl = b.data_list(&[first, second]);
            b.set_link(group.dg, 2, dl);
            b.set_link(previous, 0, group.dg);
            previous = group.dg;
        }
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(sink.frames.len(), 2 * DATA_GROUPS);
    }

    #[test]
    fn unfinalized_files_are_read_unless_a_flag_is_unknown() {
        let (mut b, _) = file_of_one_group(2);
        for (flags, custom_flags) in [
            (0, 0),
            (0x01 | 0x02 | 0x08 | 0x20, 0),
            (0x04 | 0x10 | 0x40, 0),
            (0, 0xFFFF),
        ] {
            unfinalize(&mut b, flags, custom_flags);
            let (sink, stats) = parse(&b.bytes);
            assert_eq!(stats.rejected, 0, "{flags:#x} {:?}", stats.first_rejection);
            assert_eq!(times(&sink), [0, 1], "{flags:#x} {custom_flags:#x}");
        }

        unfinalize(&mut b, 0x80, 0);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(
            stats.first_rejection,
            Some((
                1,
                "unfinalized MF4 file; finalize it with the logger's tool"
            ))
        );

        b.bytes[..8].copy_from_slice(FINALIZED);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "a finalized file's flags mean nothing");
        assert_eq!(times(&sink), [0, 1]);
    }

    #[test]
    fn an_unfinished_last_data_block_runs_to_the_next_block() {
        let (mut b, group) = file_of_one_group(3);
        set_length(&mut b, group.dt, 24);
        unfinalize(&mut b, 0, 0);
        let (sink, _) = parse(&b.bytes);
        assert!(
            sink.frames.is_empty(),
            "the length field is used without 0x04"
        );

        unfinalize(&mut b, 0x04, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        set_length(&mut b, group.dt, 24 + u64::from(DATA_RECORD_LEN) + 5);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        // The last block of a list, followed by the list itself, holding a record the writer
        // was stopped in the middle of.
        let (first, rest) = group.records.split_at(DATA_RECORD_LEN as usize);
        let first = b.data_block(first);
        let mut unfinished = rest.to_vec();
        unfinished.extend_from_slice(&group.records[..3]);
        let last = b.data_block(&unfinished);
        set_length(&mut b, last, 24);
        let dl = b.data_list(&[first, last]);
        b.set_link(group.dg, 2, dl);
        unfinalize(&mut b, 0, 0);
        let (sink, _) = parse(&b.bytes);
        assert_eq!(times(&sink), [0]);
        unfinalize(&mut b, 0x04, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);
    }

    #[test]
    fn an_unfinished_data_block_at_the_end_of_the_file_runs_to_it() {
        let (mut b, group) = file_of_one_group(3);
        let mut records = group.records.clone();
        records.extend_from_slice(&group.records[..10]);
        let dt = b.data_block(&records);
        b.set_link(group.dg, 2, dt);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(times(&sink), [0, 1, 2]);
        assert_eq!(stats.first_rejection, Some((4, CUT_SHORT)));

        unfinalize(&mut b, 0x04, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        set_length(&mut b, dt, u64::MAX);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);
    }

    #[test]
    fn a_length_too_short_for_its_records_is_not_kept() {
        let (mut b, group) = file_of_one_group(3);
        unfinalize(&mut b, 0x04, 0);
        set_length(&mut b, group.dt, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        // The first record starts like a block header, but its length does not fit the file.
        let first_record = group.dt as usize + BLOCK_HEADER;
        b.bytes[first_record..first_record + 4].copy_from_slice(b"##DT");
        set_length(&mut b, group.dt, BLOCK_HEADER as u64);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);
    }

    #[test]
    fn zeros_after_an_unfinished_last_data_block_are_not_records() {
        // A preallocated file: zeros follow the records written.
        let zeros = 10 * DATA_RECORD_LEN as usize;
        let (mut b, group) = file_of_one_group(3);
        let dt = b.data_block(&group.records);
        set_length(&mut b, dt, BLOCK_HEADER as u64);
        b.bytes.resize(b.bytes.len() + zeros, 0);
        b.set_link(group.dg, 2, dt);
        unfinalize(&mut b, 0x04, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        // With record IDs, where no channel group has the ID 0.
        b.bytes[group.dg as usize + BLOCK_HEADER + 4 * 8] = 1;
        let record_id_at = group.cg as usize + BLOCK_HEADER + 6 * 8;
        b.bytes[record_id_at..record_id_at + 8].copy_from_slice(&1u64.to_le_bytes());
        let records: Vec<u8> = group
            .records
            .chunks(DATA_RECORD_LEN as usize)
            .flat_map(|record| [&[1], record].concat())
            .collect();
        let dt = b.data_block(&records);
        set_length(&mut b, dt, BLOCK_HEADER as u64);
        b.bytes.resize(b.bytes.len() + zeros, 0);
        b.set_link(group.dg, 2, dt);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);
    }

    #[test]
    fn a_data_block_longer_than_a_finalized_file_rejects_its_data_group() {
        let (mut b, group) = file_of_one_group(3);
        let file_len = b.bytes.len() as u64;
        set_length(&mut b, group.dt, file_len);
        let (sink, stats) = parse(&b.bytes);
        assert!(sink.frames.is_empty());
        assert_eq!(stats.first_rejection, Some((1, "bad data block")));
        assert_eq!(stats.rejected, 2, "rejected before any frame is read");

        unfinalize(&mut b, 0x04, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);
    }

    #[test]
    fn the_links_of_a_block_read_again_are_recorded_once() {
        // 8,000 channel groups lead to one channel of 65,536 links: recorded on every read,
        // that is 524 million links. They lead past the end of the file, so that they do not
        // end the data block early.
        let (mut b, group) = file_of_one_group(3);
        let mut links: Vec<u64> = (0..1 << 16).map(|index| (1 << 40) + index * 8).collect();
        links[..3].fill(0);
        let channel = b.block(b"##CN", &links, &[0; 72]);
        let mut cg = 0;
        for _ in 0..8000 {
            cg = b.channel_group(0, 0, 8, channel, cg);
        }
        let others = b.data_group(0, cg, 0);
        b.set_link(group.dg, 0, others);
        unfinalize(&mut b, 0x04, 0);
        let started = std::time::Instant::now();
        let (sink, stats) = parse(&b.bytes);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2]);

        // Blocks that overlap hold more links than the file has room for.
        let mut file = vec![0u8; 800];
        for (at, links) in [(0usize, 97u64), (24, 94)] {
            file[at..at + 4].copy_from_slice(b"##CN");
            file[at + 8..at + 16].copy_from_slice(&(800 - at as u64).to_le_bytes());
            file[at + 16..at + 24].copy_from_slice(&links.to_le_bytes());
        }
        let repairs = Repairs {
            last_data_block: true,
            ..Repairs::default()
        };
        let mut walk = Walk::new(file.len(), repairs);
        let first = Block::at(&file, 0).unwrap();
        assert_eq!(walk.found_links(&first), Ok(()));
        assert_eq!(
            walk.found_links(&first),
            Ok(()),
            "a block read again is free"
        );
        assert_eq!(
            walk.found_links(&Block::at(&file, 24).unwrap()),
            Err("more links than the file's size allows")
        );
    }

    #[test]
    fn the_last_data_list_of_an_unfinalized_file_reads_the_links_it_has() {
        let (mut b, group) = file_of_one_group(4);
        let (first, second) = group.records.split_at(2 * DATA_RECORD_LEN as usize);
        let first = b.data_block(first);
        let second = b.data_block(second);
        // The count was not updated after the first block, and a link is left for a block
        // not yet written.
        let dl = b.data_list(&[first, second, 0]);
        set_count(&mut b, dl, 4, 1);
        b.set_link(group.dg, 2, dl);
        unfinalize(&mut b, 0, 0);
        let (sink, _) = parse(&b.bytes);
        assert_eq!(times(&sink), [0, 1]);
        unfinalize(&mut b, 0x10, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2, 3]);

        // A count past the links written, which end at one past the end of the file.
        let dl = b.data_list(&[first, second, 1 << 40, first]);
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2, 3]);

        // A stale link to a block that is not a data block.
        let dl = b.data_list(&[first, second, group.cg]);
        b.set_link(group.dg, 2, dl);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2, 3]);

        // A list before the last keeps to its count.
        let last = b.data_list(&[second, 0]);
        set_count(&mut b, last, 3, 0);
        let earlier = b.data_list(&[first, first]);
        set_count(&mut b, earlier, 3, 1);
        b.set_link(earlier, 0, last);
        b.set_link(group.dg, 2, earlier);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(times(&sink), [0, 1, 2, 3]);
    }

    #[test]
    fn unwritten_vlsd_offsets_follow_the_order_of_the_values() {
        let mut b = Builder::new();
        let hd = b.header(0);
        let vlsd_cg = b.channel_group(9, VLSD_GROUP, 0, 0, 0);
        let structure = b.structure("CAN_DataFrame", &data_frame_members(vlsd_cg));
        let time = b.channel(&master("t", FLOAT, 0, 64), structure, 0);
        let data_cg = b.channel_group(1, 0, DATA_RECORD_LEN, time, vlsd_cg);
        let values: [&[u8]; 3] = [&[1, 2, 3], &[4, 5], &[6]];
        let mut records = Vec::new();
        for (index, value) in values.iter().enumerate() {
            records.push(9);
            records.extend(variable_records(&[value]));
            records.push(1);
            let len = value.len() as u8;
            let t = index as f64 / 1000.0;
            records.extend(data_record(t, 1, 0x100, false, (len, len), 0, [false; 4]));
        }
        let dt = b.data_block(&records);
        let dg = b.data_group(1, data_cg, dt);
        b.set_link(hd, 0, dg);
        let data = |sink: &VecSink| -> Vec<Vec<u8>> {
            sink.frames.iter().map(|frame| frame.4.clone()).collect()
        };

        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(data(&sink), [vec![1, 2, 3], vec![1, 2], vec![1]]);

        unfinalize(&mut b, 0x40, 0);
        let (sink, stats) = parse(&b.bytes);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(data(&sink), [vec![1, 2, 3], vec![4, 5], vec![6]]);
    }

    #[test]
    fn the_file_buffer_is_sized_from_the_expected_bytes() {
        let (b, _) = file_of_one_group(3);
        let len = b.bytes.len();
        for hint in [len, len / 2, 0] {
            let mut parser = Mf4Parser::new();
            parser.expect_bytes(hint as u64);
            assert_eq!(parser.file.capacity(), hint);
            let mut sink = VecSink::default();
            for chunk in b.bytes.chunks(7) {
                parser.push(chunk, &mut sink);
            }
            if hint == len {
                assert_eq!(parser.file.capacity(), len, "an exact hint never regrows");
            }
            parser.finish(&mut sink);
            assert_eq!(parser.stats().rejected, 0, "hint {hint}");
            assert_eq!(times(&sink), [0, 1, 2], "hint {hint}");
        }

        let mut parser = Mf4Parser::new();
        parser.expect_bytes(MAX_FILE as u64 + 1);
        assert_eq!(
            parser.file.capacity(),
            0,
            "a file too large to read reserves nothing"
        );
        parser.expect_bytes(u64::MAX);
        assert_eq!(parser.file.capacity(), 0);
    }

    #[test]
    fn untransposing_restores_the_records() {
        let records: Vec<u8> = (0..23).collect();
        assert_eq!(untranspose(&transpose(&records, 5), 5), records);
        assert_eq!(untranspose(&transpose(&records, 23), 23), records);
        assert_eq!(untranspose(&records, 0), records);
        // Bands of rows, and the rows past the last full band, with bytes left over.
        for rows in [63, 64, 65, 128, 130, 200] {
            for columns in [1, 3, 7, 28] {
                let records: Vec<u8> = (0..rows * columns + 5).map(|i| (i * 7) as u8).collect();
                let restored = untranspose(&transpose(&records, columns), columns);
                assert_eq!(restored, records, "{rows} rows of {columns}");
            }
        }
    }
}
