use std::borrow::Cow;
use std::collections::TryReserveError;
use std::fmt;
use std::ops::Range;

use rustc_hash::FxHashMap;

mod flips;
mod segment;

pub use segment::{SegmentError, TimeShift};

use flips::FlipTally;

use crate::chunked::{Column, Payloads};
use crate::{flags, tp, FrameKind, FrameRef, FrameSink, EXT_FLAG};

/// Identifies one arbitration ID on one channel: `(channel << 32) | id`.
pub type IdKey = u64;

#[must_use]
pub fn id_key(channel: u8, id: u32) -> IdKey {
    (u64::from(channel) << 32) | u64::from(id)
}

/// Statistics for one arbitration ID, maintained while frames are ingested.
#[derive(Debug, Clone)]
pub struct IdStats {
    pub channel: u8,
    pub id: u32,
    /// Union of the flags of every frame seen.
    pub flags: u8,
    /// Store indices of every frame with this ID, in store order.
    pub frames: Vec<u32>,
    pub first_ts_ns: i64,
    pub last_ts_ns: i64,
    /// Payload lengths in bytes. Above [`crate::MAX_PAYLOAD`] only for reassembled frames.
    pub min_len: u16,
    pub max_len: u16,
    /// See [`IdStats::bit_flips`].
    bit_flips: FlipTally,
    /// The pairs of frames `bit_flips` compared, by the length of the shorter payload of each,
    /// which is how many bytes the pair was compared over: index `n` counts the pairs over `n`
    /// bytes. Pairs over no byte, such as two remote frames, are left out. See
    /// [`IdStats::flip_counts`].
    pairs_by_len: Vec<u32>,
    /// The payload of the last frame of each kind, indexed by `FrameKind as usize`.
    last_data: [Option<Vec<u8>>; 4],
    gap_mean_ns: f64,
    /// Sum of squared deviations of the gaps from their mean (Welford's algorithm).
    gap_m2: f64,
}

impl IdStats {
    fn new(channel: u8, id: u32, ts_ns: i64) -> Self {
        Self {
            channel,
            id,
            flags: 0,
            frames: Vec::new(),
            first_ts_ns: ts_ns,
            last_ts_ns: ts_ns,
            min_len: u16::MAX,
            max_len: 0,
            bit_flips: FlipTally::default(),
            pairs_by_len: Vec::new(),
            last_data: Default::default(),
            gap_mean_ns: 0.0,
            gap_m2: 0.0,
        }
    }

    #[must_use]
    pub fn key(&self) -> IdKey {
        id_key(self.channel, self.id)
    }

    /// Mean interval between frames in nanoseconds, once at least two frames were seen.
    #[must_use]
    pub fn mean_period_ns(&self) -> Option<f64> {
        let n = self.frames.len();
        (n > 1).then(|| (self.last_ts_ns - self.first_ts_ns) as f64 / (n - 1) as f64)
    }

    /// Standard deviation of the intervals between frames in nanoseconds, once at least three
    /// frames were seen.
    #[must_use]
    pub fn jitter_ns(&self) -> Option<f64> {
        let gaps = self.frames.len().checked_sub(1)?;
        (gaps >= 2).then(|| (self.gap_m2 / gaps as f64).sqrt())
    }

    /// How often each payload bit changed from the previous frame of this ID and the same
    /// [`FrameKind`], as [`FrameStore::previous_of_same_kind`] pairs them, indexed by
    /// `byte * 8 + bit` where bit 0 is the least significant bit of the byte. One count per bit
    /// of the longest payload.
    #[must_use]
    pub fn bit_flips(&self) -> Cow<'_, [u32]> {
        self.bit_flips.counts()
    }

    /// [`IdStats::bit_flips`] with, per byte, the pairs of frames its bits were compared in.
    #[must_use]
    pub fn flip_counts(&self) -> FlipCounts {
        FlipCounts::new(self.bit_flips().into_owned(), &self.pairs_by_len)
    }

    fn observe(&mut self, index: u32, frame: &FrameRef<'_>) {
        let len = frame.data.len();
        self.bit_flips.grow(len);
        match &mut self.last_data[FrameKind::of(frame.flags) as usize] {
            Some(last) => {
                count_pair(&mut self.pairs_by_len, last.len().min(len));
                self.bit_flips.add_pair(last, frame.data);
                set_last_data(last, frame.data);
            }
            none => *none = Some(frame.data.to_vec()),
        }
        self.observe_time(index, frame.ts_ns);
        self.flags |= frame.flags;
        let len16 = len as u16;
        self.min_len = self.min_len.min(len16);
        self.max_len = self.max_len.max(len16);
    }

    /// The part of [`IdStats::observe`] that depends on the order of every frame of the ID:
    /// the frame list and the gaps, which [`FrameStore::append_segment`] redoes frame by frame.
    fn observe_time(&mut self, index: u32, ts_ns: i64) {
        if !self.frames.is_empty() {
            let gap = (ts_ns - self.last_ts_ns) as f64;
            let delta = gap - self.gap_mean_ns;
            self.gap_mean_ns += delta / self.frames.len() as f64;
            self.gap_m2 += delta * (gap - self.gap_mean_ns);
        }
        self.frames.push(index);
        self.last_ts_ns = ts_ns;
    }
}

fn set_last_data(last: &mut Vec<u8>, data: &[u8]) {
    last.clear();
    last.extend_from_slice(data);
}

/// How often each payload bit of an ID changed, with the pairs of frames each byte was compared
/// in: the pairs that both have the byte, which may be fewer than all the pairs when payload
/// lengths vary. A bit's share of changes is its flips over its byte's pairs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlipCounts {
    /// Indexed `byte * 8 + bit`, as [`IdStats::bit_flips`].
    pub flips: Vec<u32>,
    /// One count per byte of `flips`.
    pub pairs: Vec<u32>,
}

impl FlipCounts {
    /// `flips`, with the pairs of frames `pairs_by_len` counts by their bytes in common.
    fn new(flips: Vec<u32>, pairs_by_len: &[u32]) -> Self {
        let mut pairs = vec![0; flips.len() / 8];
        let mut longer = 0;
        for byte in (0..pairs.len()).rev() {
            longer += pairs_by_len.get(byte + 1).copied().unwrap_or(0);
            pairs[byte] = longer;
        }
        Self { flips, pairs }
    }
}

/// Counts a pair of frames whose payloads have `common` bytes in common.
fn count_pair(pairs_by_len: &mut Vec<u32>, common: usize) {
    if common == 0 {
        return;
    }
    if pairs_by_len.len() <= common {
        pairs_by_len.resize(common + 1, 0);
    }
    pairs_by_len[common] += 1;
}

/// Bits one frame occupies on the bus, without stuff bits but including the 3-bit interframe
/// space. CAN FD frames are counted as if sent entirely at the nominal bitrate, which
/// overestimates frames sent with bit rate switching.
#[must_use]
pub fn frame_bits(id: u32, frame_flags: u8, len: usize) -> u32 {
    let extended = id & EXT_FLAG != 0;
    let overhead = if frame_flags & flags::FD == 0 {
        if extended {
            67
        } else {
            47
        }
    } else {
        // FD adds the FDF, BRS and ESI bits, a 4-bit stuff count and a longer CRC: 17 bits,
        // or 21 above 16 data bytes.
        let crc_extra = if len > 16 { 4 } else { 0 };
        crc_extra + if extended { 75 } else { 56 }
    };
    let data = if frame_flags & flags::RTR == 0 {
        len
    } else {
        0
    };
    overhead + 8 * data as u32
}

/// Which of `buckets` equal buckets over `[t0_ns, t1_ns]` holds `ts_ns`. The end of the range
/// belongs to the last bucket.
fn bucket_of(ts_ns: i64, t0_ns: i64, t1_ns: i64, buckets: usize) -> usize {
    let fraction = (ts_ns - t0_ns) as f64 / (t1_ns - t0_ns) as f64;
    ((fraction * buckets as f64) as usize).min(buckets - 1)
}

