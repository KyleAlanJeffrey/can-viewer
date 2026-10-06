//! Reading an MF4 file's frames in parts, in other workers.
//!
//! The core worker holds the file and reads it up to its frames ([`prepare`]), then cuts each
//! data group's stream of records into parts of about `part_bytes` ([`plan`]). A part starts
//! where a frame record ends, as a read of the next frame record would in the whole file: in a
//! sorted data group, where a record ends follows from the lengths of the data blocks before
//! it, which their headers give; in an unsorted one, from a walk over its records, done only
//! when none of its blocks is compressed. A part worker fetches the part's blocks from the file
//! and reads its records with [`read_part`], sending back what each read came to and the data
//! it charged on the way. The core replays the reads in the order reading the whole file makes
//! them, merging the data groups by time and counting the limits ([`Join`]), so the frames,
//! their order and the file's counts are those of a read of the whole file.
//!
//! A frame whose payload is in variable length data is finished in the core, which keeps that
//! data from reading the file up to the frames.
//!
//! A file is read whole when a data block's header doesn't give its length, when an unsorted
//! data group has compressed blocks, or when the offsets of values in VLSD channel groups were
//! never written (an unfinalized file), as they then follow from every record before.

use super::*;

const MAGIC: &[u8; 4] = b"FM4P";
/// Blocks this close together in the file are fetched as one range.
const FETCH_GAP: u64 = 4096;
const NO_REMOTE_DLC: u8 = 0xFF;

const END: u8 = 0;
const FAILED: u8 = 1;
const REJECTED: u8 = 2;
const CHARGE: u8 = 3;
const FRAME: u8 = 4;
const PENDING: u8 = 5;

/// What a read can fail or be rejected with, sent by its place here.
const REASONS: [&str; 20] = [
    "bad data block",
    "data list inside a data list",
    "unknown data block type",
    "bad compressed data block",
    "compressed data too large",
    "compressed data larger than 1 GiB",
    "compressed data does not inflate",
    "compressed data has the wrong length",
    "unknown data compression",
    "record with an unknown channel group ID",
    CUT_SHORT,
    "record larger than 1 GiB",
    "bad time value",
    "time out of range",
    "bad flag value",
    "bad value",
    "bad data bytes",
    "bad data offset",
    "data bytes refer to a missing group",
    "data offset outside the data",
];

/// A part for a worker: the byte ranges of the file to fetch, in order, and `task`, for
/// [`read_part`] with the bytes fetched joined.
#[derive(Debug)]
pub struct PartTask {
    pub ranges: Vec<(u64, u64)>,
    pub task: Vec<u8>,
}

/// What joining a part left to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Joined {
    /// The part to join next.
    Needs(usize),
    /// Every frame is delivered.
    Done,
}

/// A data block of a data group's stream.
struct SizedBlock {
    /// Where its header starts, where its data starts and where it ends in the file.
    at: u64,
    data_at: u64,
    end: u64,
    id: [u8; 4],
    compressed: bool,
    /// The data reading it charges.
    charge: u64,
    /// Where its bytes start in the stream, and how many it gives.
    start: u64,
    len: u64,
}

