//! Vector BLF, the binary log of CANoe and CANalyzer.
//!
//! A file is a 144-byte header (`LOGG`) followed by objects, each with an `LOBJ` header
//! giving its size, type and timestamp. Most files pack the objects into log containers
//! (type 10), zlib-compressed, and an object may continue from one container into the next,
//! so the objects inside containers form a second stream with its own carry-over. CAN
//! frames come as the message objects 1 and 86, CAN FD as 100 and 101, and error frames as
//! 2, 73 and 104; every other object type is skipped.
//!
//! A large file can be read in parts, cut where an object of the file ends ([`ObjectEnds`]),
//! each by a parser of its own ([`BlfParser::start_part`]). The objects inside log containers
//! run on from part to part, so a part keeps the bytes before the first object it can tell
//! starts one, and those it leaves at its end, for [`InnerJoin`] to read with the parts on
//! either side.

use can_core::{flags, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};

use crate::text::{dlc_to_len, unix_ns, ChannelName};
use crate::{push_frame, LogParser, ParseStats};

const FILE_SIGNATURE: &[u8; 4] = b"LOGG";
const OBJECT_SIGNATURE: &[u8; 4] = b"LOBJ";
/// Up to the end of the end-time field; the rest of the 144 bytes is unused.
const MIN_FILE_HEADER: usize = 72;
const MAX_FILE_HEADER: usize = 4096;
/// The `LOBJ` signature, header size, header version, object size and type.
const BASE_HEADER: usize = 16;
/// A header of this size or more carries flags and a timestamp.
const TIMESTAMPED_HEADER: usize = 32;
/// Containers are written at around 128 KiB; this bounds what is buffered for one object.
const MAX_OBJECT: usize = 32 << 20;
const MAX_UNCOMPRESSED: usize = 64 << 20;
/// An object is followed by up to 3 bytes of padding: its size mod 4 as CANoe writes it, or
/// what aligns the next object to 4 bytes as some other writers do.
const MAX_PADDING: usize = 3;

const LOG_CONTAINER: u32 = 10;
const CAN_MESSAGE: u32 = 1;
const CAN_ERROR: u32 = 2;
const CAN_ERROR_EXT: u32 = 73;
const CAN_MESSAGE2: u32 = 86;
const CAN_FD_MESSAGE: u32 = 100;
const CAN_FD_MESSAGE_64: u32 = 101;
const CAN_FD_ERROR_64: u32 = 104;

const ZLIB: u16 = 2;
const UNCOMPRESSED: u16 = 0;

/// Object timestamps are in nanoseconds unless this flag asks for 10 microsecond units.
const TEN_MICROSECOND_UNITS: u32 = 1;

const NOT_A_BLF_FILE: &str = "not a BLF file (no LOGG signature)";
const TRUNCATED: &str = "file ends inside an object";

#[derive(Debug, Default)]
pub struct BlfParser {
    stats: ParseStats,
    header: FileHeader,
    outer: ObjectStream,
    inner: ObjectStream,
    /// Set for a parser reading a part of the file, from where an object ends.
    part: Option<PartStart>,
}

/// The start of the objects in log containers of a part read by a parser of its own. Its first
/// bytes may end an object begun in the part before, so they are kept until an object start
/// is found, from which the part's own objects are read.
#[derive(Debug, Default)]
struct PartStart {
    prefix: Vec<u8>,
    /// Where in `prefix` to look on for an object start.
    searched: usize,
    synced: bool,
    /// The header of the object the part read on from.
    start: Vec<u8>,
    /// What the part read outside log containers before it found an object start in them.
    early: Early,
}

/// Frames and rejections a part read outside log containers before it read the objects in
/// them, which [`InnerJoin::join`] puts after those it reads from the part's [`PartEdges`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Early {
    pub frames: bool,
    pub rejections: bool,
}

impl Early {
    fn of(stats: &ParseStats) -> Self {
        Self {
            frames: stats.frames > 0,
            rejections: stats.rejected > 0,
        }
    }
}

/// What a part of a file read by a parser of its own leaves of the objects in log containers,
/// for [`InnerJoin::join`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartEdges {
    /// The bytes before the first object the part read, or all of them if it found none.
    pub prefix: Vec<u8>,
    /// The part read on from the end of `prefix`, which starts an object.
    pub synced: bool,
    /// The header of that object.
    pub start: Vec<u8>,
    /// What the part read outside log containers before the objects in them.
    pub early: Early,
    /// The bytes at the end that start an object not yet complete, or might start one.
    pub carry: Vec<u8>,
    /// Bytes dropped since the last object while looking for the next.
    pub gap: u64,
}

#[derive(Debug, Default)]
struct FileHeader {
    pending: Vec<u8>,
    state: HeaderState,
    start_ns: i64,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum HeaderState {
    #[default]
    Reading,
    Done,
    Unreadable,
}

/// Splits a byte stream into `LOBJ` objects, carrying a partial object to the next push.
#[derive(Debug, Default)]
struct ObjectStream {
    carry: Vec<u8>,
    /// Bytes dropped since the last object while looking for the next signature.
    gap: usize,
    /// Bytes pushed so far.
    pushed: u64,
}

struct Object<'a> {
    kind: u32,
    flags: u32,
    timestamp: u64,
    body: &'a [u8],
    /// Where the object ends in the stream.
    end: u64,
}