/// Columnar store of every frame in a log, plus one synthesised frame per J1939 transport
/// protocol transfer completed in it ([`tp`]).
///
/// Classic frames cost 26 bytes each on wasm32 (plus 4 in the per-ID index), so ten
/// million frames fit comfortably under the 4 GB wasm32 address space. The columns grow
/// 4 MiB at a time, so they hold little more than the frames.
#[derive(Debug, Default)]
pub struct FrameStore {
    ts_ns: Column<i64>,
    id: Column<u32>,
    channel: Column<u8>,
    flags: Column<u8>,
    /// Where each frame's payload is in `data`.
    data_start: Column<usize>,
    data: Payloads,
    channels: Vec<String>,
    index: IdIndex,
    error_frames: usize,
    reassembler: tp::Reassembler,
    reassembled_frames: usize,
    /// A frame came earlier than one before it, so [`FrameStore::sort_by_time`] has work.
    out_of_order: bool,
    /// [`FrameStore::drop_before`] dropped frames, perhaps the first packets of transfers
    /// already reassembled.
    trimmed: bool,
    /// A part of a log read apart from the rest, whose transfers the store it joins finds.
    segment: bool,
}

/// The [`IdStats`] of every ID, in order of first appearance.
struct IdIndex {
    by_key: FxHashMap<IdKey, usize>,
    ids: Vec<IdStats>,
    /// IDs looked up lately, each in the slot its key hashes to: a log's busy IDs take turns,
    /// and finding them here costs less than in `by_key`.
    recent: [(IdKey, usize); RECENT_SLOTS],
}

const RECENT_SLOTS: usize = 256;

/// No ID's key: channels and IDs take 40 bits.
const NO_KEY: IdKey = IdKey::MAX;

/// Without `recent`, a cache of `by_key`.
impl fmt::Debug for IdIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdIndex")
            .field("by_key", &self.by_key)
            .field("ids", &self.ids)
            .finish_non_exhaustive()
    }
}

impl Default for IdIndex {
    fn default() -> Self {
        Self {
            by_key: FxHashMap::default(),
            ids: Vec::new(),
            recent: [(NO_KEY, 0); RECENT_SLOTS],
        }
    }
}

impl IdIndex {
    fn observe(&mut self, index: u32, frame: &FrameRef<'_>) {
        let stats = self.stats_index(id_key(frame.channel, frame.id), frame);
        self.ids[stats].observe(index, frame);
    }

    fn stats_index(&mut self, key: IdKey, frame: &FrameRef<'_>) -> usize {
        let slot =
            (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> (64 - RECENT_SLOTS.ilog2())) as usize;
        let (recent_key, i) = self.recent[slot];
        if recent_key == key {
            return i;
        }
        let next = self.ids.len();
        let i = *self.by_key.entry(key).or_insert(next);
        if i == next {
            self.ids
                .push(IdStats::new(frame.channel, frame.id, frame.ts_ns));
        }
        self.recent[slot] = (key, i);
        i
    }
}

/// A frame of the store as [`FrameStore::sort_by_time`] reorders it.
enum Row<'a> {
    /// The frame at this index before the sort.
    Logged(usize),
    /// A transfer completed by the logged frame at this index.
    Reassembled(usize, &'a tp::Transfer),
}