/// Plans reading the frames of `file` in parts of about `part_bytes` of stream each, after
/// reading it up to them with `stats`. None for a file read whole (see the module's docs).
pub(super) fn plan(file: &[u8], stats: &mut ParseStats, part_bytes: u64) -> Option<Join> {
    let Prepared { walk, sources, .. } = prepare(file, stats).ok()?;
    let start_ns = Block::typed(file, 64, b"##HD")
        .and_then(|header| i64::try_from(u64_at(header.data, 0)).ok())?;
    let part_bytes = part_bytes.max(1);
    // Each part with the data group it reads and how far into its stream it starts.
    let mut planned: Vec<(f64, usize, PartTask)> = Vec::new();
    for (s, source) in sources.iter().enumerate() {
        let reader = &source.reader;
        let spec = spec(start_ns, reader, walk.repairs)?;
        let blocks = sized_blocks(file, &reader.records)?;
        let total = blocks.last().map_or(0, |block| block.start + block.len);
        let cuts = if reader.record_id_size == 0 {
            let record_len = reader.groups[0].record_len as u64;
            sorted_cuts(&blocks, record_len, part_bytes)
                .into_iter()
                .map(|at| Some((at, vec![usize::try_from(at / record_len).ok()?])))
                .collect::<Option<Vec<_>>>()?
        } else if blocks.iter().any(|block| block.compressed) {
            return None;
        } else {
            walked_cuts(reader, part_bytes)
        };
        for (i, (from, indexes)) in cuts.iter().enumerate() {
            let to = cuts.get(i + 1).map(|(at, _)| *at);
            let ends_open = reader.records.ends_open();
            let task = part_task(&spec, &blocks, ends_open, *from, to, indexes);
            planned.push((*from as f64 / total.max(1) as f64, s, task));
        }
    }
    if planned.len() < 2 {
        return None;
    }
    // Parts are handed out about in the order the merge by time will want them.
    planned.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut join_sources: Vec<JoinSource> = sources
        .iter()
        .map(|source| JoinSource {
            variable: variable_payloads(&source.reader),
            window: Window::new(source.window.len),
            ended: false,
            parts: Vec::new(),
            joined: 0,
            reads: Vec::new(),
            at: 0,
        })
        .collect();
    let mut part_sources = Vec::with_capacity(planned.len());
    let mut tasks = Vec::with_capacity(planned.len());
    for (part, (_, s, task)) in planned.into_iter().enumerate() {
        join_sources[s].parts.push(part);
        part_sources.push(s);
        tasks.push(task);
    }
    let needs = join_sources[0].parts[0];
    Some(Join {
        tasks,
        walk,
        pending: (0..join_sources.len()).rev().collect(),
        sources: join_sources,
        part_sources,
        order: BinaryHeap::new(),
        buses: Buses::default(),
        needs: Some(needs),
    })
}

/// The blocks of a data group's stream, sized from their headers. None when a block's
/// header doesn't give its length, or it isn't a data block.
fn sized_blocks(file: &[u8], records: &BlockReader<'_>) -> Option<Vec<SizedBlock>> {
    let list = records.blocks.as_slice();
    let mut start = 0;
    let mut blocks = Vec::with_capacity(list.len());
    for (i, &at) in list.iter().enumerate() {
        let (block, end) = match records.open_end {
            Some(end) if i + 1 == list.len() => (Block::ending_at(file, at, end)?, end as u64),
            _ => {
                let block = Block::at(file, at)?;
                (block, at + u64_at(file, usize::try_from(at).ok()? + 8))
            }
        };
        let open = records.open_end.is_some() && i + 1 == list.len();
        let data_len = block.data.len() as u64;
        let (len, charge, compressed) = match &block.id {
            _ if open => (data_len, data_len, false),
            b"##DT" | b"##DV" | b"##SD" | b"##RD" => (data_len, data_len, false),
            b"##DZ" => {
                let (len, compressed_len) = inflated_len(&block)?;
                (len, len.max(compressed_len), true)
            }
            _ => return None,
        };
        blocks.push(SizedBlock {
            at,
            data_at: end - data_len,
            end,
            id: block.id,
            compressed,
            charge,
            start,
            len,
        });
        start += len;
    }
    Some(blocks)
}

/// The lengths a DZ block inflates to and inflates from, if [`inflate`] would get as far as
/// inflating it.
fn inflated_len(block: &Block<'_>) -> Option<(u64, u64)> {
    if block.data.len() < 24 || !matches!(block.data[2], 0 | 1) {
        return None;
    }
    let original_len = usize::try_from(u64_at(block.data, 8)).ok()?;
    let compressed_len = usize::try_from(u64_at(block.data, 16)).ok()?;
    block.data.get(24..24usize.checked_add(compressed_len)?)?;
    (original_len <= MAX_STREAM).then_some((original_len as u64, compressed_len as u64))
}

/// Where a sorted data group's parts start: on a record boundary at the start of a block about
/// `part_bytes` after the last, or within an uncompressed block, which costs nothing to start
/// in.
fn sorted_cuts(blocks: &[SizedBlock], record_len: u64, part_bytes: u64) -> Vec<u64> {
    let total = blocks.last().map_or(0, |block| block.start + block.len);
    let mut cuts = vec![0];
    let mut last = 0u64;
    for block in blocks {
        loop {
            let target = last.saturating_add(part_bytes);
            let at = if target <= block.start {
                block.start
            } else if !block.compressed && target < block.start + block.len {
                target
            } else {
                break;
            };
            let cut = at.div_ceil(record_len).saturating_mul(record_len);
            if cut >= total {
                return cuts;
            }
            cuts.push(cut);
            last = cut;
        }
    }
    cuts
}

