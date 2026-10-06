//! A part of a log read into a store of its own, in another worker, and joined onto the store
//! that read the parts before it as if its frames had been pushed there.
//!
//! The part's store works out the per-ID statistics of its own frames, which is most of the
//! cost of storing a frame. Joining it adds what depends on the frames before it: bit flips
//! between the last frame of each kind before the part and the first in it, each a pair of
//! frames compared over their bytes in common, and the gaps between frames, redone frame by
//! frame so their floating-point sums come out the same. J1939 transfers are reassembled as
//! the part is joined, since their packets may span parts. Each is stored right after the
//! packet that completed it, so the part's later frames move down a row per transfer, and the
//! IDs the transfers are reassembled to have their statistics worked out again frame by frame.
//!
//! A part whose times count on from the parts before it (an ASC file's relative times) is
//! joined with a [`TimeShift`] added to the times of its first frames. The integer gaps between
//! the shifted frames, and so their statistics, are the same as the part worked out; a part
//! shifted only in part has its statistics worked out again frame by frame.

use std::fmt;

use rustc_hash::{FxHashMap, FxHashSet};

use crate::{flags, id_key, FrameKind, FrameRef, FrameSink, MAX_PAYLOAD};

use super::{count_pair, set_last_data, FlipTally, FrameStore, IdKey, IdStats};

const MAGIC: &[u8; 4] = b"FCS2";

/// Why [`FrameStore::append_segment`] refused a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentError {
    /// The bytes are not a segment [`FrameStore::encode_segment`] wrote.
    Malformed,
    /// The segment ran out of bus numbers, so some of its buses share one.
    TooManyBuses,
    /// A time shifted by the [`TimeShift`] it was joined with overflows.
    TimeOverflow,
}

/// A time added to the times of a segment's first `frames` frames as it is joined.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimeShift {
    pub frames: usize,
    pub ns: i64,
}

impl fmt::Display for SegmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Malformed => "malformed log segment",
            Self::TooManyBuses => "log segment with too many buses",
            Self::TimeOverflow => "log segment with times out of range once shifted",
        })
    }
}

impl std::error::Error for SegmentError {}

impl FrameStore {
    /// The frames and per-ID statistics of a store made with [`FrameStore::for_segment`], for
    /// [`FrameStore::append_segment`].
    #[must_use]
    pub fn encode_segment(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len() * 32 + 1024);
        out.extend_from_slice(MAGIC);
        put_len(&mut out, self.len());
        put_len(&mut out, self.channels.len());
        for name in &self.channels {
            put_len(&mut out, name.len());
            out.extend_from_slice(name.as_bytes());
        }
        self.ts_ns
            .iter()
            .for_each(|t| out.extend_from_slice(&t.to_le_bytes()));
        self.id
            .iter()
            .for_each(|id| out.extend_from_slice(&id.to_le_bytes()));
        out.extend(self.channel.iter());
        out.extend(self.flags.iter());
        let mut data_len = 0;
        for i in 0..self.len() {
            put_len(&mut out, data_len);
            data_len += self.payload(i).len();
        }
        put_len(&mut out, data_len);
        for i in 0..self.len() {
            out.extend_from_slice(self.payload(i));
        }
        put_len(&mut out, self.index.ids.len());
        for stats in &self.index.ids {
            out.push(stats.channel);
            out.extend_from_slice(&stats.id.to_le_bytes());
            out.push(stats.flags);
            out.extend_from_slice(&stats.first_ts_ns.to_le_bytes());
            out.extend_from_slice(&stats.last_ts_ns.to_le_bytes());
            out.extend_from_slice(&stats.min_len.to_le_bytes());
            out.extend_from_slice(&stats.max_len.to_le_bytes());
            out.extend_from_slice(&stats.gap_mean_ns.to_le_bytes());
            out.extend_from_slice(&stats.gap_m2.to_le_bytes());
            put_len(&mut out, stats.frames.len());
            stats
                .frames
                .iter()
                .for_each(|f| out.extend_from_slice(&f.to_le_bytes()));
            let bit_flips = stats.bit_flips();
            put_len(&mut out, bit_flips.len());
            bit_flips
                .iter()
                .for_each(|n| out.extend_from_slice(&n.to_le_bytes()));
            put_len(&mut out, stats.pairs_by_len.len());
            stats
                .pairs_by_len
                .iter()
                .for_each(|n| out.extend_from_slice(&n.to_le_bytes()));
            for last in &stats.last_data {
                match last {
                    Some(data) => {
                        out.push(1);
                        put_len(&mut out, data.len());
                        out.extend_from_slice(data);
                    }
                    None => out.push(0),
                }
            }
        }
        out
    }

    /// Appends the frames of a segment from [`FrameStore::encode_segment`], leaving this store
    /// as if they had been pushed here: new buses are numbered in order of first appearance,
    /// J1939 transfers are reassembled across segments and the per-ID statistics carry on.
    ///
    /// # Errors
    /// When the segment can't be joined. Frames may have been appended by then, so the store
    /// should be read again.
    pub fn append_segment(&mut self, bytes: &[u8]) -> Result<(), SegmentError> {
        self.append_shifted_segment(bytes, TimeShift::default())
    }

    /// [`FrameStore::append_segment`], with `shift` added to the times of the segment's first
    /// frames.
    ///
    /// # Errors
    /// As [`FrameStore::append_segment`], and when the shift is for more frames than the
    /// segment has or takes a time out of range.
    pub fn append_shifted_segment(
        &mut self,
        bytes: &[u8],
        shift: TimeShift,
    ) -> Result<(), SegmentError> {
        let mut segment = Segment::read(bytes)?;
        segment.shift(shift)?;
        // The last bus number is shared by every bus after it.
        if segment.channels.len() > usize::from(u8::MAX) {
            return Err(SegmentError::TooManyBuses);
        }
        let buses: Vec<u8> = segment
            .channels
            .iter()
            .map(|name| self.channel_index(name))
            .collect();
        let mut sorted = buses.clone();
        sorted.sort_unstable();
        sorted.dedup();
        let distinct_buses = sorted.len() == buses.len();

        let first = self.len();
        // The segment's frames that completed a transfer, each followed in the store by it.
        let mut completions = Vec::new();
        for j in 0..segment.len() {
            let (frame, stored) = segment.frame(j, &buses);
            self.append_row(&frame, stored);
            if self.reassemble(&frame, false) {
                completions.push(j as u32);
            }
        }
        let mut index = std::mem::take(&mut self.index);
        if !distinct_buses || segment.shifted_in_part() {
            // Buses that share a number mix their IDs' frames, and a shift that stops partway
            // changes the gaps where it stops, so the statistics are worked out frame by frame.
            for i in first..self.len() {
                index.observe(i as u32, &self.frame(i));
            }
            self.index = index;
            return Ok(());
        }
        let rows = Rows {
            first,
            completions: &completions,
        };
        // The IDs of the transfers have frames among the segment's, so they are counted frame by
        // frame; every other ID's frames in the store are the segment's, in its order.
        let mut touched: FxHashMap<IdKey, Touched> = FxHashMap::default();
        for (before, &j) in completions.iter().enumerate() {
            let row = first + j as usize + before + 1;
            let key = id_key(self.channel[row], self.id[row]);
            touched.entry(key).or_default().transfers.push(row as u32);
        }
        // With the row of their first frame, to be numbered in order of first appearance.
        let mut new_ids: Vec<(u32, IdStats)> = Vec::new();
        for (k, part) in segment.ids.iter().enumerate() {
            let channel = buses[part.channel];
            let key = id_key(channel, part.id);
            if let Some(touched) = touched.get_mut(&key) {
                touched.part = Some(k);
                continue;
            }
            match index.by_key.get(&key) {
                Some(&i) => index.ids[i].join(part, &segment, &rows),
                None => {
                    let stats = part.stats(channel, &rows, segment.shift_ns);
                    new_ids.push((stats.frames[0], stats));
                }
            }
        }
        for (key, touched) in touched {
            let mut id_rows = touched.transfers;
            if let Some(k) = touched.part {
                id_rows.extend(rows.of(segment.ids[k].frames()));
                id_rows.sort_unstable();
            }
            let stats = match index.by_key.get(&key) {
                Some(&i) => &mut index.ids[i],
                None => {
                    let frame = self.frame(id_rows[0] as usize);
                    let stats = IdStats::new(frame.channel, frame.id, frame.ts_ns);
                    new_ids.push((id_rows[0], stats));
                    &mut new_ids.last_mut().unwrap().1
                }
            };
            for &row in &id_rows {
                stats.observe(row, &self.frame(row as usize));
            }
        }
        new_ids.sort_unstable_by_key(|&(first_row, _)| first_row);
        for (_, stats) in new_ids {
            index.by_key.insert(stats.key(), index.ids.len());
            index.ids.push(stats);
        }
        self.index = index;
        Ok(())
    }
}