/// Calls `visit` for each frame in time order: the logged frames as `order` lists them, each
/// followed by the transfer it completed, if any, as [`FrameSink::push`] stores them.
fn for_each_row(
    order: &[u32],
    transfers: &[(usize, tp::Transfer)],
    mut visit: impl FnMut(Row<'_>),
) {
    let mut transfers = transfers.iter().peekable();
    for (position, &index) in order.iter().enumerate() {
        visit(Row::Logged(index as usize));
        if let Some((_, transfer)) = transfers.next_if(|(at, _)| *at == position) {
            visit(Row::Reassembled(index as usize, transfer));
        }
    }
}

/// `column` in the order [`for_each_row`] visits, a transfer taking `reassembled` of the value
/// of the frame that completed it.
fn reorder<T: Copy>(
    column: &Column<T>,
    order: &[u32],
    transfers: &[(usize, tp::Transfer)],
    reassembled: impl Fn(T, &tp::Transfer) -> T,
) -> Column<T> {
    let mut reordered = Column::default();
    for_each_row(order, transfers, |row| {
        reordered.push(match row {
            Row::Logged(i) => column[i],
            Row::Reassembled(i, transfer) => reassembled(column[i], transfer),
        });
    });
    reordered
}

impl FrameStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A store for one part of a log, read apart from the parts before it and joined onto the
    /// store that read them with [`FrameStore::append_segment`]. It leaves J1939 transfers to
    /// that store, as their packets may span parts.
    #[must_use]
    pub fn for_segment() -> Self {
        Self {
            segment: true,
            ..Self::default()
        }
    }

    /// Pre-allocate for roughly `frames` more frames carrying `payload_bytes` of data in
    /// total, as far as memory allows. The columns grow without copying, so this is only
    /// worth it to know the room is there: see [`FrameStore::try_reserve`].
    pub fn reserve(&mut self, frames: usize, payload_bytes: usize) {
        let _ = self.try_reserve(frames, payload_bytes);
    }

    /// [`FrameStore::reserve`], but failing when memory runs out. The per-ID index still
    /// grows as frames are pushed. Room left unused stays until
    /// [`FrameStore::shrink_to_fit`].
    ///
    /// # Errors
    /// When a column can't grow; the frames already stored are untouched.
    pub fn try_reserve(
        &mut self,
        frames: usize,
        payload_bytes: usize,
    ) -> Result<(), TryReserveError> {
        self.ts_ns.try_reserve(frames)?;
        self.id.try_reserve(frames)?;
        self.channel.try_reserve(frames)?;
        self.flags.try_reserve(frames)?;
        self.data_start.try_reserve(frames)?;
        self.data.try_reserve(payload_bytes)
    }

    /// Gives back the room reserved for frames that never came, and trims each ID's frame
    /// list to its length. Call it once the log is read.
    pub fn shrink_to_fit(&mut self) {
        self.ts_ns.release_spare();
        self.id.release_spare();
        self.channel.release_spare();
        self.flags.release_spare();
        self.data_start.release_spare();
        self.data.release_spare();
        // Bit flips too, so their room does not depend on how the frames came in.
        for stats in &mut self.index.ids {
            stats.frames.shrink_to_fit();
            stats.bit_flips.shrink_to_fit();
            stats.pairs_by_len.shrink_to_fit();
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.ts_ns.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ts_ns.len() == 0
    }

    /// # Panics
    /// If `index` is out of bounds.
    #[must_use]
    pub fn frame(&self, index: usize) -> FrameRef<'_> {
        let flags = self.flags[index];
        FrameRef {
            ts_ns: self.ts_ns[index],
            channel: self.channel[index],
            id: self.id[index],
            flags,
            data: if flags & flags::RTR == 0 {
                self.payload(index)
            } else {
                &[]
            },
        }
    }

    /// The DLC a remote frame asked for, when its log gave one. None for other frames.
    #[must_use]
    pub fn remote_dlc(&self, index: usize) -> Option<u8> {
        if self.flags[index] & flags::RTR == 0 {
            return None;
        }
        match self.payload(index) {
            &[dlc] => Some(dlc),
            _ => None,
        }
    }

    /// The bytes stored for frame `index`: its payload, or a remote frame's DLC.
    fn payload(&self, index: usize) -> &[u8] {
        self.data
            .get(self.data_start[index], self.data_start.get(index + 1))
    }

    #[must_use]
    pub fn first_ts_ns(&self) -> Option<i64> {
        self.ts_ns.first()
    }

    #[must_use]
    pub fn last_ts_ns(&self) -> Option<i64> {
        self.ts_ns.last()
    }

    #[must_use]
    pub fn channels(&self) -> &[String] {
        &self.channels
    }

    /// Frames carrying the [`flags::ERROR`] flag.
    #[must_use]
    pub fn error_frames(&self) -> usize {
        self.error_frames
    }

    /// Frames carrying the [`flags::REASSEMBLED`] flag: J1939 transport protocol transfers
    /// completed in the log, each stored as one frame after its last packet.
    #[must_use]
    pub fn reassembled_frames(&self) -> usize {
        self.reassembled_frames
    }

    /// Every distinct ID, in order of first appearance.
    #[must_use]
    pub fn ids(&self) -> &[IdStats] {
        &self.index.ids
    }

    #[must_use]
    pub fn id_stats(&self, key: IdKey) -> Option<&IdStats> {
        self.index.by_key.get(&key).map(|&i| &self.index.ids[i])
    }

    /// Index of the frame that frame `index`'s payload is compared with: the previous frame
    /// with the same channel, ID and [`FrameKind`], so a polled ID's remote frames don't hide
    /// the changes between its data frames.
    #[must_use]
    pub fn previous_of_same_kind(&self, index: usize) -> Option<usize> {
        let stats = self.id_stats(id_key(self.channel[index], self.id[index]))?;
        let pos = stats.frames.partition_point(|&f| (f as usize) < index);
        self.previous_of_same_kind_at(stats, pos)
    }

    /// [`FrameStore::previous_of_same_kind`] for the frame at `pos` in `stats.frames`.
    #[must_use]
    pub fn previous_of_same_kind_at(&self, stats: &IdStats, pos: usize) -> Option<usize> {
        let kind = FrameKind::of(self.flags[stats.frames[pos] as usize]);
        stats.frames[..pos]
            .iter()
            .rev()
            .map(|&f| f as usize)
            .find(|&f| FrameKind::of(self.flags[f]) == kind)
    }

    /// Index of the first frame at or after `ts_ns`, or `len()` if there is none.
    ///
    /// Time lookups binary-search, so they need the frames in time order: call
    /// [`FrameStore::sort_by_time`] once the log is read.
    #[must_use]
    pub fn first_at_or_after(&self, ts_ns: i64) -> usize {
        self.ts_ns.partition_point(|t| t < ts_ns)
    }

    /// Position in `stats.frames` of the first frame at or after `ts_ns`, or the number of
    /// frames if there is none.
    #[must_use]
    pub fn first_of_id_at_or_after(&self, stats: &IdStats, ts_ns: i64) -> usize {
        stats
            .frames
            .partition_point(|&f| self.ts_ns[f as usize] < ts_ns)
    }

    /// Positions in `stats.frames` of the frames timestamped within `[t0_ns, t1_ns]`.
    #[must_use]
    pub fn id_frames_between(&self, stats: &IdStats, t0_ns: i64, t1_ns: i64) -> Range<usize> {
        let start = self.first_of_id_at_or_after(stats, t0_ns);
        let end = stats
            .frames
            .partition_point(|&f| self.ts_ns[f as usize] <= t1_ns);
        start..end.max(start)
    }

    /// Like [`IdStats::flip_counts`], counting only pairs of frames that are both within
    /// `[t0_ns, t1_ns]`.
    #[must_use]
    pub fn bit_flips_between(&self, stats: &IdStats, t0_ns: i64, t1_ns: i64) -> FlipCounts {
        let mut flips = FlipTally::default();
        flips.grow(stats.bit_flips.len() / 8);
        let mut pairs_by_len = Vec::new();
        let mut last_of_kind = [None; 4];
        for &index in &stats.frames[self.id_frames_between(stats, t0_ns, t1_ns)] {
            let index = index as usize;
            let kind = FrameKind::of(self.flags[index]) as usize;
            if let Some(previous) = last_of_kind[kind] {
                let (before, data) = (self.frame(previous).data, self.frame(index).data);
                count_pair(&mut pairs_by_len, before.len().min(data.len()));
                flips.add_pair(before, data);
            }
            last_of_kind[kind] = Some(index);
        }
        FlipCounts::new(flips.into_counts(), &pairs_by_len)
    }

    /// Payload bits that changed from the previous frame of the same ID and kind, summed per
    /// bucket for the frames of `stats` within `[t0_ns, t1_ns]`. The previous frame may be
    /// before `t0_ns`.
    #[must_use]
    pub fn change_activity(
        &self,
        stats: &IdStats,
        t0_ns: i64,
        t1_ns: i64,
        buckets: usize,
    ) -> Vec<u32> {
        let mut out = vec![0; buckets];
        if buckets == 0 || t1_ns <= t0_ns {
            return out;
        }
        let mut last_of_kind = [None; 4];
        for pos in self.id_frames_between(stats, t0_ns, t1_ns) {
            let index = stats.frames[pos] as usize;
            let kind = FrameKind::of(self.flags[index]) as usize;
            let previous = last_of_kind[kind].or_else(|| self.previous_of_same_kind_at(stats, pos));
            last_of_kind[kind] = Some(index);
            let Some(previous) = previous else {
                continue;
            };
            let frame = self.frame(index);
            let before = self.frame(previous);
            let changed: u32 = frame
                .data
                .iter()
                .zip(before.data)
                .map(|(a, b)| (a ^ b).count_ones())
                .sum();
            out[bucket_of(frame.ts_ns, t0_ns, t1_ns, buckets)] += changed;
        }
        out
    }

    /// Estimated load of one channel at `bitrate` bit/s in `buckets` equal buckets over
    /// `[t0_ns, t1_ns]`: the [`frame_bits`] of the frames timestamped in each bucket divided by
    /// the bits the bus can carry in that time, capped at 1.
    ///
    /// Each frame counts entirely towards the bucket of its timestamp, so short buckets can
    /// briefly read high; hence the cap. Error frames are skipped: SocketCAN reports controller
    /// events (state changes, lost arbitration, ...) as error frames, and many of those never
    /// put an error frame on the wire. Reassembled frames are skipped too, since their packets
    /// are already counted.
    #[must_use]
    pub fn bus_load(
        &self,
        channel: u8,
        t0_ns: i64,
        t1_ns: i64,
        buckets: usize,
        bitrate: f64,
    ) -> Vec<f64> {
        if buckets == 0 || t1_ns <= t0_ns || bitrate <= 0.0 {
            return vec![0.0; buckets];
        }
        let mut bits = vec![0u64; buckets];
        let start = self.first_at_or_after(t0_ns);
        let end = self.ts_ns.partition_point(|t| t <= t1_ns).max(start);
        for i in start..end {
            let ts = self.ts_ns[i];
            if self.channel[i] != channel
                || self.flags[i] & (flags::ERROR | flags::REASSEMBLED) != 0
                || !(t0_ns..=t1_ns).contains(&ts)
            {
                continue;
            }
            let len = self.payload(i).len();
            bits[bucket_of(ts, t0_ns, t1_ns, buckets)] +=
                u64::from(frame_bits(self.id[i], self.flags[i], len));
        }
        let capacity = bitrate * (t1_ns - t0_ns) as f64 / 1e9 / buckets as f64;
        bits.iter()
            .map(|&b| (b as f64 / capacity).min(1.0))
            .collect()
    }

    /// Bytes currently allocated for frame data and indexes.
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        use std::mem::size_of;
        self.ts_ns.heap_bytes()
            + self.id.heap_bytes()
            + self.channel.heap_bytes()
            + self.flags.heap_bytes()
            + self.data_start.heap_bytes()
            + self.data.heap_bytes()
            + self
                .index
                .ids
                .iter()
                .map(|s| {
                    s.frames.capacity() * size_of::<u32>()
                        + s.bit_flips.heap_bytes()
                        + s.pairs_by_len.capacity() * size_of::<u32>()
                })
                .sum::<usize>()
    }

    /// Drops the frames before the first one timestamped at or after `ts_ns`, in store order
    /// rather than time order, so a frame that came late stays with its neighbours. Returns how
    /// many were dropped. For a rolling live capture: the per-ID statistics are rebuilt from the
    /// frames kept, so this costs time in proportion to them, not to the frames dropped.
    pub fn drop_before(&mut self, ts_ns: i64) -> usize {
        let count = self.ts_ns.iter().take_while(|&t| t < ts_ns).count();
        if count == 0 {
            return 0;
        }
        for f in self.flags.iter().take(count) {
            self.error_frames -= usize::from(f & flags::ERROR != 0);
            self.reassembled_frames -= usize::from(f & flags::REASSEMBLED != 0);
        }
        let first_kept = self.data_start.get(count).unwrap_or(self.data.end());
        let moved = self.data.drop_chunks_before(first_kept);
        self.data_start.drop_front(count);
        if moved > 0 {
            self.data_start.for_each_mut(|start| *start -= moved);
        }
        self.ts_ns.drop_front(count);
        self.id.drop_front(count);
        self.channel.drop_front(count);
        self.flags.drop_front(count);
        self.trimmed = true;
        // Freed first to make room.
        self.index = IdIndex::default();
        let mut index = IdIndex::default();
        for i in 0..self.len() {
            index.observe(i as u32, &self.frame(i));
        }
        self.index = index;
        count
    }

    /// Puts the frames in time order if any came earlier than a frame before them, keeping
    /// the order of frames with the same time, and redoes what was worked out in the order
    /// they came: the per-ID statistics and the J1939 transfers. Call it once the log is read.
    /// A store that dropped its oldest frames keeps the transfers it reassembled instead, sorted
    /// with the frames, since the packets that began some of them may be gone.
    ///
    /// The frames are sorted by time with up to 20 bytes per frame, then the columns are rebuilt in
    /// turn, so beyond the store this needs 4 bytes per frame, the J1939 transfers, and the
    /// data with its offsets or one other column at a time. A store already in order costs
    /// nothing.
    pub fn sort_by_time(&mut self) {
        if !self.out_of_order {
            return;
        }
        // Freed first to make room, and rebuilt whether or not the sort goes ahead: a log too
        // big to sort still loads, in the order it came.
        self.index = IdIndex::default();
        let _ = self.sort_columns_by_time();
        let mut index = IdIndex::default();
        for i in 0..self.len() {
            index.observe(i as u32, &self.frame(i));
        }
        self.index = index;
    }

    /// The largest allocations are tried first and leave the store as it was if they fail;
    /// the columns rebuilt after them need less than the data they free.
    fn sort_columns_by_time(&mut self) -> Result<(), TryReserveError> {
        // Sorted with their times beside them: looking each up in its chunk as the sort
        // compares them took twice as long.
        let mut timed: Vec<(i64, u32)> = Vec::new();
        timed.try_reserve_exact(self.len())?;
        timed.extend(
            self.ts_ns
                .iter()
                .zip(self.flags.iter())
                .zip(0..)
                .filter(|&((_, f), _)| self.trimmed || f & flags::REASSEMBLED == 0)
                .map(|((ts, _), i)| (ts, i)),
        );
        timed.sort_unstable();
        let mut order: Vec<u32> = Vec::new();
        order.try_reserve_exact(timed.len())?;
        order.extend(timed.iter().map(|&(_, i)| i));
        drop(timed);

        let mut reassembler = tp::Reassembler::default();
        let mut transfers = Vec::new();
        if !self.trimmed {
            for (position, &i) in order.iter().enumerate() {
                if let Some(transfer) = reassembler.push(&self.frame(i as usize)) {
                    transfers.push((position, transfer));
                }
            }
        }
        let rows = order.len() + transfers.len();

        let mut data_len = 0;
        for_each_row(&order, &transfers, |row| {
            data_len += match row {
                Row::Logged(i) => self.payload(i).len(),
                Row::Reassembled(_, transfer) => transfer.data.len(),
            }
        });
        let mut data = Payloads::default();
        data.try_reserve(data_len)?;
        let mut data_start = Column::default();
        data_start.try_reserve(rows)?;
        self.out_of_order = false;
        self.reassembler = reassembler;
        if !self.trimmed {
            self.reassembled_frames = transfers.len();
        }
        for_each_row(&order, &transfers, |row| {
            data_start.push(data.push(match row {
                Row::Logged(i) => self.payload(i),
                Row::Reassembled(_, transfer) => &transfer.data,
            }));
        });
        data.release_spare();
        self.data = data;
        self.data_start = data_start;

        self.ts_ns = reorder(&self.ts_ns, &order, &transfers, |_, transfer| {
            transfer.ts_ns
        });
        self.id = reorder(&self.id, &order, &transfers, |_, transfer| transfer.id);
        self.channel = reorder(&self.channel, &order, &transfers, |channel, _| channel);
        self.flags = reorder(&self.flags, &order, &transfers, |_, _| flags::REASSEMBLED);
        Ok(())
    }
}