struct Frame {
    channel: u16,
    id: u32,
    flags: u8,
    len: usize,
    data: [u8; MAX_PAYLOAD],
    remote_dlc: Option<u8>,
}

impl BlfParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the rest of the file can be read in parts from here, each by a parser of its
    /// own: the header is read and the bytes pushed end where an object ends.
    #[must_use]
    pub fn splittable(&self) -> bool {
        self.header.state == HeaderState::Done && self.outer.carry.is_empty() && self.outer.gap == 0
    }

    /// What the header set that the objects after it are read by: the start time.
    #[must_use]
    pub fn state(&self) -> String {
        match self.header.state {
            HeaderState::Done => format!("start {}", self.header.start_ns),
            _ => String::new(),
        }
    }

    /// Readies the parser to read a part of the file from where one of its objects ends:
    /// reads the header from `head`, the start of the file, then counts records, bytes and
    /// rejections from zero. The part's objects in log containers are read from the first
    /// that can be told to start one; the bytes before it, and what the part leaves at its
    /// end, are given by [`BlfParser::part_edges`] once it is read.
    pub fn start_part(&mut self, head: &[u8]) {
        let size = if head.len() >= 8 {
            u32_at(head, 4) as usize
        } else {
            head.len()
        };
        let mut stats = ParseStats::default();
        self.header.take(&head[..size.min(head.len())], &mut stats);
        self.stats = ParseStats::default();
        self.part = Some(PartStart::default());
    }

    /// The edges of a part read since [`BlfParser::start_part`] and finished.
    pub fn part_edges(&mut self) -> Option<PartEdges> {
        let part = self.part.as_mut()?;
        let early = if part.synced {
            part.early
        } else {
            Early::of(&self.stats)
        };
        Some(PartEdges {
            prefix: std::mem::take(&mut part.prefix),
            synced: part.synced,
            start: std::mem::take(&mut part.start),
            early,
            carry: std::mem::take(&mut self.inner.carry),
            gap: self.inner.gap as u64,
        })
    }

    /// Takes the objects in log containers not yet read, for the parts read after this
    /// parser's bytes to join on to.
    pub fn take_inner_join(&mut self) -> InnerJoin {
        InnerJoin {
            stream: std::mem::take(&mut self.inner),
            start_ns: self.header.start_ns,
        }
    }
}

impl LogParser for BlfParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        self.stats.bytes += chunk.len() as u64;
        let rest = self.header.take(chunk, &mut self.stats);
        if rest.is_empty() || self.header.state != HeaderState::Done {
            return;
        }
        let (inner, part, start_ns) = (&mut self.inner, &mut self.part, self.header.start_ns);
        self.outer.push(rest, &mut self.stats, |object, stats| {
            if object.kind != LOG_CONTAINER {
                frame_object(&object, start_ns, stats, sink);
                return;
            }
            let payload = match container_payload(object.body) {
                Ok(payload) => payload,
                Err(reason) => {
                    stats.lines += 1;
                    stats.reject(reason);
                    return;
                }
            };
            let objects = match part {
                Some(part) if !part.synced => match part.sync(&payload, Early::of(stats)) {
                    Some(objects) => std::borrow::Cow::Owned(objects),
                    None => return,
                },
                _ => payload,
            };
            inner.push(&objects, stats, |object, stats| {
                frame_object(&object, start_ns, stats, sink);
            });
        });
    }

    fn finish<S: FrameSink>(&mut self, _sink: &mut S) {
        if self.header.state == HeaderState::Reading {
            self.header.state = HeaderState::Unreadable;
            self.stats.lines += 1;
            self.stats.reject(if self.header.pending.len() < 4 {
                NOT_A_BLF_FILE
            } else {
                "file shorter than the BLF header"
            });
        }
        self.outer.finish(&mut self.stats);
        // A part's last objects may run on into the next part.
        if self.part.is_none() {
            self.inner.finish(&mut self.stats);
        }
    }

    fn stats(&self) -> &ParseStats {
        &self.stats
    }
}

impl PartStart {
    /// Adds the payload of the next log container. Once an object start is found, returns the
    /// bytes from it, for the part to read; `early` is what the part read outside log
    /// containers before then.
    fn sync(&mut self, payload: &[u8], early: Early) -> Option<Vec<u8>> {
        self.prefix.extend_from_slice(payload);
        match object_start(&self.prefix, self.searched) {
            Ok(at) => {
                self.synced = true;
                self.early = early;
                let objects = self.prefix.split_off(at);
                self.start = objects[..BASE_HEADER].to_vec();
                Some(objects)
            }
            Err(from) => {
                self.searched = from;
                None
            }
        }
    }
}