/// Where an unsorted data group's parts start, about `part_bytes` apart, each where a frame
/// record ends, with the records read in each channel group before it.
fn walked_cuts(reader: &RecordReader<'_>, part_bytes: u64) -> Vec<(u64, Vec<usize>)> {
    let groups = &reader.groups;
    let is_frame = |index: usize| groups[index].bus.is_some() && !groups[index].vlsd;
    let mut records = reader.records.unread_copy();
    let mut walk = Walk::unlimited(Repairs::default());
    let mut indexes = vec![0; groups.len()];
    let mut cuts = vec![(0, indexes.clone())];
    let mut last = 0;
    while let Ok(Some((group_index, _))) = next_record(
        &mut records,
        groups,
        reader.record_id_size,
        &mut walk,
        is_frame,
    ) {
        indexes[group_index] += 1;
        let at = records.position();
        if at - last >= part_bytes {
            cuts.push((at, indexes.clone()));
            last = at;
        }
    }
    cuts
}

/// The task of a part whose reads start at `from` in the stream, with `indexes` records read
/// in each channel group before it, and end at `to`, or at the end of the stream.
///
/// It names the blocks the reads go through, and the bytes of the file to fetch for them: a
/// compressed block whole, and of an uncompressed one only the bytes read, which the worker
/// makes a block of its own around. The reads start in the first block at `from`, or just
/// before the second.
fn part_task(
    spec: &[u8],
    blocks: &[SizedBlock],
    ends_open: bool,
    from: u64,
    to: Option<u64>,
    indexes: &[usize],
) -> PartTask {
    // The last block with bytes before `from`, which the reads start in or just after.
    let before = blocks
        .partition_point(|block| block.start < from)
        .checked_sub(1);
    let (first, in_first) = match before {
        Some(k) if from < blocks[k].start + blocks[k].len => (k, true),
        Some(k) => (k + 1, false),
        None => (0, false),
    };
    let last = match to {
        Some(to) => blocks.partition_point(|block| block.start < to),
        None => blocks.len(),
    };
    let through = &blocks[first.min(last)..last];

    // Each block's bytes in the file, and whether the worker makes a block around them.
    let pieces: Vec<(u64, u64, bool)> = through
        .iter()
        .map(|block| {
            if block.compressed {
                return (block.at, block.end, false);
            }
            let skip = if in_first && block.start < from {
                from - block.start
            } else {
                0
            };
            let keep = to.map_or(block.len, |to| block.len.min(to - block.start));
            (block.data_at + skip, block.data_at + keep, true)
        })
        .collect();
    let mut extents: Vec<(u64, u64)> = pieces.iter().map(|&(at, end, _)| (at, end)).collect();
    extents.sort_unstable();
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    for (at, end) in extents {
        match ranges.last_mut() {
            Some(range) if at <= range.1.saturating_add(FETCH_GAP) => range.1 = range.1.max(end),
            _ => ranges.push((at, end)),
        }
    }
    // Where a place in the file is in the bytes fetched.
    let place = |at: u64| -> u64 {
        let mut offset = 0;
        for &(start, end) in &ranges {
            if (start..=end).contains(&at) {
                return offset + at - start;
            }
            offset += end - start;
        }
        offset
    };

    let mut task = MAGIC.to_vec();
    task.extend_from_slice(spec);
    put_u64(&mut task, pieces.len() as u64);
    for (&(at, end, made), block) in pieces.iter().zip(through) {
        task.push(u8::from(made));
        task.extend_from_slice(&block.id);
        put_u64(&mut task, place(at));
        put_u64(&mut task, end - at);
        put_u64(&mut task, block.charge);
    }
    task.push(u8::from(in_first));
    task.push(u8::from(last < blocks.len()));
    task.push(u8::from(ends_open));
    // Where the reads start in the stream, and in the first block given.
    let (block_start, pos) = match through.first() {
        Some(block) if in_first && !block.compressed => (from, 0),
        Some(block) if in_first => (block.start, from - block.start),
        _ => (from, 0),
    };
    put_u64(&mut task, block_start);
    put_u64(&mut task, pos);
    put_u64(&mut task, indexes.len() as u64);
    for &index in indexes {
        put_u64(&mut task, index as u64);
    }
    put_u64(&mut task, to.unwrap_or(u64::MAX));
    PartTask { ranges, task }
}