impl FrameSink for FrameStore {
    fn channel_index(&mut self, name: &[u8]) -> u8 {
        if let Some(i) = self.channels.iter().position(|c| c.as_bytes() == name) {
            return i as u8;
        }
        let name = String::from_utf8_lossy(name);
        // A name that isn't UTF-8 is kept lossily, so its bytes never match it above.
        if let Cow::Owned(lossy) = &name {
            if let Some(i) = self.channels.iter().position(|c| c == lossy) {
                return i as u8;
            }
        }
        if self.channels.len() > usize::from(u8::MAX) {
            return u8::MAX;
        }
        self.channels.push(name.into_owned());
        (self.channels.len() - 1) as u8
    }

    fn push(&mut self, frame: FrameRef<'_>) {
        self.store(&frame, None);
    }

    fn push_remote(&mut self, frame: FrameRef<'_>, dlc: u8) {
        self.store(&frame, Some(dlc));
    }
}

impl FrameStore {
    /// Feeds a frame to the J1939 reassembler as [`FrameStore::frame`] reads it back, so that
    /// a frame pushed, appended from a segment or sorted is fed the same, and stores the
    /// transfer it completes, with its statistics if `observe`. Returns whether it completed one.
    fn reassemble(&mut self, frame: &FrameRef<'_>, observe: bool) -> bool {
        if self.segment {
            return false;
        }
        let Some(transfer) = self.reassembler.push(frame) else {
            return false;
        };
        self.reassembled_frames += 1;
        let reassembled = FrameRef {
            ts_ns: transfer.ts_ns,
            channel: frame.channel,
            id: transfer.id,
            flags: flags::REASSEMBLED,
            data: &transfer.data,
        };
        if observe {
            self.index.observe(self.len() as u32, &reassembled);
        }
        self.append_row(&reassembled, &transfer.data);
        true
    }

    /// A remote frame keeps no payload; its data column holds the DLC it asked for, if known,
    /// as one byte, which [`FrameStore::frame`] leaves out.
    fn store(&mut self, frame: &FrameRef<'_>, remote_dlc: Option<u8>) {
        let remote = frame.flags & flags::RTR != 0;
        let frame = FrameRef {
            data: if remote { &[][..] } else { frame.data },
            ..*frame
        };
        self.index.observe(self.len() as u32, &frame);
        let stored = match remote_dlc.filter(|_| remote) {
            Some(dlc) => &[dlc][..],
            None => frame.data,
        };
        self.append_row(&frame, stored);
        self.reassemble(&frame, true);
    }