/// The first place in `bytes`, from `from`, that starts an object longer than its header and
/// followed by another, or where to look on from once there are more bytes. Bytes inside an
/// object may look like the start of one; [`InnerJoin::join`] refuses a part whose guess was
/// wrong.
fn object_start(bytes: &[u8], mut from: usize) -> Result<usize, usize> {
    loop {
        let Some(found) = memchr::memmem::find(&bytes[from..], OBJECT_SIGNATURE) else {
            return Err(bytes
                .len()
                .saturating_sub(OBJECT_SIGNATURE.len() - 1)
                .max(from));
        };
        let at = from + found;
        let rest = &bytes[at..];
        if rest.len() < BASE_HEADER {
            return Err(at);
        }
        let header_size = usize::from(u16_at(rest, 4));
        let object_size = u32_at(rest, 8) as usize;
        if header_size >= BASE_HEADER
            && (header_size..=MAX_OBJECT).contains(&object_size)
            && object_size > BASE_HEADER
        {
            let next = at + object_size;
            let seen = next + MAX_PADDING + OBJECT_SIGNATURE.len();
            if bytes.len() < seen {
                return Err(at);
            }
            if memchr::memmem::find(&bytes[next..seen], OBJECT_SIGNATURE).is_some() {
                return Ok(at);
            }
        }
        from = at + 1;
    }
}

/// The objects in log containers of a file read in parts, joined across the parts: each
/// part's [`PartEdges`] are read with what the parts before it left.
#[derive(Debug, Default)]
pub struct InnerJoin {
    stream: ObjectStream,
    start_ns: i64,
}

impl InnerJoin {
    /// Reads the bytes a part left before its first object, completing an object the parts
    /// before it began, then carries on from what the part left at its end. Returns what the
    /// bytes read here counted, which come before the part's own, or `None` when the part was
    /// not read as it would be in the whole file: it took bytes inside an object for the
    /// start of one, or read frames outside log containers that would then come out of order.
    /// `rejected_before` tells whether the log has a rejection before the part, so that the
    /// order of the rejections read here and the part's early ones changes nothing.
    pub fn join<S: FrameSink>(
        &mut self,
        edges: &PartEdges,
        rejected_before: bool,
        sink: &mut S,
    ) -> Option<ParseStats> {
        let mut stats = ParseStats::default();
        let start_ns = self.start_ns;
        self.stream
            .push(&edges.prefix, &mut stats, |object, stats| {
                frame_object(&object, start_ns, stats, sink);
            });
        if edges.synced {
            // The part read on from an object start with nothing carried. So does the whole
            // file if, given that object's header, what is carried here leaves just the
            // header carried, having found no object, only stray bytes or bad headers.
            let frames = stats.frames;
            self.stream.push(&edges.start, &mut stats, |object, stats| {
                frame_object(&object, start_ns, stats, sink);
            });
            if stats.frames != frames || self.stream.carry != edges.start || self.stream.gap != 0 {
                return None;
            }
            self.stream = ObjectStream {
                carry: edges.carry.clone(),
                gap: usize::try_from(edges.gap).ok()?,
                pushed: edges.carry.len() as u64,
            };
        }
        let early = edges.early;
        let in_order = stats.lines == 0
            || early == Early::default()
            || (rejected_before && !(early.frames && stats.frames > 0));
        in_order.then_some(stats)
    }

    /// The end of the file: an object left incomplete is cut short.
    #[must_use]
    pub fn finish(mut self) -> ParseStats {
        let mut stats = ParseStats::default();
        self.stream.finish(&mut stats);
        stats
    }
}

/// Finds where the objects of a BLF file end, as [`BlfParser`] reads them, without reading
/// what is in them: the places the file can be cut into parts.
#[derive(Debug, Default)]
pub struct ObjectEnds {
    header: FileHeader,
    header_bytes: u64,
    stream: ObjectStream,
    stats: ParseStats,
}

impl ObjectEnds {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next bytes of the file, from its start, and calls `on_end` with the offset in
    /// the file where each object ending in them ends.
    pub fn push(&mut self, chunk: &[u8], mut on_end: impl FnMut(u64)) {
        let rest = self.header.take(chunk, &mut self.stats);
        if self.header.state != HeaderState::Done {
            self.header_bytes += chunk.len() as u64;
            return;
        }
        self.header_bytes += (chunk.len() - rest.len()) as u64;
        let header_bytes = self.header_bytes;
        self.stream.push(rest, &mut self.stats, |object, _| {
            on_end(header_bytes + object.end);
        });
    }
}

impl FileHeader {
    /// Takes the header's bytes from the front of `chunk` and returns what follows them.
    fn take<'a>(&mut self, chunk: &'a [u8], stats: &mut ParseStats) -> &'a [u8] {
        if self.state != HeaderState::Reading {
            return chunk;
        }
        let mut rest = chunk;
        while self.state == HeaderState::Reading && !rest.is_empty() {
            let needed = if self.pending.len() < 8 {
                8
            } else {
                u32_at(&self.pending, 4) as usize
            };
            let take = (needed - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() < needed {
                continue;
            }
            if self.pending.len() == 8 {
                let size = u32_at(&self.pending, 4) as usize;
                if !self.pending.starts_with(FILE_SIGNATURE)
                    || !(MIN_FILE_HEADER..=MAX_FILE_HEADER).contains(&size)
                {
                    self.state = HeaderState::Unreadable;
                    stats.lines += 1;
                    stats.reject(NOT_A_BLF_FILE);
                }
                continue;
            }
            self.start_ns = system_time_ns(&self.pending[40..56]).unwrap_or(0);
            self.pending = Vec::new();
            self.state = HeaderState::Done;
        }
        rest
    }
}