/// For each channel group whose frames' payloads are in variable length data, its frame kind
/// and that data.
fn variable_payloads(reader: &RecordReader<'_>) -> Vec<Option<VariableData>> {
    reader
        .groups
        .iter()
        .map(|group| {
            let bus = group.bus.as_ref()?;
            let Some(DataBytes::Variable { store, .. }) = &bus.data_bytes else {
                return None;
            };
            let data = match store {
                VariableStore::Block(block) => Ok(block.to_vec()),
                VariableStore::Group(at) => reader
                    .variable
                    .iter()
                    .find(|group| group.at == *at)
                    .map(|group| group.data.clone())
                    .ok_or("data bytes refer to a missing group"),
            };
            Some(VariableData {
                kind: bus.kind,
                data,
            })
        })
        .collect()
}

/// What a part worker needs to read a data group's records: the start time, record ID size
/// and channel groups. None when the offsets of values in VLSD channel groups were never
/// written.
fn spec(start_ns: i64, reader: &RecordReader<'_>, repairs: Repairs) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    put_u64(&mut out, start_ns as u64);
    out.push(reader.record_id_size as u8);
    put_u64(&mut out, reader.groups.len() as u64);
    for group in &reader.groups {
        put_u64(&mut out, group.record_id);
        put_u64(&mut out, group.record_len as u64);
        out.push(u8::from(group.vlsd));
        let Some(bus) = &group.bus else {
            out.push(0);
            continue;
        };
        out.push(1);
        out.push(match bus.kind {
            FrameKind::Data => 0,
            FrameKind::Remote => 1,
            FrameKind::Error => 2,
        });
        match &bus.time {
            Time::None => out.push(0),
            Time::Virtual { offset, factor } => {
                out.push(1);
                put_u64(&mut out, offset.to_bits());
                put_u64(&mut out, factor.to_bits());
            }
            Time::Field {
                field,
                offset,
                factor,
            } => {
                out.push(2);
                put_field(&mut out, Some(field));
                put_u64(&mut out, offset.to_bits());
                put_u64(&mut out, factor.to_bits());
            }
        }
        for field in [
            &bus.bus_channel,
            &bus.id,
            &bus.ide,
            &bus.dlc,
            &bus.data_length,
            &bus.dir,
            &bus.edl,
            &bus.brs,
            &bus.esi,
        ] {
            put_field(&mut out, field.as_ref());
        }
        match &bus.data_bytes {
            None => out.push(0),
            Some(DataBytes::Fixed(field)) => {
                out.push(1);
                put_field(&mut out, Some(field));
            }
            Some(DataBytes::Variable { field, store }) => {
                if repairs.vlsd_offsets && matches!(store, VariableStore::Group(_)) {
                    return None;
                }
                out.push(2);
                put_field(&mut out, Some(field));
            }
        }
    }
    Some(out)
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_field(out: &mut Vec<u8>, field: Option<&Field>) {
    let Some(field) = field else {
        out.push(0);
        return;
    };
    out.push(1);
    put_u64(out, field.byte_offset as u64);
    out.extend_from_slice(&field.bit_offset.to_le_bytes());
    out.extend_from_slice(&field.bit_count.to_le_bytes());
    out.push(field.data_type);
}

struct Take<'a>(&'a [u8]);

