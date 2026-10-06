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
//! The plan and the reads keep to the file's budgets for data and frames, as a read of each
//! data group alone would: a data list that links the same blocks over and over is planned no
//! further than a read of the whole file gets. A file is read whole when it can't be split
//! ([`splittable`]), when a data block's header doesn't give its length, or when the plan
//! would have too many parts.

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
const REASONS: [&str; 21] = [
    "more data than the file's size allows",
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
    /// The data reading it charges, and that the blocks before it in the stream charge.
    charge: u64,
    charged_before: u64,
    /// Where its bytes start in the stream, and how many it gives.
    start: u64,
    len: u64,
}

/// Planned parts at most, and blocks named in all their tasks at most: past either, the file is
/// read whole. Links that fan out to the same blocks again and again can make a stream far
/// longer than the file, which a read stops at its budgets but which would otherwise make as
/// many parts.
pub(super) const MAX_PARTS: usize = 4096;
const MAX_PIECES: usize = 1 << 18;

/// The error [`prepare`] stops with for a file whose records can't be read in parts.
pub(super) const NOT_SPLITTABLE: &str = "read whole";

/// Whether a data group's records can be read in parts: not when a sorted group's records have
/// no length, when an unsorted group has compressed blocks (where its records end is known
/// only by inflating them all), or when the offsets of values in VLSD channel groups were
/// never written (an unfinalized file), as they then follow from every record before.
pub(super) fn splittable(file: &[u8], reader: &RecordReader<'_>, repairs: Repairs) -> bool {
    if reader.record_id_size == 0 && reader.groups[0].record_len == 0 {
        return false;
    }
    if reader.record_id_size != 0 {
        let compressed = reader.records.blocks.as_slice().iter().any(|&at| {
            usize::try_from(at)
                .ok()
                .and_then(|at| file.get(at..at.checked_add(4)?))
                == Some(b"##DZ".as_slice())
        });
        if compressed {
            return false;
        }
    }
    let vlsd_in_group = reader.groups.iter().any(|group| {
        matches!(
            &group.bus,
            Some(BusGroup {
                data_bytes: Some(DataBytes::Variable {
                    store: VariableStore::Group(_),
                    ..
                }),
                ..
            })
        )
    });
    !(repairs.vlsd_offsets && vlsd_in_group)
}

/// What reading a file may charge for data and frames at most, as [`Walk::new`] allows.
#[derive(Clone, Copy)]
struct Budget {
    data: u64,
    frames: u64,
}