/// A Windows SYSTEMTIME as nanoseconds since the Unix epoch, taken as UTC, or `None` when
/// it is unset.
fn system_time_ns(bytes: &[u8]) -> Option<i64> {
    let field = |i: usize| i64::from(u16_at(bytes, i * 2));
    let (year, month, day) = (field(0), field(1), field(3));
    let (hour, minute, second, milli) = (field(4), field(5), field(6), field(7));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let ns_of_day = ((hour * 60 + minute) * 60 + second) * 1_000_000_000 + milli * 1_000_000;
    unix_ns(year, month as u32, day as u32, ns_of_day)
}

impl ObjectStream {
    fn push(
        &mut self,
        data: &[u8],
        stats: &mut ParseStats,
        mut on_object: impl FnMut(Object<'_>, &mut ParseStats),
    ) {
        let data_at = self.pushed;
        self.pushed += data.len() as u64;
        let mut carry_at = data_at - self.carry.len() as u64;
        let mut rest = data;
        // Complete the carried object from the front of `data`, taking no more than it
        // needs, before reading the rest of `data` in place.
        while !self.carry.is_empty() {
            let wanted = self.carried_object_size().saturating_sub(self.carry.len());
            let take = wanted.min(rest.len());
            self.carry.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if take < wanted {
                return;
            }
            let mut carried = std::mem::take(&mut self.carry);
            let used = self.consume(&carried, carry_at, stats, &mut on_object);
            carried.drain(..used);
            carry_at += used as u64;
            self.carry = carried;
        }
        let rest_at = self.pushed - rest.len() as u64;
        let used = self.consume(rest, rest_at, stats, &mut on_object);
        self.carry.extend_from_slice(&rest[used..]);
    }

    /// How many bytes the carried bytes need to become something `consume` can act on: the
    /// whole object when its header is there and sane, else enough to read a header.
    fn carried_object_size(&self) -> usize {
        let carry = &self.carry;
        if carry.len() < BASE_HEADER {
            return BASE_HEADER;
        }
        let header_size = usize::from(u16_at(carry, 4));
        let object_size = u32_at(carry, 8) as usize;
        let sane = carry.starts_with(OBJECT_SIGNATURE)
            && header_size >= BASE_HEADER
            && (header_size..=MAX_OBJECT).contains(&object_size);
        if sane {
            object_size
        } else {
            carry.len()
        }
    }

    fn finish(&mut self, stats: &mut ParseStats) {
        if self.carry.starts_with(OBJECT_SIGNATURE) {
            stats.lines += 1;
            stats.reject(TRUNCATED);
        }
        self.carry = Vec::new();
    }

    /// Delivers every complete object in `data`, which starts at `data_at` in the stream, and
    /// returns how much of it was used. What is left is a partial object, or a few bytes that
    /// might start one.
    fn consume(
        &mut self,
        data: &[u8],
        data_at: u64,
        stats: &mut ParseStats,
        on_object: &mut impl FnMut(Object<'_>, &mut ParseStats),
    ) -> usize {
        let mut pos = 0;
        loop {
            let Some(skipped) = memchr::memmem::find(&data[pos..], OBJECT_SIGNATURE) else {
                let kept = (data.len() - pos).min(OBJECT_SIGNATURE.len() - 1);
                self.gap += data.len() - pos - kept;
                return data.len() - kept;
            };
            if self.gap + skipped > MAX_PADDING {
                stats.lines += 1;
                stats.reject("stray bytes between objects");
            }
            self.gap = 0;
            pos += skipped;
            let rest = &data[pos..];
            if rest.len() < BASE_HEADER {
                return pos;
            }
            let header_size = usize::from(u16_at(rest, 4));
            let object_size = u32_at(rest, 8) as usize;
            if header_size < BASE_HEADER || object_size < header_size || object_size > MAX_OBJECT {
                stats.lines += 1;
                stats.reject("bad object header");
                pos += OBJECT_SIGNATURE.len();
                continue;
            }
            if rest.len() < object_size {
                return pos;
            }
            let (flags, timestamp) = if header_size >= TIMESTAMPED_HEADER {
                (u32_at(rest, 16), u64_at(rest, 24))
            } else {
                (0, 0)
            };
            on_object(
                Object {
                    kind: u32_at(rest, 12),
                    flags,
                    timestamp,
                    body: &rest[header_size..object_size],
                    end: data_at + (pos + object_size) as u64,
                },
                stats,
            );
            pos += object_size;
        }
    }
}

/// The objects a log container holds, inflated if the container is compressed.
fn container_payload(body: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>, &'static str> {
    if body.len() < 16 {
        return Err("log container too short");
    }
    let uncompressed_size = u32_at(body, 8) as usize;
    let payload = &body[16..];
    match u16_at(body, 0) {
        UNCOMPRESSED => Ok(payload.into()),
        ZLIB => {
            if uncompressed_size > MAX_UNCOMPRESSED {
                return Err("log container too large");
            }
            miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(payload, uncompressed_size)
                .map(Into::into)
                .map_err(|_| "log container does not inflate")
        }
        _ => Err("log container with an unknown compression"),
    }
}

fn frame_object<S: FrameSink>(
    object: &Object<'_>,
    start_ns: i64,
    stats: &mut ParseStats,
    sink: &mut S,
) {
    let frame = match object.kind {
        CAN_MESSAGE | CAN_MESSAGE2 => can_message(object.body),
        CAN_ERROR => can_error(object.body),
        CAN_ERROR_EXT => can_error_ext(object.body),
        CAN_FD_MESSAGE => can_fd_message(object.body),
        CAN_FD_MESSAGE_64 => can_fd_message_64(object.body),
        CAN_FD_ERROR_64 => can_fd_error_64(object.body),
        _ => return,
    };
    stats.lines += 1;
    let unit = if object.flags & TEN_MICROSECOND_UNITS != 0 {
        10_000
    } else {
        1
    };
    let ts_ns = i64::try_from(object.timestamp)
        .ok()
        .and_then(|t| t.checked_mul(unit))
        .and_then(|t| t.checked_add(start_ns));
    match (frame, ts_ns) {
        (Err(reason), _) => stats.reject(reason),
        (Ok(_), None) => stats.reject("timestamp out of range"),
        (Ok(frame), Some(ts_ns)) => {
            stats.frames += 1;
            let channel = sink.channel_index(ChannelName::new(u64::from(frame.channel)).as_bytes());
            let pushed = FrameRef {
                ts_ns,
                channel,
                id: frame.id,
                flags: frame.flags,
                data: &frame.data[..frame.len],
            };
            push_frame(sink, pushed, frame.remote_dlc);
        }
    }
}

impl Frame {
    fn new(channel: u16, id: u32, flags: u8) -> Self {
        Frame {
            channel,
            id,
            flags,
            len: 0,
            data: [0; MAX_PAYLOAD],
            remote_dlc: None,
        }
    }

    fn error(channel: u16) -> Self {
        Frame::new(channel, ERR_FLAG, flags::ERROR)
    }

    fn with_data(mut self, bytes: &[u8], len: usize) -> Self {
        self.len = len.min(bytes.len()).min(MAX_PAYLOAD);
        self.data[..self.len].copy_from_slice(&bytes[..self.len]);
        self
    }
}

/// Bit 31 of a message object's ID marks a 29-bit ID.
fn frame_id(raw: u32) -> u32 {
    let id = raw & 0x1FFF_FFFF;
    if raw & 0x8000_0000 != 0 || id > 0x7FF {
        id | EXT_FLAG
    } else {
        id
    }
}

/// Direction and remote bits shared by the message objects with a one-byte flags field.
fn message_flags(raw: u8) -> u8 {
    let mut flags = 0;
    if raw & 0x01 != 0 {
        flags |= flags::TX;
    }
    if raw & 0x80 != 0 {
        flags |= flags::RTR;
    }
    flags
}

/// CAN_MESSAGE and CAN_MESSAGE2: channel, flags, DLC, ID and 8 data bytes.
fn can_message(body: &[u8]) -> Result<Frame, &'static str> {
    if body.len() < 16 {
        return Err("CAN message object too short");
    }
    let mut frame = Frame::new(
        u16_at(body, 0),
        frame_id(u32_at(body, 4)),
        message_flags(body[2]),
    );
    let len = if frame.flags & flags::RTR != 0 {
        frame.remote_dlc = Some(body[3] & 0x0F);
        0
    } else {
        usize::from(body[3]).min(8)
    };
    Ok(frame.with_data(&body[8..16], len))
}

/// CAN_ERROR: channel and length.
fn can_error(body: &[u8]) -> Result<Frame, &'static str> {
    if body.len() < 4 {
        return Err("CAN error object too short");
    }
    Ok(Frame::error(u16_at(body, 0)))
}