impl<'a> Take<'a> {
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.bytes(1)?[0])
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32_at(self.bytes(4)?, 0))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64_at(self.bytes(8)?, 0))
    }

    fn usize(&mut self) -> Option<usize> {
        usize::try_from(self.u64()?).ok()
    }

    fn number(&mut self) -> Option<Option<u64>> {
        let present = self.flag()?;
        let number = self.u64()?;
        Some(present.then_some(number))
    }

    fn flag(&mut self) -> Option<bool> {
        match self.u8()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }

    fn field(&mut self) -> Option<Option<Field>> {
        if !self.flag()? {
            return Some(None);
        }
        Some(Some(Field {
            byte_offset: self.usize()?,
            bit_offset: self.u32()?,
            bit_count: self.u32()?,
            data_type: self.u8()?,
        }))
    }

    fn groups(&mut self) -> Option<Vec<Group<'static>>> {
        let count = self.usize()?;
        let mut groups = Vec::new();
        for _ in 0..count {
            let record_id = self.u64()?;
            let record_len = self.usize()?;
            let vlsd = self.flag()?;
            let bus = if self.flag()? {
                Some(self.bus()?)
            } else {
                None
            };
            groups.push(Group {
                block_at: 0,
                record_id,
                record_len,
                vlsd,
                bus,
            });
        }
        Some(groups)
    }

    fn bus(&mut self) -> Option<BusGroup<'static>> {
        let kind = match self.u8()? {
            0 => FrameKind::Data,
            1 => FrameKind::Remote,
            2 => FrameKind::Error,
            _ => return None,
        };
        let time = match self.u8()? {
            0 => Time::None,
            1 => Time::Virtual {
                offset: f64::from_bits(self.u64()?),
                factor: f64::from_bits(self.u64()?),
            },
            2 => Time::Field {
                field: self.field()??,
                offset: f64::from_bits(self.u64()?),
                factor: f64::from_bits(self.u64()?),
            },
            _ => return None,
        };
        Some(BusGroup {
            kind,
            time,
            bus_channel: self.field()?,
            id: self.field()?,
            ide: self.field()?,
            dlc: self.field()?,
            data_length: self.field()?,
            dir: self.field()?,
            edl: self.field()?,
            brs: self.field()?,
            esi: self.field()?,
            data_bytes: match self.u8()? {
                0 => None,
                1 => Some(DataBytes::Fixed(self.field()??)),
                // The core worker finds the payload.
                2 => Some(DataBytes::Variable {
                    field: self.field()??,
                    store: VariableStore::Group(0),
                }),
                _ => return None,
            },
        })
    }
}

/// Reads the part of a data group's records that `task`, from [`Mf4Parser::plan_parts`], asks
/// for, from `fetched`, the bytes of the task's ranges of the file joined. Returns what each
/// read came to, for [`Mf4Parser::join_part`]. None when the task can't be read, or would need
/// a block it wasn't given.
#[must_use]
pub fn read_part(task: &[u8], fetched: &[u8]) -> Option<Vec<u8>> {
    let mut t = Take(task);
    if t.bytes(MAGIC.len())? != MAGIC {
        return None;
    }
    let start_ns = t.u64()? as i64;
    let record_id_size = usize::from(t.u8()?);
    let groups = t.groups()?;
    // The blocks, laid out one after another as in a file, and what reading each charges.
    let mut file = Vec::new();
    let mut blocks = Vec::new();
    let mut charges = Vec::new();
    for _ in 0..t.usize()? {
        let made = t.flag()?;
        let id = t.bytes(4)?;
        let at = t.usize()?;
        let len = t.usize()?;
        blocks.push(file.len() as u64);
        charges.push(t.u64()?);
        if made {
            file.extend_from_slice(id);
            file.extend_from_slice(&[0; 4]);
            file.extend_from_slice(&(BLOCK_HEADER as u64 + len as u64).to_le_bytes());
            file.extend_from_slice(&0u64.to_le_bytes());
        }
        file.extend_from_slice(fetched.get(at..at.checked_add(len)?)?);
    }
    let in_first = t.flag()?;
    let more_after = t.flag()?;
    let ends_open = t.flag()?;
    let block_start = t.u64()?;
    let pos = t.usize()?;
    let mut indexes = Vec::new();
    for _ in 0..t.usize()? {
        indexes.push(t.usize()?);
    }
    let end = t.u64()?;
    if !t.0.is_empty() || indexes.len() != groups.len() {
        return None;
    }
    // The last block given runs to the end of `file` when it is the stream's last.
    let open_end = ends_open.then_some(file.len() + usize::from(more_after));

    let mut out = Vec::new();
    let mut current = None;
    if in_first {
        let at = blocks.first().copied()?;
        let last = blocks.len() == 1 && !more_after;
        let mut walk = Walk::unlimited(Repairs::default());
        let payload = match open_end {
            Some(end) if last => open_block_payload(&file, at, end, &mut walk),
            _ => block_payload(&file, at, &mut walk),
        };
        match payload {
            Ok(block) if pos <= block.len() => current = Some(block),
            Ok(_) => return None,
            Err(reason) => {
                // A part before this one ended at the same error.
                put_reason(&mut out, FAILED, reason)?;
                return Some(out);
            }
        }
        blocks.remove(0);
        charges.remove(0);
    }
    if more_after {
        // Any block past those given: reading it fails, and so does the part.
        blocks.push(file.len() as u64 + 1);
    }
    let mut records = BlockReader::new(&file, blocks);
    records.open_end = open_end;
    records.block_start = block_start;
    if let Some(block) = current {
        records.block = block;
        records.pos = pos;
    }
    let mut reader = RecordReader {
        groups,
        record_id_size,
        records,
        variable: Vec::new(),
        indexes,
        defer_variable: true,
    };
    let mut walk = Walk::unlimited(Repairs::default());
    walk.charges = Some(Vec::new());
    let mut charges = charges.into_iter();
    while reader.records.position() < end {
        let outcome = reader.next_outcome(start_ns, &mut walk);
        if matches!(outcome, Outcome::Failed("bad data block")) {
            return None;
        }
        // A block made of only the bytes read charges as much as the block in the file.
        for _ in walk.charges.as_mut()?.drain(..) {
            out.push(CHARGE);
            put_u64(&mut out, charges.next()?);
        }
        match outcome {
            Outcome::End => {
                out.push(END);
                break;
            }
            Outcome::Failed(reason) => {
                put_reason(&mut out, FAILED, reason)?;
                break;
            }
            Outcome::Rejected(reason) => put_reason(&mut out, REJECTED, reason)?,
            Outcome::Pending(pending) => {
                let fields = &pending.fields;
                out.push(PENDING);
                put_u64(&mut out, pending.group as u64);
                put_u64(&mut out, pending.offset);
                put_u64(&mut out, fields.ts_ns as u64);
                out.extend_from_slice(&fields.bus.to_le_bytes());
                put_u64(&mut out, fields.raw_id);
                out.push(u8::from(fields.extended));
                out.push(fields.flags);
                put_number(&mut out, fields.dlc);
                put_number(&mut out, fields.data_length);
            }
            Outcome::Frame(frame) => {
                out.push(FRAME);
                put_u64(&mut out, frame.ts_ns as u64);
                out.extend_from_slice(&frame.bus.to_le_bytes());
                out.extend_from_slice(&frame.id.to_le_bytes());
                out.push(frame.flags);
                out.push(frame.len);
                out.push(frame.remote_dlc.unwrap_or(NO_REMOTE_DLC));
                out.extend_from_slice(&frame.data[..usize::from(frame.len)]);
            }
        }
    }
    Some(out)
}