/// An ID that transfers completed in a segment are reassembled to.
#[derive(Default)]
struct Touched {
    /// The ID's entry among the segment's, if it has frames there too.
    part: Option<usize>,
    /// The rows of the transfers, in order.
    transfers: Vec<u32>,
}

/// Where a segment's frames land in the store: from `first` on, each after the transfers the
/// frames before it completed.
struct Rows<'a> {
    first: usize,
    /// The frames that completed a transfer, in order.
    completions: &'a [u32],
}

impl<'a> Rows<'a> {
    /// The rows of `frames`, which must ascend.
    fn of(&self, frames: impl Iterator<Item = usize> + 'a) -> impl Iterator<Item = u32> + 'a {
        let (first, completions) = (self.first, self.completions);
        let mut before = 0;
        frames.map(move |j| {
            // A search rather than a walk, so an ID with few frames doesn't step through every
            // completion in the part.
            before += completions[before..].partition_point(|&c| (c as usize) < j);
            (first + j + before) as u32
        })
    }
}

impl IdStats {
    /// Carries on with the frames of `part`, the same ID's frames in a segment whose frames are
    /// now at `rows`, as [`IdStats::observe`] would frame by frame.
    fn join(&mut self, part: &SegmentId<'_>, segment: &Segment<'_>, rows: &Rows<'_>) {
        self.bit_flips.grow(part.bit_flips().len() / 8);
        for (kind, last_of_part) in part.last_data.iter().enumerate() {
            let Some(last_of_part) = last_of_part else {
                continue;
            };
            match &mut self.last_data[kind] {
                Some(last) => {
                    let first_of_part = segment.first_payload_of_kind(part, kind);
                    count_pair(&mut self.pairs_by_len, first_of_part.len().min(last.len()));
                    self.bit_flips.add_pair(last, first_of_part);
                    set_last_data(last, last_of_part);
                }
                none => *none = Some(last_of_part.to_vec()),
            }
        }
        self.bit_flips.add_counts(part.bit_flips());
        grow_to(&mut self.pairs_by_len, part.pairs_by_len.len() / 4);
        for (count, pairs) in self.pairs_by_len.iter_mut().zip(u32s(part.pairs_by_len)) {
            *count += pairs;
        }
        for (j, row) in part.frames().zip(rows.of(part.frames())) {
            self.observe_time(row, segment.ts(j));
        }
        self.flags |= part.flags;
        self.min_len = self.min_len.min(part.min_len);
        self.max_len = self.max_len.max(part.max_len);
    }
}

fn grow_to(counts: &mut Vec<u32>, len: usize) {
    if counts.len() < len {
        counts.resize(len, 0);
    }
}

fn put_len(out: &mut Vec<u8>, len: usize) {
    let len = u32::try_from(len).expect("a segment holds under 4 GiB");
    out.extend_from_slice(&len.to_le_bytes());
}

/// An encoded segment, read in place.
struct Segment<'a> {
    channels: Vec<&'a [u8]>,
    ts_ns: &'a [u8],
    id: &'a [u8],
    channel: &'a [u8],
    flags: &'a [u8],
    /// `len + 1` offsets into `data`, the last its length.
    data_start: &'a [u8],
    data: &'a [u8],
    ids: Vec<SegmentId<'a>>,
    /// Added to the times of the first `shifted` frames.
    shift_ns: i64,
    shifted: usize,
}