/// CAN_ERROR_EXT: channel, length, flags, ECC, position, DLC, frame length, ID, extended
/// flags and the 8 data bytes of the frame the error hit.
fn can_error_ext(body: &[u8]) -> Result<Frame, &'static str> {
    if body.len() < 32 {
        return Err("CAN error object too short");
    }
    Ok(Frame::error(u16_at(body, 0)).with_data(&body[24..32], usize::from(body[10]).min(8)))
}

/// CAN_FD_ERROR_64: channel, DLC, valid bytes, ECC, flags, extended error code, FD flags,
/// extended data offset, ID, frame length, bit timing, offsets, CRC, error position, then
/// the data bytes of the frame the error hit.
fn can_fd_error_64(body: &[u8]) -> Result<Frame, &'static str> {
    if body.len() < 44 {
        return Err("CAN error object too short");
    }
    let mut frame = Frame::error(u16::from(body[0]));
    let fd_flags = u16_at(body, 8);
    if fd_flags & 0x80 != 0 {
        frame.flags |= flags::FD;
        if fd_flags & 0x40 != 0 {
            frame.flags |= flags::BRS;
        }
        if fd_flags & 0x20 != 0 {
            frame.flags |= flags::ESI;
        }
    }
    let len = usize::from(body[2]).min(MAX_PAYLOAD);
    if body.len() < 44 + len {
        return Err("CAN error object too short");
    }
    Ok(frame.with_data(&body[44..], len))
}