fn put_number(out: &mut Vec<u8>, number: Option<u64>) {
    out.push(u8::from(number.is_some()));
    put_u64(out, number.unwrap_or(0));
}

fn put_reason(out: &mut Vec<u8>, kind: u8, reason: &str) -> Option<()> {
    let code = REASONS.iter().position(|known| *known == reason)?;
    out.push(kind);
    out.push(code as u8);
    Some(())
}

/// The frames of a file read in parts, merged by time as the parts are joined.
pub(super) struct Join {
    pub(super) tasks: Vec<PartTask>,
    /// What reading the file may still cost.
    walk: Walk,
    sources: Vec<JoinSource>,
    /// Each part's data group, by part number.
    part_sources: Vec<usize>,
    /// The data groups by the time of the next frame each delivers, as in [`merge`].
    order: BinaryHeap<Reverse<(i64, usize)>>,
    /// Data groups whose next time is still to be found, the next last.
    pending: Vec<usize>,
    buses: Buses,
    /// The part to join next; None once every frame is delivered.
    needs: Option<usize>,
}

struct JoinSource {
    /// By channel group, as [`variable_payloads`] gives them.
    variable: Vec<Option<VariableData>>,
    window: Window,
    ended: bool,
    /// Its parts, in stream order, and how many of them are joined.
    parts: Vec<usize>,
    joined: usize,
    /// The reads of the part last joined, and how far they are replayed.
    reads: Vec<u8>,
    at: usize,
}

struct VariableData {
    kind: FrameKind,
    data: Result<Vec<u8>, &'static str>,
}

enum Next {
    Part(usize),
    Time(Option<i64>),
}

impl std::fmt::Debug for Join {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Join")
            .field("parts", &self.tasks.len())
            .field("needs", &self.needs)
            .finish_non_exhaustive()
    }
}