    /// Adds a frame to the columns, with `stored` as its bytes, without the per-ID statistics.
    fn append_row(&mut self, frame: &FrameRef<'_>, stored: &[u8]) {
        if self.ts_ns.last().is_some_and(|last| frame.ts_ns < last) {
            self.out_of_order = true;
        }
        if frame.flags & flags::ERROR != 0 {
            self.error_frames += 1;
        }
        self.ts_ns.push(frame.ts_ns);
        self.id.push(frame.id);
        self.channel.push(frame.channel);
        self.flags.push(frame.flags);
        self.data_start.push(self.data.push(stored));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ERR_FLAG;

    fn push(store: &mut FrameStore, ts_ns: i64, id: u32, data: &[u8]) {
        push_on(store, ts_ns, 0, id, 0, data);
    }

    fn push_on(store: &mut FrameStore, ts_ns: i64, channel: u8, id: u32, flags: u8, data: &[u8]) {
        store.push(FrameRef {
            ts_ns,
            channel,
            id,
            flags,
            data,
        });
    }

    #[test]
    fn a_reservation_too_big_fails_and_keeps_the_frames() {
        let mut s = FrameStore::new();
        push(&mut s, 10, 0x100, &[1]);
        assert!(s.try_reserve(usize::MAX, 0).is_err());
        assert!(s.try_reserve(16, 128).is_ok());
        assert_eq!(s.len(), 1);
        assert_eq!(s.frame(0).data, &[1]);
    }

    #[test]
    fn stores_and_reads_back_frames() {
        let mut s = FrameStore::new();
        push(&mut s, 10, 0x100, &[1, 2, 3]);
        push(&mut s, 20, 0x200, &[]);
        assert_eq!(s.len(), 2);
        assert_eq!(s.frame(0).data, &[1, 2, 3]);
        assert_eq!(s.frame(1).id, 0x200);
        assert!(s.frame(1).data.is_empty());
    }

    #[test]
    fn counts_bit_flips_between_frames_of_the_same_id() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[0b0000_0001, 0x00]);
        push(&mut s, 1, 0x200, &[0xFF, 0xFF]); // other IDs don't count
        push(&mut s, 2, 0x100, &[0b0000_0011, 0x80]);
        push(&mut s, 3, 0x100, &[0b0000_0001, 0x80]);
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        assert_eq!(stats.frames, vec![0, 2, 3]);
        assert_eq!(stats.bit_flips()[0], 0);
        assert_eq!(stats.bit_flips()[1], 2);
        assert_eq!(stats.bit_flips()[15], 1);
        assert_eq!(stats.bit_flips().iter().sum::<u32>(), 3);
        assert_eq!(stats.flip_counts().pairs, [2, 2]);
        assert_eq!(stats.mean_period_ns(), Some(1.5));
    }

    #[test]
    fn keeps_each_id_apart_when_more_ids_take_turns_than_lookups_remember() {
        let mut s = FrameStore::new();
        let keys = 3 * RECENT_SLOTS;
        for round in 0..4u8 {
            for k in 0..keys {
                let (channel, id) = ((k % 3) as u8, (k / 3) as u32);
                push_on(&mut s, i64::from(round), channel, id, 0, &[round; 2]);
            }
        }
        assert_eq!(s.ids().len(), keys);
        for (k, stats) in s.ids().iter().enumerate() {
            assert_eq!(stats.key(), id_key((k % 3) as u8, (k / 3) as u32));
            let at = |round: usize| (round * keys + k) as u32;
            assert_eq!(stats.frames, [at(0), at(1), at(2), at(3)]);
            // Rounds 1, 2 and 3 change bit 0, bits 0 and 1, then bit 0.
            assert_eq!(stats.bit_flips()[..2], [3, 1]);
        }
    }

    #[test]
    fn finds_previous_frame_of_same_id() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[0]);
        push(&mut s, 1, 0x200, &[0]);
        push(&mut s, 2, 0x100, &[1]);
        assert_eq!(s.previous_of_same_kind(0), None);
        assert_eq!(s.previous_of_same_kind(1), None);
        assert_eq!(s.previous_of_same_kind(2), Some(0));
    }

    #[test]
    fn compares_a_frame_with_the_previous_one_of_its_kind() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[1]);
        s.push(FrameRef {
            ts_ns: 1,
            channel: 0,
            id: 0x100,
            flags: flags::RTR,
            data: &[],
        });
        push(&mut s, 2, 0x100, &[2]);
        s.push(FrameRef {
            ts_ns: 3,
            channel: 0,
            id: 0x100,
            flags: flags::RTR,
            data: &[],
        });
        assert_eq!(s.previous_of_same_kind(1), None);
        assert_eq!(s.previous_of_same_kind(2), Some(0));
        assert_eq!(s.previous_of_same_kind(3), Some(1));
    }

    #[test]
    fn interns_channels() {
        let mut s = FrameStore::new();
        assert_eq!(s.channel_index(b"can0"), 0);
        assert_eq!(s.channel_index(b"can1"), 1);
        assert_eq!(s.channel_index(b"can0"), 0);
        assert_eq!(s.channels(), ["can0", "can1"]);
    }

    #[test]
    fn interns_a_channel_name_that_is_not_utf8_once() {
        let mut s = FrameStore::new();
        assert_eq!(s.channel_index(b"c\xff0"), 0);
        assert_eq!(s.channel_index(b"can1"), 1);
        assert_eq!(s.channel_index(b"c\xff0"), 0);
        assert_eq!(s.channels(), ["c\u{fffd}0", "can1"]);
    }

    #[test]
    fn jitter_is_the_standard_deviation_of_the_gaps() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[]);
        push(&mut s, 10, 0x100, &[]);
        assert_eq!(s.id_stats(id_key(0, 0x100)).unwrap().jitter_ns(), None);
        push(&mut s, 30, 0x100, &[]);
        push(&mut s, 40, 0x100, &[]);
        // Gaps 10, 20, 10: mean 40/3, variance 200/9.
        let jitter = s.id_stats(id_key(0, 0x100)).unwrap().jitter_ns().unwrap();
        assert!((jitter - (200.0f64 / 9.0).sqrt()).abs() < 1e-9, "{jitter}");

        push(&mut s, 0, 0x200, &[]);
        push(&mut s, 5, 0x200, &[]);
        push(&mut s, 10, 0x200, &[]);
        assert_eq!(s.id_stats(id_key(0, 0x200)).unwrap().jitter_ns(), Some(0.0));
    }

    #[test]
    fn counts_error_frames_apart_from_standard_ids() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x080, &[0]);
        push_on(&mut s, 1, 0, 0x80 | ERR_FLAG, flags::ERROR, &[0; 8]);
        push_on(
            &mut s,
            2,
            1,
            0x04 | ERR_FLAG,
            flags::ERROR | flags::TX,
            &[0; 8],
        );
        assert_eq!(s.error_frames(), 2);
        assert_eq!(s.id_stats(id_key(0, 0x080)).unwrap().frames, [0]);
        assert_eq!(s.id_stats(id_key(0, 0x80 | ERR_FLAG)).unwrap().frames, [1]);
    }

    #[test]
    fn finds_frames_by_time() {
        let mut s = FrameStore::new();
        push(&mut s, 10, 0x100, &[]);
        push(&mut s, 20, 0x200, &[]);
        push(&mut s, 30, 0x100, &[]);
        assert_eq!(s.first_at_or_after(i64::MIN), 0);
        assert_eq!(s.first_at_or_after(20), 1);
        assert_eq!(s.first_at_or_after(21), 2);
        assert_eq!(s.first_at_or_after(31), 3);

        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        assert_eq!(s.first_of_id_at_or_after(stats, 0), 0);
        assert_eq!(s.first_of_id_at_or_after(stats, 11), 1);
        assert_eq!(s.first_of_id_at_or_after(stats, 30), 1);
        assert_eq!(s.first_of_id_at_or_after(stats, 31), 2);
        assert_eq!(s.id_frames_between(stats, 10, 30), 0..2);
        assert_eq!(s.id_frames_between(stats, 11, 29), 1..1);
        assert_eq!(s.id_frames_between(stats, 30, 10), 1..1);
    }

    #[test]
    fn frame_bits_follow_the_frame_format() {
        assert_eq!(frame_bits(0x123, 0, 8), 111);
        assert_eq!(frame_bits(0x123 | EXT_FLAG, 0, 8), 131);
        assert_eq!(frame_bits(0x123, flags::RTR, 0), 47);
        assert_eq!(frame_bits(0x123, flags::FD | flags::BRS, 16), 56 + 128);
        assert_eq!(frame_bits(0x123, flags::FD, 64), 60 + 512);
        assert_eq!(frame_bits(0x123 | EXT_FLAG, flags::FD, 8), 75 + 64);
    }

    #[test]
    fn bus_load_sums_frame_bits_per_bucket() {
        const MS: i64 = 1_000_000;
        let mut s = FrameStore::new();
        push_on(&mut s, 100 * MS, 0, 0x123, 0, &[0; 8]); // 111 bits
        push_on(&mut s, 200 * MS, 0, 0x123, flags::RTR, &[]); // 47
        push_on(&mut s, 300 * MS, 0, 0x80 | ERR_FLAG, flags::ERROR, &[0; 8]); // skipped
        push_on(&mut s, 400 * MS, 1, 0x123, 0, &[0; 8]); // other channel
        push_on(&mut s, 600 * MS, 0, 0x1 | EXT_FLAG, 0, &[0; 2]); // 83
        push_on(&mut s, 900 * MS, 0, 0x321, flags::FD, &[0; 32]); // 316
        push_on(&mut s, 1000 * MS, 0, 0x123, 0, &[]); // 47, end of range: last bucket
        push_on(&mut s, 1500 * MS, 0, 0x123, 0, &[0; 8]); // after the range

        // 1000 bit/s over two half-second buckets: 500 bits each.
        let load = s.bus_load(0, 0, 1000 * MS, 2, 1000.0);
        assert_eq!(load, vec![158.0 / 500.0, 446.0 / 500.0]);
        assert_eq!(s.bus_load(0, 0, 1000 * MS, 2, 100.0), vec![1.0, 1.0]);
        assert_eq!(s.bus_load(1, 0, 1000 * MS, 1, 1000.0), vec![111.0 / 1000.0]);
        assert_eq!(s.bus_load(0, 1000 * MS, 0, 2, 1000.0), vec![0.0, 0.0]);
        assert!(s.bus_load(0, 0, 1000 * MS, 0, 1000.0).is_empty());
    }

    #[test]
    fn counts_bit_flips_inside_a_time_window() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[0x00, 0x00]);
        push(&mut s, 10, 0x100, &[0x01, 0x00]);
        push(&mut s, 20, 0x100, &[0x03, 0x80]);
        push(&mut s, 30, 0x100, &[0x00, 0x80]);
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        let between = s.bit_flips_between(stats, 10, 20);
        assert_eq!(between.flips.len(), 16);
        assert_eq!(between.flips[1], 1);
        assert_eq!(between.flips[15], 1);
        assert_eq!(between.flips.iter().sum::<u32>(), 2);
        assert_eq!(between.pairs, [1, 1]);
        assert_eq!(
            s.bit_flips_between(stats, i64::MIN, i64::MAX),
            stats.flip_counts()
        );
        assert_eq!(stats.flip_counts().pairs, [3, 3]);
        let empty = FlipCounts {
            flips: vec![0; 16],
            pairs: vec![0; 2],
        };
        assert_eq!(s.bit_flips_between(stats, 11, 19), empty);
        assert_eq!(s.bit_flips_between(stats, 10, 10), empty);
    }

    #[test]
    fn each_byte_counts_the_pairs_that_have_it() {
        let mut s = FrameStore::new();
        for (t, len) in [8, 8, 2, 8, 64, 64].into_iter().enumerate() {
            let flags = if len > 8 { flags::FD } else { 0 };
            push_on(&mut s, t as i64, 0, 0x100, flags, &vec![t as u8; len]);
        }
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        // Pairs over 8, 2, 2, 8 and 64 bytes.
        let mut pairs = vec![1; 64];
        pairs[..8].fill(3);
        pairs[..2].fill(5);
        let counts = stats.flip_counts();
        assert_eq!(counts.pairs, pairs);
        assert_eq!(counts.flips.len(), 64 * 8);
        // Bit 0 changes from 4 to 5 alone past byte 7, so it changed in each pair with byte 8.
        assert_eq!(counts.flips[8 * 8], 1);
        assert_eq!(s.bit_flips_between(stats, 0, 5), counts);
        let mut window = vec![0; 64];
        window[..2].fill(1);
        assert_eq!(s.bit_flips_between(stats, 1, 2).pairs, window);
    }

    #[test]
    fn single_frames_and_transfers_of_one_id_pair_byte_by_byte() {
        let mut s = FrameStore::new();
        let dm1 = 0x18FE_CA00 | EXT_FLAG;
        let transfer = |n: u8| -> Vec<u8> { (0..14).map(|i| i ^ n).collect() };
        for t in 0..4 {
            push_on(&mut s, t * 100, 0, dm1, 0, &[t as u8; 8]);
            push_bam(&mut s, 0, t * 100 + 10, 0x00, &transfer(t as u8));
        }
        let counts = s.id_stats(id_key(0, dm1)).unwrap().flip_counts();
        // Single frames make three pairs over 8 bytes, the transfers three over 14.
        let mut pairs = vec![3; 14];
        pairs[..8].fill(6);
        assert_eq!(counts.pairs, pairs);
        // Bit 0 of byte 9 changes from each transfer to the next: in every pair that has it.
        assert_eq!(counts.flips[9 * 8], 3);
    }

    /// A BAM from `source` announcing `data` as PGN 0xFECA (DM1), then its packets, all at
    /// priority 6 on channel `channel`, one frame per `ts_ns` tick from `ts_ns`.
    fn push_bam(store: &mut FrameStore, channel: u8, ts_ns: i64, source: u8, data: &[u8]) {
        let size = data.len() as u16;
        let [lo, hi] = size.to_le_bytes();
        let packets = size.div_ceil(7) as u8;
        push_on(
            store,
            ts_ns,
            channel,
            0x18EC_FF00 | u32::from(source) | EXT_FLAG,
            0,
            &[0x20, lo, hi, packets, 0xFF, 0xCA, 0xFE, 0x00],
        );
        for (i, chunk) in data.chunks(7).enumerate() {
            let mut packet = [0xFF; 8];
            packet[0] = i as u8 + 1;
            packet[1..1 + chunk.len()].copy_from_slice(chunk);
            push_on(
                store,
                ts_ns + 1 + i as i64,
                channel,
                0x18EB_FF00 | u32::from(source) | EXT_FLAG,
                0,
                &packet,
            );
        }
    }

    #[test]
    fn reassembles_transport_protocol_transfers_into_frames() {
        let mut s = FrameStore::new();
        let payload: Vec<u8> = (0..100).collect();
        push_bam(&mut s, 0, 10, 0x00, &payload);
        // 1 + 15 packets from the log, plus the reassembled frame.
        assert_eq!(s.len(), 17);
        assert_eq!(s.reassembled_frames(), 1);
        let frame = s.frame(16);
        assert_eq!(frame.id, 0x18FE_CA00 | EXT_FLAG);
        assert_eq!(frame.flags, flags::REASSEMBLED);
        assert_eq!(frame.ts_ns, 25, "the last packet's time");
        assert_eq!(frame.data, &payload[..]);
        assert_eq!(s.frame(15).data.len(), 8, "the packets stay as they were");

        let stats = s.id_stats(id_key(0, 0x18FE_CA00 | EXT_FLAG)).unwrap();
        assert_eq!(stats.frames, [16]);
        assert_eq!((stats.min_len, stats.max_len), (100, 100));
        assert_eq!(stats.flags, flags::REASSEMBLED);
        assert_eq!(stats.bit_flips().len(), 800);

        // A second transfer of the same group counts its bit flips against the first: byte 99
        // goes from 0x63 to 0xFF, four bits.
        let mut changed = payload.clone();
        changed[99] = 0xFF;
        push_bam(&mut s, 0, 100, 0x00, &changed);
        let stats = s.id_stats(id_key(0, 0x18FE_CA00 | EXT_FLAG)).unwrap();
        assert_eq!(stats.frames, [16, 33]);
        assert_eq!(stats.bit_flips().iter().sum::<u32>(), 4);
        assert_eq!(stats.bit_flips()[99 * 8 + 7], 1);
    }

    #[test]
    fn abandoned_transfers_leave_no_frame_and_senders_do_not_mix() {
        let mut s = FrameStore::new();
        let bam = |s: &mut FrameStore, ts, source: u8, size: u8| {
            push_on(
                s,
                ts,
                0,
                0x18EC_FF00 | u32::from(source) | EXT_FLAG,
                0,
                &[0x20, size, 0, size.div_ceil(7), 0xFF, 0xCA, 0xFE, 0x00],
            );
        };
        let dt = |s: &mut FrameStore, ts, source: u8, packet: &[u8; 8]| {
            push_on(
                s,
                ts,
                0,
                0x18EB_FF00 | u32::from(source) | EXT_FLAG,
                0,
                packet,
            );
        };
        // Source 0 announces 14 bytes but sends one packet; source 1 completes in between.
        bam(&mut s, 0, 0x00, 14);
        bam(&mut s, 1, 0x01, 14);
        dt(&mut s, 2, 0x00, &[1; 8]);
        dt(&mut s, 3, 0x01, &[1, 9, 9, 9, 9, 9, 9, 9]);
        dt(&mut s, 4, 0x01, &[2, 8, 8, 8, 8, 8, 8, 8]);
        // Source 0 starts over before its second packet, then finishes the new transfer.
        bam(&mut s, 5, 0x00, 7);
        dt(&mut s, 6, 0x00, &[1, 5, 5, 5, 5, 5, 5, 5]);
        assert_eq!(s.reassembled_frames(), 2);
        let reassembled: Vec<(u32, i64, Vec<u8>)> = (0..s.len())
            .map(|i| s.frame(i))
            .filter(|f| f.flags & flags::REASSEMBLED != 0)
            .map(|f| (f.id & !EXT_FLAG, f.ts_ns, f.data.to_vec()))
            .collect();
        assert_eq!(
            reassembled,
            [
                (
                    0x18FE_CA01,
                    4,
                    vec![9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8]
                ),
                (0x18FE_CA00, 6, vec![5; 7]),
            ]
        );
    }

    #[test]
    fn bus_load_skips_reassembled_frames() {
        const MS: i64 = 1_000_000;
        let mut s = FrameStore::new();
        push_bam(&mut s, 0, 0, 0x00, &[0; 14]);
        assert_eq!(s.reassembled_frames(), 1);
        // Three extended frames of 8 bytes: 131 bits each.
        assert_eq!(
            s.bus_load(0, 0, 10 * MS, 1, 1_000_000.0),
            vec![393.0 / 10_000.0]
        );
    }

    fn frames_of(s: &FrameStore) -> Vec<(i64, u32, Vec<u8>)> {
        (0..s.len())
            .map(|i| s.frame(i))
            .map(|f| (f.ts_ns, f.id, f.data.to_vec()))
            .collect()
    }

    #[test]
    fn keeps_a_remote_frames_dlc_apart_from_its_payload() {
        let mut s = FrameStore::new();
        let remote = |ts_ns| FrameRef {
            ts_ns,
            channel: 0,
            id: 0x123,
            flags: flags::RTR,
            data: &[],
        };
        s.push_remote(remote(30), 8);
        s.push(remote(10));
        push(&mut s, 20, 0x123, &[1, 2]);
        s.push_remote(remote(40), 0);
        assert_eq!(s.frame(0).data, &[] as &[u8]);
        assert_eq!(s.frame(2).data, &[1, 2]);
        assert_eq!(
            (0..4).map(|i| s.remote_dlc(i)).collect::<Vec<_>>(),
            [Some(8), None, None, Some(0)]
        );
        let stats = s.id_stats(id_key(0, 0x123)).unwrap();
        assert_eq!((stats.min_len, stats.max_len), (0, 2));

        s.sort_by_time();
        assert_eq!(
            (0..4).map(|i| s.remote_dlc(i)).collect::<Vec<_>>(),
            [None, None, Some(8), Some(0)]
        );
        assert_eq!(s.frame(1).data, &[1, 2]);
        s.drop_before(35);
        assert_eq!(s.remote_dlc(0), Some(0));
        assert_eq!(s.frame(0).data, &[] as &[u8]);
    }

    #[test]
    fn dropping_old_frames_keeps_the_rest_and_redoes_the_statistics() {
        let mut s = FrameStore::new();
        push(&mut s, 10, 0x100, &[0x00, 1]);
        push_on(&mut s, 20, 0, ERR_FLAG | 4, flags::ERROR, &[0, 0, 8]);
        push(&mut s, 30, 0x100, &[0xff, 2]);
        push(&mut s, 25, 0x200, &[7]);
        push(&mut s, 40, 0x100, &[0x0f, 3]);
        assert_eq!(s.drop_before(5), 0);
        assert_eq!(s.len(), 5);

        // The late frame at 25 goes only with the frames before it in the store.
        assert_eq!(s.drop_before(26), 2);
        assert_eq!(s.len(), 3);
        assert_eq!(s.error_frames(), 0);
        assert_eq!(s.frame(0).ts_ns, 30);
        assert_eq!(s.frame(0).data, &[0xff, 2]);
        assert_eq!(s.frame(1).data, &[7]);
        assert_eq!(s.frame(2).data, &[0x0f, 3]);
        assert_eq!(s.first_ts_ns(), Some(30));
        let ids: Vec<u32> = s.ids().iter().map(|i| i.id).collect();
        assert_eq!(ids, [0x100, 0x200]);
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        assert_eq!(stats.frames, [0, 2]);
        assert_eq!(stats.first_ts_ns, 30);
        // Only the change from [0xff, 2] to [0x0f, 3] is left: four bits, then one.
        assert_eq!(stats.bit_flips().iter().sum::<u32>(), 4 + 1);
        assert!(s.id_stats(id_key(0, ERR_FLAG | 4)).is_none());

        assert_eq!(s.drop_before(i64::MAX), 3);
        assert!(s.is_empty());
        assert!(s.ids().is_empty());
        push(&mut s, 50, 0x300, &[1]);
        assert_eq!(s.frame(0).data, &[1]);
    }

    #[test]
    fn dropping_old_frames_keeps_the_count_of_reassembled_transfers() {
        let mut s = FrameStore::new();
        // A BAM announcing 9 bytes of PGN 0xFECA from 0x00, then its two packets.
        let bam = [0x20, 9, 0, 2, 0xff, 0xca, 0xfe, 0];
        push(&mut s, 0, EXT_FLAG | 0x1CEC_FF00, &bam);
        push(
            &mut s,
            10,
            EXT_FLAG | 0x1CEB_FF00,
            &[1, 1, 2, 3, 4, 5, 6, 7],
        );
        push(
            &mut s,
            20,
            EXT_FLAG | 0x1CEB_FF00,
            &[2, 8, 9, 0xff, 0xff, 0xff, 0xff, 0xff],
        );
        assert_eq!(s.reassembled_frames(), 1);
        s.drop_before(15);
        assert_eq!(s.reassembled_frames(), 1);
        s.drop_before(21);
        assert_eq!(s.reassembled_frames(), 0);
        assert!(s.is_empty());
    }

    #[test]
    fn sorting_after_a_drop_keeps_transfers_whose_first_packets_are_gone() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[0]);
        push_bam(&mut s, 0, 10, 0x00, &[7; 9]);
        assert_eq!(s.reassembled_frames(), 1);
        // The announcement at 10 goes; the packets at 11 and 12 and the transfer stay.
        s.drop_before(11);
        push(&mut s, 5, 0x100, &[1]);
        s.sort_by_time();
        assert_eq!(s.reassembled_frames(), 1);
        let kinds: Vec<(i64, u8)> = (0..s.len())
            .map(|i| (s.frame(i).ts_ns, s.frame(i).flags))
            .collect();
        assert_eq!(kinds, [(5, 0), (11, 0), (12, 0), (12, flags::REASSEMBLED)]);
        assert_eq!(s.frame(3).data, &[7; 9]);
    }

    #[test]
    fn sorting_by_time_keeps_ties_in_order_and_redoes_the_statistics() {
        let mut s = FrameStore::new();
        push(&mut s, 30, 0x100, &[0x03]);
        push(&mut s, 10, 0x200, &[0xAA, 0xBB]);
        push(&mut s, 20, 0x100, &[0x01]);
        push_on(&mut s, 10, 1, 0x80 | ERR_FLAG, flags::ERROR, &[]);
        push(&mut s, 0, 0x100, &[0x00]);
        s.sort_by_time();
        assert_eq!(
            frames_of(&s),
            [
                (0, 0x100, vec![0x00]),
                (10, 0x200, vec![0xAA, 0xBB]),
                (10, 0x80 | ERR_FLAG, vec![]),
                (20, 0x100, vec![0x01]),
                (30, 0x100, vec![0x03]),
            ]
        );
        assert_eq!(s.frame(2).channel, 1);
        assert_eq!(s.frame(2).flags, flags::ERROR);
        assert_eq!((s.first_ts_ns(), s.last_ts_ns()), (Some(0), Some(30)));
        assert_eq!(s.error_frames(), 1);
        assert_eq!(s.first_at_or_after(15), 3);

        let keys: Vec<IdKey> = s.ids().iter().map(IdStats::key).collect();
        assert_eq!(
            keys,
            [
                id_key(0, 0x100),
                id_key(0, 0x200),
                id_key(1, 0x80 | ERR_FLAG)
            ]
        );
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        assert_eq!(stats.frames, [0, 3, 4]);
        assert_eq!((stats.first_ts_ns, stats.last_ts_ns), (0, 30));
        assert_eq!(stats.mean_period_ns(), Some(15.0));
        assert_eq!(stats.jitter_ns(), Some(5.0));
        // 0x00 to 0x01 to 0x03: one flip each of bits 0 and 1.
        assert_eq!(stats.bit_flips()[..2], [1, 1]);
        assert_eq!(stats.bit_flips().iter().sum::<u32>(), 2);
        assert_eq!(s.previous_of_same_kind(3), Some(0));
    }

    #[test]
    fn a_store_spanning_chunks_sorts_and_drops_its_oldest_frames() {
        let frame = |t: i64| (t, 0x100 + (t % 3) as u32, vec![t as u8; (t % 17) as usize]);
        let expected: Vec<(i64, u32, Vec<u8>)> = (0..600_000).map(frame).collect();
        let mut s = FrameStore::new();
        // Each pair of frames comes swapped, so the store needs sorting.
        for pair in expected.chunks(2) {
            for (ts_ns, id, data) in pair.iter().rev() {
                push(&mut s, *ts_ns, *id, data);
            }
        }
        s.sort_by_time();
        assert!(frames_of(&s) == expected);
        assert_eq!(s.id_stats(id_key(0, 0x101)).unwrap().frames.len(), 200_000);

        assert_eq!(s.drop_before(550_000), 550_000);
        assert!(frames_of(&s) == expected[550_000..]);
        let (ts_ns, id, data) = frame(600_000);
        push(&mut s, ts_ns, id, &data);
        assert_eq!(s.frame(50_000).data, &data[..]);
        assert_eq!(s.id_stats(id_key(0, 0x100)).unwrap().frames[0], 2);
    }

    #[test]
    fn a_store_in_time_order_is_left_as_it_is() {
        let mut s = FrameStore::new();
        s.reserve(100, 800);
        push(&mut s, 10, 0x100, &[1]);
        push(&mut s, 10, 0x200, &[2]);
        push(&mut s, 20, 0x100, &[3]);
        let (frames, heap) = (frames_of(&s), s.heap_bytes());
        s.sort_by_time();
        assert_eq!(frames_of(&s), frames);
        assert_eq!(s.heap_bytes(), heap, "no column was rebuilt");
    }

    #[test]
    fn sorting_by_time_reassembles_transfers_in_time_order() {
        let mut logged = FrameStore::new();
        let payload: Vec<u8> = (0..20).collect();
        push_bam(&mut logged, 0, 10, 0x00, &payload);
        let packets: Vec<(i64, u32, Vec<u8>)> = frames_of(&logged)
            .into_iter()
            .filter(|(_, id, _)| id & 0x00FF_0000 != 0x00FE_0000)
            .collect();
        assert_eq!(packets.len(), 4);

        // Backwards, the packets come before their announcement and are ignored.
        let mut s = FrameStore::new();
        push(&mut s, 50, 0x100, &[]);
        for (ts_ns, id, data) in packets.iter().rev() {
            push_on(&mut s, *ts_ns, 0, *id, 0, data);
        }
        push(&mut s, 0, 0x100, &[]);
        assert_eq!(s.reassembled_frames(), 0);
        s.sort_by_time();
        assert_eq!(s.reassembled_frames(), 1);
        assert_eq!(s.len(), 7);
        let frame = s.frame(5);
        assert_eq!(frame.flags, flags::REASSEMBLED);
        assert_eq!(frame.ts_ns, 13, "right after its last packet");
        assert_eq!(frame.data, &payload[..]);
        assert_eq!(s.frame(6).ts_ns, 50);
        let stats = s.id_stats(id_key(0, 0x18FE_CA00 | EXT_FLAG)).unwrap();
        assert_eq!(stats.frames, [5]);
        assert_eq!(stats.flags, flags::REASSEMBLED);

        // A transfer completed as the frames came is not stored twice.
        let mut s = FrameStore::new();
        push_bam(&mut s, 0, 10, 0x00, &payload);
        push(&mut s, 0, 0x100, &[]);
        assert_eq!(s.reassembled_frames(), 1);
        s.sort_by_time();
        assert_eq!(s.reassembled_frames(), 1);
        assert_eq!(s.len(), 6);
        assert_eq!(s.frame(0).id, 0x100);
        assert_eq!(s.frame(5).flags, flags::REASSEMBLED);
        assert_eq!(s.frame(5).data, &payload[..]);
    }

    #[test]
    fn change_activity_counts_changed_bits_per_bucket() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[0x00]);
        push(&mut s, 10, 0x100, &[0x0F]); // 4 bits, compared with the frame before the window
        push(&mut s, 15, 0x200, &[0xFF]); // other ID
        push(&mut s, 20, 0x100, &[0x0E]); // 1 bit
        push(&mut s, 30, 0x100, &[0xF0]); // 7 bits, at the end of the range
        push(&mut s, 40, 0x100, &[0x00]); // after the range
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        assert_eq!(s.change_activity(stats, 10, 30, 2), vec![4, 8]);
        assert_eq!(s.change_activity(stats, 0, 40, 4), vec![0, 4, 1, 11]);
        assert_eq!(s.change_activity(stats, 30, 10, 2), vec![0, 0]);
    }

    #[test]
    fn bit_activity_skips_the_remote_frames_of_a_polled_id() {
        let mut s = FrameStore::new();
        for (t, data) in [(0, 0x00), (20, 0x0F), (40, 0x0E)] {
            push_on(&mut s, t, 0, 0x100, flags::RTR, &[]);
            push_on(&mut s, t + 10, 0, 0x100, 0, &[data]);
        }
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        assert_eq!(stats.bit_flips().iter().sum::<u32>(), 5);
        assert_eq!(stats.bit_flips()[0], 2);
        assert_eq!(s.bit_flips_between(stats, 0, 50), stats.flip_counts());
        assert_eq!(
            s.bit_flips_between(stats, 20, 50).flips.iter().sum::<u32>(),
            1
        );
        // The data frame at 30 is compared with the one at 10, before the window.
        assert_eq!(s.change_activity(stats, 20, 50, 2), vec![4, 1]);
        // Six frames, but only the data frames make pairs, so a bit changing in each of them
        // shows as changing every time.
        assert_eq!(stats.flip_counts().pairs, [2]);
        assert_eq!(s.bit_flips_between(stats, 20, 50).pairs, [1]);
        assert_eq!(s.bit_flips_between(stats, 15, 35).pairs, [0]);
    }

    #[test]
    fn each_kind_of_frame_pairs_with_its_own() {
        let mut s = FrameStore::new();
        push_on(&mut s, 0, 0, 0x100, 0, &[1]);
        push_on(&mut s, 1, 0, 0x100, flags::RTR, &[]);
        push_on(&mut s, 2, 0, 0x100, flags::RTR, &[]);
        push_on(&mut s, 3, 0, 0x100, flags::FD, &[2]);
        push_on(&mut s, 4, 0, 0x100, 0, &[3]);
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        // Data with data, FD frames among them: 0 with 3, 3 with 4.
        assert_eq!(stats.flip_counts().pairs, [2]);
        assert_eq!(s.bit_flips_between(stats, 0, 4).pairs, [2]);
        assert_eq!(s.bit_flips_between(stats, 1, 3).pairs, [0]);
    }
}