/// CAN_FD_MESSAGE: channel, flags, DLC, ID, frame length, bit count, FD flags, valid bytes
/// and 64 data bytes.
fn can_fd_message(body: &[u8]) -> Result<Frame, &'static str> {
    if body.len() < 20 {
        return Err("CAN FD message object too short");
    }
    let mut frame = Frame::new(
        u16_at(body, 0),
        frame_id(u32_at(body, 4)),
        message_flags(body[2]),
    );
    let fd_flags = body[13];
    let dlc = body[3];
    let len = if frame.flags & flags::RTR != 0 {
        frame.remote_dlc = Some(dlc & 0x0F);
        0
    } else if fd_flags & 0x01 != 0 {
        frame.flags |= flags::FD;
        if fd_flags & 0x02 != 0 {
            frame.flags |= flags::BRS;
        }
        if fd_flags & 0x04 != 0 {
            frame.flags |= flags::ESI;
        }
        dlc_to_len(dlc)
    } else {
        usize::from(dlc).min(8)
    };
    if body.len() < 20 + len {
        return Err("CAN FD message object too short");
    }
    Ok(frame.with_data(&body[20..], len))
}

/// CAN_FD_MESSAGE_64: channel, DLC, valid bytes, transmit count, ID, frame length, flags,
/// bit timing, offsets, bit count, direction, extended data offset, CRC, then the data.
fn can_fd_message_64(body: &[u8]) -> Result<Frame, &'static str> {
    if body.len() < 40 {
        return Err("CAN FD message object too short");
    }
    let raw_flags = u32_at(body, 12);
    let mut frame = Frame::new(u16::from(body[0]), frame_id(u32_at(body, 4)), 0);
    if body[34] != 0 {
        frame.flags |= flags::TX;
    }
    let dlc = body[1];
    let valid_bytes = usize::from(body[2]);
    let len = if raw_flags & 0x10 != 0 {
        frame.flags |= flags::RTR;
        frame.remote_dlc = Some(dlc & 0x0F);
        0
    } else if raw_flags & 0x1000 != 0 {
        frame.flags |= flags::FD;
        if raw_flags & 0x2000 != 0 {
            frame.flags |= flags::BRS;
        }
        if raw_flags & 0x4000 != 0 {
            frame.flags |= flags::ESI;
        }
        dlc_to_len(dlc).min(valid_bytes)
    } else {
        usize::from(dlc).min(8).min(valid_bytes)
    };
    if body.len() < 40 + len {
        return Err("CAN FD message object too short");
    }
    Ok(frame.with_data(&body[40..], len))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{assert_chunking_does_not_matter, parse_chunked, VecSink};

    const NS: u32 = 2;

    /// A file header with the given start time, the rest of the fields zero.
    fn file_header(start: Option<[u16; 8]>) -> Vec<u8> {
        let mut header = vec![0u8; 144];
        header[..4].copy_from_slice(FILE_SIGNATURE);
        header[4..8].copy_from_slice(&144u32.to_le_bytes());
        if let Some(start) = start {
            for (i, field) in start.iter().enumerate() {
                header[40 + i * 2..42 + i * 2].copy_from_slice(&field.to_le_bytes());
            }
        }
        header
    }

    /// An object with a version 1 header, padded to 4 bytes.
    fn object(kind: u32, flags: u32, timestamp: u64, body: &[u8]) -> Vec<u8> {
        let size = 32 + body.len();
        let mut out = Vec::with_capacity(size + 3);
        out.extend_from_slice(OBJECT_SIGNATURE);
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&timestamp.to_le_bytes());
        out.extend_from_slice(body);
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
        out
    }

    fn container(compression: u16, payload: &[u8]) -> Vec<u8> {
        let data = match compression {
            ZLIB => miniz_oxide::deflate::compress_to_vec_zlib(payload, 6),
            _ => payload.to_vec(),
        };
        raw_container(compression, &data, payload.len())
    }

    /// A container holding `data` as written, whatever it claims to be.
    fn raw_container(compression: u16, data: &[u8], uncompressed_size: usize) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&compression.to_le_bytes());
        body.extend_from_slice(&[0; 6]);
        body.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(data);
        let size = 16 + body.len();
        let mut out = Vec::new();
        out.extend_from_slice(OBJECT_SIGNATURE);
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&LOG_CONTAINER.to_le_bytes());
        out.extend_from_slice(&body);
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
        out
    }

    fn can_message_body(channel: u16, flags: u8, dlc: u8, id: u32, data: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&channel.to_le_bytes());
        body.push(flags);
        body.push(dlc);
        body.extend_from_slice(&id.to_le_bytes());
        body.extend_from_slice(data);
        body.resize(16, 0);
        body
    }

    fn can_fd_message_body(fd_flags: u8, dlc: u8, data: &[u8]) -> Vec<u8> {
        let mut body = can_message_body(1, 0, dlc, 0x123, &[]);
        body.truncate(8);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.push(0);
        body.push(fd_flags);
        body.push(data.len() as u8);
        body.push(0);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(data);
        body.resize(84, 0);
        body
    }

    fn can_fd_message_64_body(flags: u32, dir: u8, dlc: u8, data: &[u8]) -> Vec<u8> {
        let mut body = vec![2, dlc, data.len() as u8, 0];
        body.extend_from_slice(&0x18FE_F100u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&flags.to_le_bytes());
        body.extend_from_slice(&[0; 16]);
        body.extend_from_slice(&0u16.to_le_bytes());
        body.push(dir);
        body.push(0);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(data);
        body
    }

    fn can_fd_error_64_body(channel: u8, fd_flags: u16, data: &[u8]) -> Vec<u8> {
        let mut body = vec![channel, 15, data.len() as u8, 0];
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&fd_flags.to_le_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&0x18FE_F100u32.to_le_bytes());
        body.extend_from_slice(&[0; 24]);
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(data);
        body.resize(body.len() + 8, 0);
        body
    }

    fn parse(input: &[u8]) -> (VecSink, ParseStats) {
        parse_chunked(BlfParser::new(), input, usize::MAX)
    }

    fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn classic_messages_with_a_start_time() {
        let file = concat(&[
            file_header(Some([2025, 9, 2, 30, 12, 0, 0, 500])),
            object(
                CAN_MESSAGE,
                TEN_MICROSECOND_UNITS,
                100,
                &can_message_body(1, 0, 3, 0x123, &[1, 2, 3]),
            ),
            object(
                CAN_MESSAGE2,
                NS,
                2_000_000,
                &can_message_body(2, 0x01, 8, 0x18FE_F100 | 0x8000_0000, &[0; 8]),
            ),
            object(
                CAN_MESSAGE,
                NS,
                3_000_000,
                &can_message_body(1, 0x80, 2, 0x7FF, &[0xAA, 0xBB]),
            ),
            object(999, NS, 4_000_000, &[0; 20]),
        ]);
        let (sink, stats) = parse(&file);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!((stats.lines, stats.frames), (3, 3));
        assert_eq!(sink.channels, [b"can1".to_vec(), b"can2".to_vec()]);
        let start_ns = 1_759_233_600_500_000_000;
        assert_eq!(
            sink.frames[0],
            (start_ns + 1_000_000, 0, 0x123, 0, vec![1, 2, 3])
        );
        assert_eq!(
            sink.frames[1],
            (
                start_ns + 2_000_000,
                1,
                0x18FE_F100 | EXT_FLAG,
                flags::TX,
                vec![0; 8]
            )
        );
        assert_eq!(
            sink.frames[2],
            (start_ns + 3_000_000, 0, 0x7FF, flags::RTR, vec![])
        );
        assert_eq!(sink.remote_dlcs, [None, None, Some(2)]);
    }

    #[test]
    fn start_times_out_of_range_count_from_zero() {
        for year in [0, 1601, 2263, 9999, u16::MAX] {
            let file = concat(&[
                file_header(Some([year, 1, 0, 1, 23, 59, 59, 999])),
                object(CAN_MESSAGE, NS, 5, &can_message_body(1, 0, 1, 1, &[1])),
            ]);
            let (sink, _) = parse(&file);
            assert_eq!(sink.frames[0].0, 5, "year {year}");
        }
    }

    #[test]
    fn fd_and_error_objects_without_a_start_time() {
        let file = concat(&[
            file_header(None),
            object(
                CAN_FD_MESSAGE,
                NS,
                10,
                &can_fd_message_body(0x07, 9, &[7; 12]),
            ),
            object(
                CAN_FD_MESSAGE,
                NS,
                20,
                &can_fd_message_body(0, 4, &[1, 2, 3, 4]),
            ),
            object(
                CAN_FD_MESSAGE_64,
                NS,
                30,
                &can_fd_message_64_body(0x1000 | 0x4000, 1, 15, &[9; 64]),
            ),
            object(
                CAN_FD_MESSAGE_64,
                NS,
                40,
                &can_fd_message_64_body(0x10, 0, 0, &[]),
            ),
            object(CAN_ERROR, NS, 50, &[3, 0, 0, 0]),
            object(CAN_FD_ERROR_64, NS, 55, &can_fd_error_64_body(2, 0, &[])),
            object(CAN_ERROR_EXT, NS, 60, &{
                let mut body = vec![0u8; 32];
                body[0] = 1;
                body[10] = 2;
                body[24..26].copy_from_slice(&[0xDE, 0xAD]);
                body
            }),
        ]);
        let (sink, stats) = parse(&file);
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(stats.frames, 7);
        assert_eq!(
            sink.frames[0],
            (
                10,
                0,
                0x123,
                flags::FD | flags::BRS | flags::ESI,
                vec![7; 12]
            )
        );
        assert_eq!(sink.frames[1], (20, 0, 0x123, 0, vec![1, 2, 3, 4]));
        assert_eq!(
            sink.frames[2],
            (
                30,
                1,
                0x18FE_F100 | EXT_FLAG,
                flags::FD | flags::ESI | flags::TX,
                vec![9; 64]
            )
        );
        assert_eq!(
            sink.frames[3],
            (40, 1, 0x18FE_F100 | EXT_FLAG, flags::RTR, vec![])
        );
        assert_eq!(sink.remote_dlcs[3], Some(0));
        assert_eq!(sink.frames[4], (50, 2, ERR_FLAG, flags::ERROR, vec![]));
        assert_eq!(sink.frames[5], (55, 1, ERR_FLAG, flags::ERROR, vec![]));
        assert_eq!(
            sink.frames[6],
            (60, 0, ERR_FLAG, flags::ERROR, vec![0xDE, 0xAD])
        );
        assert_eq!(
            sink.channels,
            [b"can1".to_vec(), b"can2".to_vec(), b"can3".to_vec()]
        );
    }

    #[test]
    fn fd_error_objects_keep_the_data_of_the_frame_the_error_hit() {
        let data: Vec<u8> = (0..20).collect();
        let mut truncated = can_fd_error_64_body(1, 0x80, &[5; 12]);
        truncated.truncate(50);
        let file = concat(&[
            file_header(None),
            object(
                CAN_FD_ERROR_64,
                NS,
                10,
                &can_fd_error_64_body(1, 0x80 | 0x40 | 0x20, &data),
            ),
            object(
                CAN_FD_ERROR_64,
                NS,
                20,
                &can_fd_error_64_body(2, 0x40, &[0xDE, 0xAD]),
            ),
            object(CAN_FD_ERROR_64, NS, 30, &[1; 43]),
            object(CAN_FD_ERROR_64, NS, 40, &truncated),
        ]);
        let (sink, stats) = parse(&file);
        assert_eq!(stats.frames, 2);
        assert_eq!(stats.rejected, 2);
        assert_eq!(
            stats.first_rejection,
            Some((3, "CAN error object too short"))
        );
        assert_eq!(
            sink.frames[0],
            (
                10,
                0,
                ERR_FLAG,
                flags::ERROR | flags::FD | flags::BRS | flags::ESI,
                data
            )
        );
        assert_eq!(
            sink.frames[1],
            (20, 1, ERR_FLAG, flags::ERROR, vec![0xDE, 0xAD])
        );
    }

    #[test]
    fn containers_may_split_an_object_and_mix_compression() {
        let objects: Vec<u8> = (0..40u64)
            .flat_map(|i| {
                object(
                    CAN_MESSAGE,
                    NS,
                    i * 1000,
                    &can_message_body(1, 0, 8, 0x100 + i as u32, &[i as u8; 8]),
                )
            })
            .collect();
        let (first, second) = objects.split_at(objects.len() / 2 + 7);
        let file = concat(&[
            file_header(None),
            container(ZLIB, first),
            container(UNCOMPRESSED, second),
            raw_container(7, b"whatever", 8),
            raw_container(ZLIB, b"not zlib at all", 15),
            object(
                CAN_MESSAGE,
                NS,
                50_000,
                &can_message_body(1, 0, 1, 0x200, &[1]),
            ),
        ]);
        let (sink, stats) = assert_chunking_does_not_matter(BlfParser::new, &file);
        assert_eq!(stats.frames, 41);
        assert_eq!(stats.rejected, 2);
        assert_eq!(
            stats.first_rejection,
            Some((41, "log container with an unknown compression"))
        );
        assert_eq!(sink.frames[39].0, 39_000);
        assert_eq!(sink.frames[40], (50_000, 0, 0x200, 0, vec![1]));
    }

    #[test]
    fn rejects_bad_files_and_objects_with_reasons() {
        let (sink, stats) = parse(b"(1.0) can0 123#00\n");
        assert!(sink.frames.is_empty());
        assert_eq!(stats.first_rejection, Some((1, NOT_A_BLF_FILE)));

        let (_, stats) = parse(&file_header(None)[..100]);
        assert_eq!(
            stats.first_rejection,
            Some((1, "file shorter than the BLF header"))
        );

        let mut short = object(CAN_MESSAGE, NS, 1, &[0; 8]);
        short.truncate(40);
        short[8..12].copy_from_slice(&40u32.to_le_bytes());
        let mut bad_size = object(CAN_MESSAGE, NS, 2, &can_message_body(1, 0, 1, 1, &[1]));
        bad_size[8..12].copy_from_slice(&8u32.to_le_bytes());
        let mut truncated = object(CAN_MESSAGE, NS, 3, &can_message_body(1, 0, 1, 1, &[1]));
        truncated.truncate(30);
        let file = concat(&[
            file_header(None),
            short,
            bad_size,
            b"garbage!".to_vec(),
            object(
                CAN_MESSAGE,
                NS,
                u64::MAX,
                &can_message_body(1, 0, 1, 1, &[1]),
            ),
            object(CAN_MESSAGE, NS, 4, &can_message_body(1, 0, 1, 1, &[1])),
            truncated,
        ]);
        let (sink, stats) = assert_chunking_does_not_matter(BlfParser::new, &file);
        assert_eq!(sink.frames, [(4, 0, 1, 0, vec![1])]);
        assert_eq!(stats.rejected, 5);
        assert_eq!(
            stats.first_rejection,
            Some((1, "CAN message object too short"))
        );
    }
}