/// One ID's statistics in a segment.
struct SegmentId<'a> {
    channel: usize,
    id: u32,
    flags: u8,
    first_ts_ns: i64,
    last_ts_ns: i64,
    min_len: u16,
    max_len: u16,
    gap_mean_ns: f64,
    gap_m2: f64,
    /// `u32`s, as are the bit flips and pairs.
    frames: &'a [u8],
    bit_flips: &'a [u8],
    pairs_by_len: &'a [u8],
    last_data: [Option<&'a [u8]>; 4],
}

fn u32_at(bytes: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap())
}

fn u32s(bytes: &[u8]) -> impl ExactSizeIterator<Item = u32> + '_ {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&b| u32::from_le_bytes(b))
}

impl<'a> Segment<'a> {
    fn read(bytes: &'a [u8]) -> Result<Self, SegmentError> {
        let mut r = Reader(bytes);
        if r.take(MAGIC.len())? != MAGIC {
            return Err(SegmentError::Malformed);
        }
        let len = r.len()?;
        let channels = (0..r.len()?)
            .map(|_| {
                let name_len = r.len()?;
                r.take(name_len)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut segment = Segment {
            ts_ns: r.list(len, 8)?,
            id: r.list(len, 4)?,
            channel: r.take(len)?,
            flags: r.take(len)?,
            data_start: r.list(len + 1, 4)?,
            data: &[],
            ids: Vec::new(),
            shift_ns: 0,
            shifted: 0,
            channels,
        };
        segment.data = r.take(u32_at(segment.data_start, len) as usize)?;
        let starts_fit = u32_at(segment.data_start, 0) == 0
            && u32s(segment.data_start)
                .zip(u32s(segment.data_start).skip(1))
                .all(|(a, b)| a <= b && (b - a) as usize <= MAX_PAYLOAD);
        if !starts_fit
            || segment
                .channel
                .iter()
                .any(|&c| usize::from(c) >= segment.channels.len())
        {
            return Err(SegmentError::Malformed);
        }
        // Each frame must belong to exactly one ID, and each ID come once, so the joined
        // statistics count every frame once and in order.
        let mut owned = vec![false; len];
        let mut keys = FxHashSet::default();
        for _ in 0..r.len()? {
            let part = SegmentId {
                channel: usize::from(r.u8()?),
                id: r.u32()?,
                flags: r.u8()?,
                first_ts_ns: r.i64()?,
                last_ts_ns: r.i64()?,
                min_len: r.u16()?,
                max_len: r.u16()?,
                gap_mean_ns: f64::from_bits(r.i64()? as u64),
                gap_m2: f64::from_bits(r.i64()? as u64),
                frames: {
                    let count = r.len()?;
                    r.list(count, 4)?
                },
                bit_flips: {
                    let count = r.len()?;
                    r.list(count, 4)?
                },
                pairs_by_len: {
                    let count = r.len()?;
                    r.list(count, 4)?
                },
                last_data: [r.payload()?, r.payload()?, r.payload()?, r.payload()?],
            };
            let ordered = u32s(part.frames)
                .zip(u32s(part.frames).skip(1))
                .all(|(a, b)| a < b);
            let in_range = u32s(part.frames)
                .last()
                .is_some_and(|last| (last as usize) < len);
            if part.channel >= segment.channels.len()
                || !ordered
                || !in_range
                || !keys.insert(id_key(part.channel as u8, part.id))
            {
                return Err(SegmentError::Malformed);
            }
            for j in part.frames() {
                let its_own = usize::from(segment.channel[j]) == part.channel
                    && u32_at(segment.id, j) == part.id;
                if owned[j] || !its_own {
                    return Err(SegmentError::Malformed);
                }
                owned[j] = true;
            }
            segment.ids.push(part);
        }
        if !r.0.is_empty() || owned.contains(&false) {
            return Err(SegmentError::Malformed);
        }
        Ok(segment)
    }

    fn len(&self) -> usize {
        self.channel.len()
    }

    fn shift(&mut self, shift: TimeShift) -> Result<(), SegmentError> {
        if shift.frames > self.len() {
            return Err(SegmentError::Malformed);
        }
        if shift.ns == 0 || shift.frames == 0 {
            return Ok(());
        }
        if (0..shift.frames).any(|j| self.ts_as_read(j).checked_add(shift.ns).is_none()) {
            return Err(SegmentError::TimeOverflow);
        }
        self.shift_ns = shift.ns;
        self.shifted = shift.frames;
        Ok(())
    }

    /// Whether some frames are shifted and others not.
    fn shifted_in_part(&self) -> bool {
        self.shifted != 0 && self.shifted != self.len()
    }

    fn ts_as_read(&self, j: usize) -> i64 {
        i64::from_le_bytes(self.ts_ns[j * 8..j * 8 + 8].try_into().unwrap())
    }

    fn ts(&self, j: usize) -> i64 {
        if j < self.shifted {
            self.ts_as_read(j).saturating_add(self.shift_ns)
        } else {
            self.ts_as_read(j)
        }
    }

    /// The bytes stored for frame `j`: its payload, or a remote frame's DLC.
    fn stored(&self, j: usize) -> &'a [u8] {
        &self.data[u32_at(self.data_start, j) as usize..u32_at(self.data_start, j + 1) as usize]
    }

    /// Frame `j`'s payload, as [`FrameStore::frame`] reads it.
    fn payload(&self, j: usize) -> &'a [u8] {
        if self.flags[j] & flags::RTR == 0 {
            self.stored(j)
        } else {
            &[]
        }
    }