/// Plans reading the frames of `file` in parts of about `part_bytes` of stream each, after
/// reading it up to them with `stats`. None for a file read whole (see the module's docs).
///
/// A data group's stream is planned only as far as a read of it alone could get within the
/// file's budgets for data and frames: a read of the whole file stops there or sooner.
pub(super) fn plan(file: &[u8], stats: &mut ParseStats, part_bytes: u64) -> Option<Join> {
    let Prepared {
        start_ns,
        walk,
        mut sources,
    } = prepare(file, stats, true).ok()?;
    let part_bytes = part_bytes.max(1);
    let full = Walk::new(file.len(), Repairs::default());
    let budget = Budget {
        data: full.data_left,
        frames: full.frames_left as u64,
    };
    // Each part with the data group it reads and how far into its stream it starts.
    let mut planned: Vec<(f64, usize, PartTask)> = Vec::new();
    let mut pieces = 0;
    for (s, source) in sources.iter().enumerate() {
        let reader = &source.reader;
        let spec = spec(start_ns, reader);
        let mut blocks = sized_blocks(file, &reader.records)?;
        let stream_blocks = blocks.len();
        // Blocks past the one whose charge takes the stream over the data budget are never
        // entered, and the reads of the stream end in that one.
        let over = blocks
            .iter()
            .position(|block| block.charged_before.saturating_add(block.charge) > budget.data);
        let mut data_end = None;
        if let Some(over) = over {
            blocks.truncate(over + 1);
            data_end = Some(blocks[over].start + 1);
        }
        let ends_open = reader.records.ends_open() && blocks.len() == stream_blocks;
        let (cuts, stop) = if reader.record_id_size == 0 {
            let record_len = reader.groups[0].record_len as u64;
            // A read ends with the frame that takes it over the frame budget, if not before.
            let frames_end = budget.frames.saturating_add(1).saturating_mul(record_len);
            let total = blocks.last().map_or(0, |block| block.start + block.len);
            let end = data_end.map_or(frames_end, |end| end.min(frames_end));
            let cuts = sorted_cuts(&blocks, record_len, part_bytes, end)
                .into_iter()
                .map(|at| Some((at, vec![usize::try_from(at / record_len).ok()?])))
                .collect::<Option<Vec<_>>>()?;
            (cuts, (end < total).then_some(end))
        } else {
            walked_cuts(reader, part_bytes, budget)
        };
        let total = blocks.last().map_or(0, |block| block.start + block.len);
        for (i, (from, indexes)) in cuts.iter().enumerate() {
            let to = cuts.get(i + 1).map(|(at, _)| *at).or(stop);
            let task = part_task(
                &spec,
                &blocks,
                ends_open,
                *from,
                to,
                indexes,
                budget,
                &mut pieces,
            );
            planned.push((*from as f64 / total.max(1) as f64, s, task));
            if planned.len() > MAX_PARTS || pieces > MAX_PIECES {
                return None;
            }
        }
    }
    if planned.len() < 2 {
        return None;
    }
    // Parts are handed out about in the order the merge by time will want them.
    planned.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut payloads = Vec::new();
    let mut join_sources: Vec<JoinSource> = sources
        .iter_mut()
        .map(|source| JoinSource {
            variable: variable_payloads(&mut source.reader, &mut payloads),
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
        payloads,
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
    let mut charged_before = 0u64;
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
            charged_before,
            start,
            len,
        });
        start += len;
        charged_before = charged_before.saturating_add(charge);
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

/// Where a sorted data group's parts start, before `end`: on a record boundary at the start of
/// a block about `part_bytes` after the last, or within an uncompressed block, which costs
/// nothing to start in.
fn sorted_cuts(blocks: &[SizedBlock], record_len: u64, part_bytes: u64, end: u64) -> Vec<u64> {
    let total = blocks
        .last()
        .map_or(0, |block| block.start + block.len)
        .min(end);
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
/// record ends, with the records read in each channel group before it; and where the reads of
/// the stream stop short of its end, if they do: at an error, or at the frame or data that
/// takes them over `budget`.
fn walked_cuts(
    reader: &RecordReader<'_>,
    part_bytes: u64,
    budget: Budget,
) -> (Vec<(u64, Vec<usize>)>, Option<u64>) {
    let groups = &reader.groups;
    let is_frame = |index: usize| groups[index].bus.is_some() && !groups[index].vlsd;
    let mut records = reader.records.unread_copy();
    let mut walk = Walk::unlimited(Repairs::default());
    walk.data_left = budget.data;
    let mut indexes = vec![0; groups.len()];
    let mut cuts = vec![(0, indexes.clone())];
    let mut last = 0;
    let mut frames = 0u64;
    loop {
        let group_index = match next_record(
            &mut records,
            groups,
            reader.record_id_size,
            &mut walk,
            is_frame,
        ) {
            Ok(Some((group_index, _))) => group_index,
            Ok(None) => return (cuts, None),
            // The read that failed starts at or before where this one stopped.
            Err(_) => return (cuts, Some(records.position() + 1)),
        };
        indexes[group_index] += 1;
        frames += 1;
        let at = records.position();
        if frames > budget.frames {
            return (cuts, Some(at));
        }
        if at - last >= part_bytes {
            cuts.push((at, indexes.clone()));
            last = at;
        }
    }
}

/// The task of a part whose reads start at `from` in the stream, with `indexes` records read
/// in each channel group before it, and end at `to`, or at the end of the stream. `pieces`
/// counts the blocks named in tasks.
///
/// It names the blocks the reads go through, and the bytes of the file to fetch for them: a
/// compressed block whole, and of an uncompressed one only the bytes read, which the worker
/// makes a block of its own around. The reads start in the first block at `from`, or just
/// before the second. It also gives what the reads may charge for data and frames once the
/// parts before have charged theirs, so that a part ends where a read of its data group
/// alone would run out of budget.
#[allow(clippy::too_many_arguments)]
fn part_task(
    spec: &[u8],
    blocks: &[SizedBlock],
    ends_open: bool,
    from: u64,
    to: Option<u64>,
    indexes: &[usize],
    budget: Budget,
    pieces_named: &mut usize,
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
    *pieces_named += through.len();

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
    // Where each range starts in the bytes fetched.
    let mut fetched_at = Vec::with_capacity(ranges.len());
    let mut fetched = 0;
    for &(start, end) in &ranges {
        fetched_at.push(fetched);
        fetched += end - start;
    }
    let place = |at: u64| -> u64 {
        let range = ranges.partition_point(|&(start, _)| start <= at) - 1;
        fetched_at[range] + at - ranges[range].0
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
    // The charges of the blocks entered before: the first given was, when the reads start
    // inside it.
    let entered = first + usize::from(in_first);
    let charged = blocks.get(entered).map_or_else(
        || {
            blocks
                .last()
                .map_or(0, |block| block.charged_before + block.charge)
        },
        |block| block.charged_before,
    );
    let frames_before: u64 = indexes.iter().map(|&count| count as u64).sum();
    put_u64(&mut task, budget.data.saturating_sub(charged));
    put_u64(&mut task, budget.frames.saturating_sub(frames_before));
    PartTask { ranges, task }
}

/// For each channel group whose frames' payloads are in variable length data, its frame kind
/// and where that data is in `payloads`, where each SD block and VLSD channel group's data is
/// kept once, taken from `reader`.
fn variable_payloads(
    reader: &mut RecordReader<'_>,
    payloads: &mut Vec<Result<Vec<u8>, &'static str>>,
) -> Vec<Option<VariableData>> {
    // Where the data of each block and VLSD group is in `payloads`.
    let mut blocks: Vec<(*const u8, usize, usize)> = Vec::new();
    let mut groups: Vec<(u64, usize)> = Vec::new();
    let mut found = Vec::with_capacity(reader.groups.len());
    for group in &reader.groups {
        let Some(bus) = &group.bus else {
            found.push(None);
            continue;
        };
        let Some(DataBytes::Variable { store, .. }) = &bus.data_bytes else {
            found.push(None);
            continue;
        };
        let data = match store {
            VariableStore::Block(block) => {
                match blocks
                    .iter()
                    .find(|known| known.0 == block.as_ptr() && known.1 == block.len())
                {
                    Some(known) => known.2,
                    None => {
                        payloads.push(Ok(block.to_vec()));
                        blocks.push((block.as_ptr(), block.len(), payloads.len() - 1));
                        payloads.len() - 1
                    }
                }
            }
            VariableStore::Group(at) => match groups.iter().find(|known| known.0 == *at) {
                Some(known) => known.1,
                None => {
                    let values = reader.variable.iter_mut().find(|values| values.at == *at);
                    payloads.push(
                        values
                            .map(|values| std::mem::take(&mut values.data))
                            .ok_or("data bytes refer to a missing group"),
                    );
                    groups.push((*at, payloads.len() - 1));
                    payloads.len() - 1
                }
            },
        };
        found.push(Some(VariableData {
            kind: bus.kind,
            data,
        }));
    }
    found
}

/// What a part worker needs to read a data group's records: the start time, record ID size
/// and channel groups.
fn spec(start_ns: i64, reader: &RecordReader<'_>) -> Vec<u8> {
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
            Some(DataBytes::Variable { field, .. }) => {
                out.push(2);
                put_field(&mut out, Some(field));
            }
        }
    }
    out
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
    let data_left = t.u64()?;
    let frames_left = t.usize()?;
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
    // The reads stop where a read of the data group alone would run out of budget, which a
    // read of the whole file does there or sooner.
    let mut walk = Walk::unlimited(Repairs::default());
    walk.data_left = data_left;
    walk.frames_left = frames_left;
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
            Outcome::Pending(ref pending) => {
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
        if walk.take_frame().is_err() {
            break;
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
    /// The variable length data payloads are found in, as [`variable_payloads`] gives it.
    payloads: Vec<Result<Vec<u8>, &'static str>>,
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
    /// Its place in [`Join::payloads`].
    data: usize,
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
                &self.payloads,
            )
            .ok_or(())?;
            source.ended = account(outcome, &mut source.window, &mut self.walk, stats);
        }
        Ok(Next::Time(source.window.earliest()))
    }
}

/// The outcome of the read at `*at` in a part's `reads`, after making the charges it made,
/// with payloads found through `variable` in `payloads`.
fn replay(
    reads: &[u8],
    at: &mut usize,
    walk: &mut Walk,
    variable: &[Option<VariableData>],
    payloads: &[Result<Vec<u8>, &'static str>],
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
                let payload = match payloads.get(group.data)? {
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