impl Join {
    pub(super) fn join<S: FrameSink>(
        &mut self,
        index: usize,
        part: &[u8],
        stats: &mut ParseStats,
        sink: &mut S,
    ) -> Result<Joined, ()> {
        if self.needs != Some(index) {
            return Err(());
        }
        let source = &mut self.sources[self.part_sources[index]];
        source.reads.clear();
        source.reads.extend_from_slice(part);
        source.at = 0;
        source.joined += 1;
        loop {
            while let Some(&s) = self.pending.last() {
                match self.next_time(s, stats)? {
                    Next::Part(part) => {
                        self.needs = Some(part);
                        return Ok(Joined::Needs(part));
                    }
                    Next::Time(time) => {
                        self.pending.pop();
                        if let Some(ts_ns) = time {
                            self.order.push(Reverse((ts_ns, s)));
                        }
                    }
                }
            }
            let Some(Reverse((_, s))) = self.order.pop() else {
                self.needs = None;
                return Ok(Joined::Done);
            };
            if let Some(frame) = self.sources[s].window.take() {
                deliver(frame, &mut self.buses, sink);
            }
            self.pending.push(s);
        }
    }

    /// As [`Source::next_time`], replaying the reads of the data group's parts; or the part
    /// whose reads come next, when they are not joined yet.
    fn next_time(&mut self, s: usize, stats: &mut ParseStats) -> Result<Next, ()> {
        let source = &mut self.sources[s];
        while !source.ended && !source.window.is_full() {
            if source.at == source.reads.len() {
                // The last part's reads end the data group.
                let part = source.parts.get(source.joined).ok_or(())?;
                return Ok(Next::Part(*part));
            }
            let outcome = replay(
                &source.reads,
                &mut source.at,
                &mut self.walk,
                &source.variable,
            )
            .ok_or(())?;
            source.ended = account(outcome, &mut source.window, &mut self.walk, stats);
        }
        Ok(Next::Time(source.window.earliest()))
    }
}

/// The outcome of the read at `*at` in a part's `reads`, after making the charges it made,
/// with payloads found in `variable`.
fn replay(
    reads: &[u8],
    at: &mut usize,
    walk: &mut Walk,
    variable: &[Option<VariableData>],
) -> Option<Outcome> {
    let mut t = Take(reads.get(*at..)?);
    let outcome = loop {
        match t.u8()? {
            CHARGE => {
                if let Err(reason) = walk.take_data(t.usize()?) {
                    break Outcome::Failed(reason);
                }
            }
            END => break Outcome::End,
            FAILED => break Outcome::Failed(REASONS.get(usize::from(t.u8()?))?),
            REJECTED => break Outcome::Rejected(REASONS.get(usize::from(t.u8()?))?),
            FRAME => {
                let ts_ns = t.u64()? as i64;
                let bus = t.u32()?;
                let id = t.u32()?;
                let flags = t.u8()?;
                let len = t.u8()?;
                let remote_dlc = match t.u8()? {
                    NO_REMOTE_DLC => None,
                    dlc => Some(dlc),
                };
                let mut frame = Frame {
                    ts_ns,
                    bus,
                    id,
                    flags,
                    len,
                    data: [0; MAX_PAYLOAD],
                    remote_dlc,
                };
                let data = t.bytes(usize::from(len))?;
                frame.data.get_mut(..data.len())?.copy_from_slice(data);
                break Outcome::Frame(frame);
            }
            PENDING => {
                let group = variable.get(t.usize()?)?.as_ref()?;
                let offset = t.u64()?;
                let fields = RecordFields {
                    ts_ns: t.u64()? as i64,
                    bus: t.u32()?,
                    raw_id: t.u64()?,
                    extended: t.flag()?,
                    flags: t.u8()?,
                    dlc: t.number()?,
                    data_length: t.number()?,
                };
                let payload = match &group.data {
                    Ok(data) => variable_value(data, offset).ok_or("data offset outside the data"),
                    Err(reason) => Err(*reason),
                };
                break match payload {
                    Ok(data) => Outcome::Frame(frame_from(group.kind, &fields, data)),
                    Err(reason) => Outcome::Rejected(reason),
                };
            }
            _ => return None,
        }
    };
    *at = reads.len() - t.0.len();
    Some(outcome)
}