    /// Frame `j` on the buses `buses` numbers, with its bytes as stored.
    fn frame(&self, j: usize, buses: &[u8]) -> (FrameRef<'a>, &'a [u8]) {
        let frame = FrameRef {
            ts_ns: self.ts(j),
            channel: buses[usize::from(self.channel[j])],
            id: u32_at(self.id, j),
            flags: self.flags[j],
            data: self.payload(j),
        };
        (frame, self.stored(j))
    }

    /// The payload of the first frame of `kind` among `part`'s, empty if there is none.
    fn first_payload_of_kind(&self, part: &SegmentId<'_>, kind: usize) -> &'a [u8] {
        part.frames()
            .find(|&j| FrameKind::of(self.flags[j]) as usize == kind)
            .map_or(&[], |j| self.payload(j))
    }
}

impl SegmentId<'_> {
    fn frames(&self) -> impl Iterator<Item = usize> + '_ {
        u32s(self.frames).map(|j| j as usize)
    }

    fn bit_flips(&self) -> impl ExactSizeIterator<Item = u32> + '_ {
        u32s(self.bit_flips)
    }

    /// The statistics of an ID first seen in this segment, on bus `channel`, with the segment's
    /// frames at `rows` and every frame's time shifted by `shift_ns`.
    fn stats(&self, channel: u8, rows: &Rows<'_>, shift_ns: i64) -> IdStats {
        IdStats {
            channel,
            id: self.id,
            flags: self.flags,
            frames: rows.of(self.frames()).collect(),
            first_ts_ns: self.first_ts_ns.saturating_add(shift_ns),
            last_ts_ns: self.last_ts_ns.saturating_add(shift_ns),
            min_len: self.min_len,
            max_len: self.max_len,
            bit_flips: FlipTally::from_counts(self.bit_flips().collect()),
            pairs_by_len: u32s(self.pairs_by_len).collect(),
            last_data: self.last_data.map(|data| data.map(<[u8]>::to_vec)),
            gap_mean_ns: self.gap_mean_ns,
            gap_m2: self.gap_m2,
        }
    }
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], SegmentError> {
        if n > self.0.len() {
            return Err(SegmentError::Malformed);
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn list(&mut self, count: usize, width: usize) -> Result<&'a [u8], SegmentError> {
        self.take(count.checked_mul(width).ok_or(SegmentError::Malformed)?)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], SegmentError> {
        Ok(self.take(N)?.try_into().unwrap())
    }

    fn u8(&mut self) -> Result<u8, SegmentError> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, SegmentError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, SegmentError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn i64(&mut self) -> Result<i64, SegmentError> {
        Ok(i64::from_le_bytes(self.array()?))
    }

    fn len(&mut self) -> Result<usize, SegmentError> {
        Ok(self.u32()? as usize)
    }

    fn payload(&mut self) -> Result<Option<&'a [u8]>, SegmentError> {
        match self.u8()? {
            0 => Ok(None),
            1 => {
                let len = self.len()?;
                if len > MAX_PAYLOAD {
                    return Err(SegmentError::Malformed);
                }
                self.take(len).map(Some)
            }
            _ => Err(SegmentError::Malformed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ERR_FLAG, EXT_FLAG};

    /// A frame as a parser pushes it: its bus by name, and a remote frame's DLC.
    #[derive(Clone)]
    struct Pushed {
        bus: String,
        ts_ns: i64,
        id: u32,
        flags: u8,
        data: Vec<u8>,
        remote_dlc: Option<u8>,
    }

    fn push_into(store: &mut FrameStore, frames: &[Pushed]) {
        for f in frames {
            let frame = FrameRef {
                ts_ns: f.ts_ns,
                channel: store.channel_index(f.bus.as_bytes()),
                id: f.id,
                flags: f.flags,
                data: &f.data,
            };
            match f.remote_dlc {
                Some(dlc) => store.push_remote(frame, dlc),
                None => store.push(frame),
            }
        }
    }

    fn frame(bus: &str, ts_ns: i64, id: u32, data: &[u8]) -> Pushed {
        Pushed {
            bus: bus.to_owned(),
            ts_ns,
            id,
            flags: 0,
            data: data.to_vec(),
            remote_dlc: None,
        }
    }

    /// A BAM announcing 10 bytes of DM1 from source 0x21, and its two packets.
    fn bam(bus: &str, ts_ns: i64) -> Vec<Pushed> {
        let id = |pf: u32| EXT_FLAG | 0x1800_0000 | (pf << 16) | 0xFF21;
        vec![
            frame(bus, ts_ns, id(0xEC), &[32, 10, 0, 2, 0xFF, 0xCA, 0xFE, 0]),
            frame(bus, ts_ns + 1, id(0xEB), &[1, 1, 2, 3, 4, 5, 6, 7]),
            frame(
                bus,
                ts_ns + 2,
                id(0xEB),
                &[2, 8, 9, 10, 0xFF, 0xFF, 0xFF, 0xFF],
            ),
        ]
    }

    /// Frames that exercise what a join carries over: buses and IDs first seen in a later part,
    /// every kind of frame, payloads that grow, time going backwards, and a J1939 transfer.
    fn log() -> Vec<Pushed> {
        let mut frames = vec![
            frame("can1", 1_000, 0x100, &[0x00, 0xFF]),
            frame("can1", 1_013, 0x200, &[1]),
            Pushed {
                remote_dlc: Some(2),
                flags: flags::RTR,
                ..frame("can1", 1_020, 0x100, &[])
            },
            frame("can1", 1_031, 0x100, &[0x01, 0xFF, 0x80]),
            Pushed {
                flags: flags::ERROR,
                ..frame("can1", 1_040, ERR_FLAG | 0x4, &[0, 4, 0, 0, 0, 0, 0, 0])
            },
            frame("vcan0", 1_050, 0x100, &[0x07]),
            frame("can1", 1_055, 0x100, &[0x03, 0x7F, 0x80, 0x01]),
            Pushed {
                flags: flags::FD | flags::BRS,
                ..frame("can1", 1_070, 0x300, &[0xAA; 32])
            },
            frame("can1", 1_060, 0x200, &[3]),
            Pushed {
                flags: flags::RTR,
                ..frame("can1", 1_080, 0x100, &[])
            },
        ];
        frames.extend(bam("vcan0", 1_100));
        frames.extend([
            frame("can2", 1_200, 0x100, &[0x00, 0x00]),
            Pushed {
                flags: flags::FD,
                ..frame("can1", 1_210, 0x300, &[0x55; 64])
            },
            frame("can1", 1_217, 0x100, &[0xFF, 0x00, 0x80, 0x01, 0x02]),
            Pushed {
                flags: flags::ERROR,
                ..frame("can1", 1_220, ERR_FLAG | 0x4, &[0, 8, 0, 0, 0, 0, 0, 0])
            },
            frame("can1", 1_250, 0x200, &[2, 9]),
            frame("can1", 1_260, 0x100, &[0xFF, 0x01]),
        ]);
        frames
    }

    /// `frames` read as one log, the first part into the store itself and the others each
    /// into a segment store, joined in order.
    fn read_in_parts(frames: &[Pushed], cuts: &[usize]) -> FrameStore {
        let mut store = FrameStore::new();
        let mut bounds = vec![0];
        bounds.extend_from_slice(cuts);
        bounds.push(frames.len());
        push_into(&mut store, &frames[..bounds[1]]);
        for pair in bounds[1..].windows(2) {
            let mut part = FrameStore::for_segment();
            push_into(&mut part, &frames[pair[0]..pair[1]]);
            store.append_segment(&part.encode_segment()).unwrap();
        }
        store
    }

    fn assert_same(joined: &FrameStore, whole: &FrameStore, what: &str) {
        assert_eq!(joined.len(), whole.len(), "{what}");
        for i in 0..whole.len() {
            assert_eq!(joined.frame(i), whole.frame(i), "{what}: frame {i}");
            assert_eq!(
                joined.remote_dlc(i),
                whole.remote_dlc(i),
                "{what}: frame {i}"
            );
            assert_eq!(
                joined.previous_of_same_kind(i),
                whole.previous_of_same_kind(i),
                "{what}: frame {i}"
            );
        }
        assert_eq!(joined.channels(), whole.channels(), "{what}");
        assert_eq!(joined.out_of_order, whole.out_of_order, "{what}");
        let by_key = |store: &FrameStore| {
            let mut by_key: Vec<_> = store.index.by_key.iter().map(|(&k, &i)| (k, i)).collect();
            by_key.sort_unstable();
            by_key
        };
        assert_eq!(by_key(joined), by_key(whole), "{what}");
        // Debug shows every field, the floating-point gap sums bit for bit among them.
        assert_eq!(
            format!("{:?}", joined.ids()),
            format!("{:?}", whole.ids()),
            "{what}"
        );
        assert_eq!(joined.error_frames(), whole.error_frames(), "{what}");
        assert_eq!(
            joined.reassembled_frames(),
            whole.reassembled_frames(),
            "{what}"
        );
        assert_eq!(joined.heap_bytes(), whole.heap_bytes(), "{what}");
    }

    /// Reads `frames` whole and in parts and compares them as read, then once more after a tail
    /// that sorts them, so that what the join leaves for later frames (open transfers, time
    /// order) is compared too.
    fn assert_parts_read_as_whole(frames: &[Pushed], cuts: &[usize]) {
        let what = format!("cut at {cuts:?}");
        let mut whole = FrameStore::new();
        push_into(&mut whole, frames);
        let mut joined = read_in_parts(frames, cuts);
        whole.shrink_to_fit();
        joined.shrink_to_fit();
        assert_same(&joined, &whole, &what);

        let tail = [
            frame("can3", 900, 0x100, &[0x0F, 0x01]),
            frame("can1", 1_300, 0x400, &[1, 2, 3]),
        ];
        for store in [&mut whole, &mut joined] {
            push_into(store, &tail);
            store.sort_by_time();
            store.shrink_to_fit();
        }
        assert_same(&joined, &whole, &format!("{what}, sorted"));
    }

    #[test]
    fn parts_joined_read_as_the_whole_log_wherever_it_is_cut() {
        let frames = log();
        assert_eq!(frames.len(), 19);
        for cut in 0..=frames.len() {
            assert_parts_read_as_whole(&frames, &[cut]);
        }
        for a in 0..=frames.len() {
            for b in a..=frames.len() {
                assert_parts_read_as_whole(&frames, &[a, b]);
            }
        }
        let every_frame: Vec<usize> = (1..frames.len()).collect();
        assert_parts_read_as_whole(&frames, &every_frame);
    }

    #[test]
    fn a_segment_joins_with_its_first_frames_shifted_as_if_pushed_at_their_shifted_times() {
        // With and without the transfer, whose ID is counted frame by frame where it completes.
        let mut without_transfer = log();
        without_transfer.drain(10..13);
        for frames in [log(), without_transfer] {
            assert_shifted_parts_read_as_whole(&frames);
        }
    }

    fn assert_shifted_parts_read_as_whole(frames: &[Pushed]) {
        let mut whole = FrameStore::new();
        push_into(&mut whole, frames);
        whole.shrink_to_fit();
        for cut in 0..=frames.len() {
            for shifted in 0..=frames.len() - cut {
                let mut store = FrameStore::new();
                push_into(&mut store, &frames[..cut]);
                let mut early = frames[cut..].to_vec();
                for frame in &mut early[..shifted] {
                    frame.ts_ns -= 5_000;
                }
                let mut part = FrameStore::for_segment();
                push_into(&mut part, &early);
                let shift = TimeShift {
                    frames: shifted,
                    ns: 5_000,
                };
                store
                    .append_shifted_segment(&part.encode_segment(), shift)
                    .unwrap();
                store.shrink_to_fit();
                assert_same(&store, &whole, &format!("cut at {cut}, {shifted} shifted"));
            }
        }
    }

    #[test]
    fn a_shift_past_the_segment_or_out_of_range_is_refused() {
        let mut part = FrameStore::for_segment();
        push_into(
            &mut part,
            &[
                frame("can0", i64::MAX - 10, 0x100, &[1]),
                frame("can0", 0, 0x100, &[2]),
            ],
        );
        let bytes = part.encode_segment();
        let join =
            |frames, ns| FrameStore::new().append_shifted_segment(&bytes, TimeShift { frames, ns });
        assert_eq!(join(1, 10), Ok(()));
        assert_eq!(join(1, 11), Err(SegmentError::TimeOverflow));
        assert_eq!(join(2, 11), Err(SegmentError::TimeOverflow));
        assert_eq!(join(0, i64::MAX), Ok(()));
        assert_eq!(join(3, 0), Err(SegmentError::Malformed));
    }

    #[test]
    fn pairs_across_a_cut_count_as_read_whole() {
        let mut frames = Vec::new();
        for (t, len) in [8, 2, 8, 64].into_iter().enumerate() {
            let t = t as i64;
            frames.push(Pushed {
                remote_dlc: Some(1),
                flags: flags::RTR,
                ..frame("can0", t * 20, 0x100, &[])
            });
            frames.push(Pushed {
                flags: if len > 8 { flags::FD } else { 0 },
                ..frame("can0", t * 20 + 10, 0x100, &vec![t as u8; len])
            });
        }
        frames.push(Pushed {
            flags: flags::ERROR,
            ..frame("can0", 100, ERR_FLAG | 0x4, &[0, 4, 0, 0, 0, 0, 0, 0])
        });
        frames.push(Pushed {
            flags: flags::ERROR,
            ..frame("can0", 110, ERR_FLAG | 0x4, &[0, 8, 0, 0, 0, 0, 0, 0])
        });
        let pairs = |store: &FrameStore| {
            store
                .ids()
                .iter()
                .map(|stats| stats.flip_counts().pairs)
                .collect::<Vec<_>>()
        };
        // The data frames pair over 2, 2 and 8 bytes, and the remote frames not at all; the
        // error frames over 8.
        let mut data = vec![0; 64];
        data[..8].fill(1);
        data[..2].fill(3);
        let expected = [data, vec![1; 8]];
        let mut whole = FrameStore::new();
        push_into(&mut whole, &frames);
        assert_eq!(pairs(&whole), expected);
        for cut in 0..=frames.len() {
            assert_eq!(
                pairs(&read_in_parts(&frames, &[cut])),
                expected,
                "cut at {cut}"
            );
        }
        let every_frame: Vec<usize> = (1..frames.len()).collect();
        assert_eq!(pairs(&read_in_parts(&frames, &every_frame)), expected);
    }

    #[test]
    fn a_transfer_spanning_parts_is_reassembled_once() {
        let frames = bam("can1", 0);
        for cut in 0..=frames.len() {
            let mut store = read_in_parts(&frames, &[cut]);
            store.shrink_to_fit();
            assert_eq!(store.reassembled_frames(), 1, "cut at {cut}");
            let last = store.frame(store.len() - 1);
            assert_eq!(last.flags, flags::REASSEMBLED);
            assert_eq!(last.data, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            let mut whole = FrameStore::new();
            push_into(&mut whole, &frames);
            whole.shrink_to_fit();
            assert_same(&store, &whole, &format!("cut at {cut}"));
        }
    }

    /// Frames as their IDs and payloads.
    type Frames = Vec<(u32, Vec<u8>)>;

    /// The TP.CM announcement of `data` as PGN `pgn` from `source` to `destination` (a BAM
    /// to 0xFF, an RTS otherwise), then its TP.DT packets, as IDs and payloads.
    fn transfer(source: u32, destination: u32, pgn: u32, data: &[u8]) -> Frames {
        let control = if destination == 0xFF { 32 } else { 16 };
        let packets = data.len().div_ceil(7) as u8;
        let size = (data.len() as u16).to_le_bytes();
        let [pgn_lo, pgn_mid, pgn_hi, _] = pgn.to_le_bytes();
        let addresses = (destination << 8) | source;
        let mut frames = vec![(
            EXT_FLAG | 0x18EC_0000 | addresses,
            vec![
                control, size[0], size[1], packets, 0xFF, pgn_lo, pgn_mid, pgn_hi,
            ],
        )];
        for (n, chunk) in data.chunks(7).enumerate() {
            let mut packet = vec![n as u8 + 1];
            packet.extend_from_slice(chunk);
            packet.resize(8, 0xFF);
            frames.push((EXT_FLAG | 0x18EB_0000 | addresses, packet));
        }
        frames
    }

    /// The frames of each stream in turn, one from each until all are done.
    fn interleave(streams: Vec<Frames>) -> Frames {
        let longest = streams.iter().map(Vec::len).max().unwrap_or(0);
        (0..longest)
            .flat_map(|n| streams.iter().filter_map(move |s| s.get(n).cloned()))
            .collect()
    }

    /// A log that is mostly J1939 transfers: BAMs from several sources at once with their
    /// packets interleaved, one aborted and one announced again before it was done, an RTS, a
    /// transfer on a second bus, DM1 single frames on the ID a DM1 transfer is reassembled to,
    /// a transfer onto the ID of its own packets, and plain frames, some of IDs first seen after
    /// the first transfers.
    fn j1939_log() -> Vec<Pushed> {
        let single_dm1 = |lamp: u8| {
            (
                EXT_FLAG | 0x18FE_CA21,
                vec![lamp, 0xFF, 0x61, 0x02, 0x13, 0x01, 0xFF, 0xFF],
            )
        };
        let plain = |id: u32, n: u8| (id, vec![n, n.wrapping_mul(3), 0x80]);
        let bytes = |len: usize, seed: u8| -> Vec<u8> {
            (0..len)
                .map(|i| seed.wrapping_mul(i as u8 + 1) ^ 0x5A)
                .collect()
        };
        let mut aborted = transfer(0x23, 0xFF, 0xFECA, &bytes(16, 3));
        aborted.truncate(2);
        aborted.push((
            EXT_FLAG | 0x18EC_FF23,
            vec![255, 3, 0xFF, 0xFF, 0xFF, 0xCA, 0xFE, 0x00],
        ));
        let mut announced_again = transfer(0x24, 0xFF, 0xFEE3, &bytes(13, 4));
        announced_again.truncate(2);
        announced_again.extend(transfer(0x24, 0xFF, 0xFEE3, &bytes(13, 5)));

        let mut rows = vec![plain(0x100, 0), single_dm1(0x04)];
        rows.extend(interleave(vec![
            transfer(0x21, 0xFF, 0xFECA, &bytes(10, 1)),
            transfer(0x22, 0xFF, 0xFEE3, &bytes(20, 2)),
            aborted,
            (1..4).map(|n| plain(0x100, n)).collect(),
        ]));
        rows.push(plain(0x300, 0));
        // The ID the transfer from 0x22 was reassembled to, now as a frame of its own.
        rows.push(plain(EXT_FLAG | 0x18FE_E322, 0));
        rows.push(single_dm1(0x44));
        rows.extend(interleave(vec![
            transfer(0x21, 0xFF, 0xFECA, &bytes(10, 6)),
            announced_again,
            transfer(0x25, 0x00, 0xFEDA, &bytes(9, 7)),
            vec![single_dm1(0x40), plain(0x300, 1), plain(0x100, 4)],
        ]));
        // PGN 0xEB00 to everyone from 0x26 is reassembled onto the ID of its own packets.
        rows.extend(transfer(0x26, 0xFF, 0xEB00, &bytes(8, 8)));
        rows.push(plain(0x100, 5));
        let mut frames: Vec<Pushed> = rows
            .into_iter()
            .enumerate()
            .map(|(n, (id, data))| frame("can1", 1_000 + 10 * n as i64, id, &data))
            .collect();
        // The same transfer from 0x21 on another bus, among the frames above.
        let other_bus = transfer(0x21, 0xFF, 0xFECA, &bytes(10, 9));
        for (k, (id, data)) in other_bus.into_iter().enumerate() {
            let at = 5 + 7 * k;
            let ts_ns = frames[at].ts_ns;
            frames.insert(at, frame("can2", ts_ns, id, &data));
        }
        frames
    }

    #[test]
    fn a_j1939_log_reads_the_same_in_parts_wherever_it_is_cut() {
        let frames = j1939_log();
        let mut whole = FrameStore::new();
        push_into(&mut whole, &frames);
        // Both DM1 transfers from 0x21 on can1, the one from 0x22, the second from 0x24, the
        // RTS, the transfer onto its own packets' ID, and the one on can2.
        assert_eq!(whole.reassembled_frames(), 7);
        let dm1 = whole.id_stats(id_key(0, EXT_FLAG | 0x18FE_CA21)).unwrap();
        assert_eq!(dm1.frames.len(), 5, "three single frames and two transfers");

        for a in 0..=frames.len() {
            for b in a..=frames.len() {
                assert_parts_read_as_whole(&frames, &[a, b]);
            }
        }
        let every_frame: Vec<usize> = (1..frames.len()).collect();
        assert_parts_read_as_whole(&frames, &every_frame);
        let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
        for _ in 0..200 {
            let mut cuts: Vec<usize> = (0..1 + seed % 8)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    (seed % (frames.len() as u64 + 1)) as usize
                })
                .collect();
            cuts.sort_unstable();
            assert_parts_read_as_whole(&frames, &cuts);
        }
        assert_shifted_parts_read_as_whole(&frames);
    }

    /// A seeded xorshift generator, so a failing case can be read again from its seed.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }
    }

    /// A random log of J1939 traffic on two buses: transfers from sources whose packets
    /// interleave, some cut short and some onto the IDs of TP.CM and TP.DT packets, runs of
    /// single and remote frames (up to 300, past where bit flips are folded) on the IDs DM1 and
    /// 0xFEE3 transfers are reassembled to, plain frames, and times that sometimes go back.
    fn random_j1939_log(rng: &mut Rng) -> Vec<Pushed> {
        const PGNS: [u32; 4] = [0xFECA, 0xFEE3, 0xEB00, 0xEC00];
        let mut frames = Vec::new();
        // Each open transfer's bus and the packets it has left to send, last first.
        let mut open: Vec<(&str, Frames)> = Vec::new();
        let mut t = 1_000;
        let len = 100 + rng.below(300);
        while frames.len() < len || !open.is_empty() {
            t += 1 + rng.below(1000) as i64;
            let ts_ns = if rng.below(100) < 4 {
                t - rng.below(5000) as i64
            } else {
                t
            };
            let bus = if rng.below(5) == 0 { "can2" } else { "can1" };
            match rng.below(12) {
                0 if open.len() < 4 && frames.len() < len => {
                    let source = 0x21 + rng.below(4) as u32;
                    let destination = if rng.below(4) == 0 { 0x00 } else { 0xFF };
                    let data: Vec<u8> = (0..9 + rng.below(50))
                        .map(|_| rng.below(256) as u8)
                        .collect();
                    let mut packets = transfer(source, destination, PGNS[rng.below(4)], &data);
                    if rng.below(5) == 0 {
                        packets.truncate(1 + rng.below(packets.len()));
                    }
                    packets.reverse();
                    open.push((bus, packets));
                }
                1 if frames.len() < len => {
                    let id = EXT_FLAG | 0x1800_0000 | (PGNS[rng.below(2)] << 8) | 0x21;
                    let run = if rng.below(8) == 0 {
                        rng.below(300)
                    } else {
                        rng.below(5)
                    };
                    for n in 0..run {
                        let mut single = frame(
                            bus,
                            ts_ns + n as i64,
                            id,
                            &[rng.below(4) as u8, 0xFF, 0x61, 0x02],
                        );
                        if rng.below(10) == 0 {
                            single.flags = flags::RTR;
                            single.data.clear();
                            single.remote_dlc = Some(8);
                        }
                        frames.push(single);
                    }
                    t += run as i64;
                }
                2 if frames.len() < len => {
                    frames.push(frame(bus, ts_ns, 0x100, &[rng.below(256) as u8]))
                }
                _ if !open.is_empty() => {
                    let k = rng.below(open.len());
                    let (bus, packets) = &mut open[k];
                    let (id, data) = packets.pop().unwrap();
                    frames.push(frame(bus, ts_ns, id, &data));
                    if packets.is_empty() {
                        open.swap_remove(k);
                    }
                }
                _ => {}
            }
        }
        frames
    }

    #[test]
    fn random_j1939_logs_read_the_same_in_parts_as_whole() {
        let logs = if cfg!(debug_assertions) { 30 } else { 300 };
        let mut transfers = 0;
        for seed in 1..=logs {
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
            let frames = random_j1939_log(&mut rng);
            let mut cuts: Vec<usize> = (0..1 + rng.below(10))
                .map(|_| rng.below(frames.len() + 1))
                .collect();
            cuts.sort_unstable();
            assert_parts_read_as_whole(&frames, &cuts);

            // The last part joined with all its times shifted.
            let mut whole = FrameStore::new();
            push_into(&mut whole, &frames);
            whole.shrink_to_fit();
            transfers += whole.reassembled_frames();
            let last = cuts[cuts.len() - 1];
            let mut store = read_in_parts(&frames[..last], &cuts[..cuts.len() - 1]);
            let mut early = frames[last..].to_vec();
            for frame in &mut early {
                frame.ts_ns -= 7_000;
            }
            let mut part = FrameStore::for_segment();
            push_into(&mut part, &early);
            let shift = TimeShift {
                frames: early.len(),
                ns: 7_000,
            };
            store
                .append_shifted_segment(&part.encode_segment(), shift)
                .unwrap();
            store.shrink_to_fit();
            assert_same(
                &store,
                &whole,
                &format!("seed {seed}, cut at {cuts:?}, shifted"),
            );
        }
        assert!(transfers > logs as usize, "{transfers} transfers");
    }

    #[test]
    fn a_log_with_more_buses_than_numbers_joins_or_is_refused() {
        let frames: Vec<Pushed> = (0..300)
            .map(|i| frame(&format!("b{i}"), i, 0x100 + (i as u32 % 3), &[i as u8]))
            .collect();
        // The store runs out of numbers in the part, so the part's last buses share one.
        assert_parts_read_as_whole(&frames, &[200]);
        // A part that ran out of numbers itself can't tell its last buses apart.
        let mut part = FrameStore::for_segment();
        push_into(&mut part, &frames);
        assert_eq!(
            FrameStore::new().append_segment(&part.encode_segment()),
            Err(SegmentError::TooManyBuses)
        );
    }

    #[test]
    fn a_damaged_segment_is_refused_without_panicking() {
        let mut part = FrameStore::for_segment();
        push_into(&mut part, &log());
        let bytes = part.encode_segment();
        for len in 0..bytes.len() {
            assert_eq!(
                FrameStore::new().append_segment(&bytes[..len]),
                Err(SegmentError::Malformed),
                "cut to {len} bytes"
            );
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert_eq!(
            FrameStore::new().append_segment(&longer),
            Err(SegmentError::Malformed)
        );
        assert_eq!(FrameStore::new().append_segment(&bytes), Ok(()));
    }

    #[test]
    fn a_segment_whose_ids_do_not_own_each_frame_once_is_refused() {
        let mut part = FrameStore::for_segment();
        push_into(
            &mut part,
            &[frame("can0", 1, 0x100, &[1]), frame("can0", 2, 0x200, &[2])],
        );
        let bytes = part.encode_segment();
        // Magic, frame count, bus count, then "can0" with its length, then two times.
        let ids_at = 4 + 4 + 4 + 4 + 4 + 2 * 8;
        assert_eq!(bytes[ids_at..ids_at + 4], 0x100u32.to_le_bytes());
        let mut moved = bytes.clone();
        moved[ids_at..ids_at + 4].copy_from_slice(&0x200u32.to_le_bytes());
        assert_eq!(
            FrameStore::new().append_segment(&moved),
            Err(SegmentError::Malformed)
        );
        assert_eq!(FrameStore::new().append_segment(&bytes), Ok(()));
    }

    #[test]
    fn a_segment_that_lists_an_id_twice_is_refused() {
        let mut part = FrameStore::for_segment();
        push_into(
            &mut part,
            &[frame("can0", 1, 0x100, &[1]), frame("can0", 2, 0x200, &[2])],
        );
        let bytes = part.encode_segment();
        // Make frame 1 and its ID's entry 0x100 as well: two entries for one ID, each owning a
        // frame of its own. The entry is found by its ID, flags and first time.
        let ids_at = 4 + 4 + 4 + 4 + 4 + 2 * 8;
        let mut entry = 0x200u32.to_le_bytes().to_vec();
        entry.push(0);
        entry.extend_from_slice(&2i64.to_le_bytes());
        let entry_id = bytes
            .windows(entry.len())
            .rposition(|w| w == entry)
            .unwrap();
        let mut twice = bytes.clone();
        twice[ids_at + 4..ids_at + 8].copy_from_slice(&0x100u32.to_le_bytes());
        twice[entry_id..entry_id + 4].copy_from_slice(&0x100u32.to_le_bytes());
        assert_eq!(
            FrameStore::new().append_segment(&twice),
            Err(SegmentError::Malformed)
        );
        // The same edit to an ID the segment doesn't have is accepted: it is the repeat that isn't.
        let mut sole = bytes.clone();
        sole[ids_at + 4..ids_at + 8].copy_from_slice(&0x300u32.to_le_bytes());
        sole[entry_id..entry_id + 4].copy_from_slice(&0x300u32.to_le_bytes());
        assert_eq!(FrameStore::new().append_segment(&sole), Ok(()));
    }
}
