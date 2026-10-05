use std::collections::TryReserveError;
use std::ops::Range;

use rustc_hash::FxHashMap;

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
    /// How often each payload bit changed between consecutive frames of this ID, indexed by
    /// `byte * 8 + bit` where bit 0 is the least significant bit of the byte.
    pub bit_flips: Vec<u32>,
    last_data: Vec<u8>,
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
            bit_flips: Vec::new(),
            last_data: Vec::new(),
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

    fn observe(&mut self, index: u32, frame: &FrameRef<'_>) {
        let len = frame.data.len();
        if self.bit_flips.len() < len * 8 {
            self.bit_flips.resize(len * 8, 0);
        }
        if !self.frames.is_empty() {
            count_flips(&mut self.bit_flips, &self.last_data, frame.data);
            let gap = (frame.ts_ns - self.last_ts_ns) as f64;
            let delta = gap - self.gap_mean_ns;
            self.gap_mean_ns += delta / self.frames.len() as f64;
            self.gap_m2 += delta * (gap - self.gap_mean_ns);
        }
        self.frames.push(index);
        self.flags |= frame.flags;
        self.last_ts_ns = frame.ts_ns;
        let len16 = len as u16;
        self.min_len = self.min_len.min(len16);
        self.max_len = self.max_len.max(len16);
        self.last_data.clear();
        self.last_data.extend_from_slice(frame.data);
    }
}

/// Adds one to `counts[byte * 8 + bit]` for every bit that differs between `a` and `b`, over
/// the bytes both have.
fn count_flips(counts: &mut [u32], a: &[u8], b: &[u8]) {
    for (byte, (x, y)) in a.iter().zip(b).enumerate() {
        let mut changed = x ^ y;
        while changed != 0 {
            counts[byte * 8 + changed.trailing_zeros() as usize] += 1;
            changed &= changed - 1;
        }
    }
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
/// million frames fit comfortably under the 4 GB wasm32 address space.
#[derive(Debug, Default)]
pub struct FrameStore {
    ts_ns: Vec<i64>,
    id: Vec<u32>,
    channel: Vec<u8>,
    flags: Vec<u8>,
    /// Where each frame's payload starts in `data`; it ends where the next one starts.
    data_start: Vec<usize>,
    data: Vec<u8>,
    channels: Vec<String>,
    index: IdIndex,
    error_frames: usize,
    reassembler: tp::Reassembler,
    reassembled_frames: usize,
    /// A frame came earlier than one before it, so [`FrameStore::sort_by_time`] has work.
    out_of_order: bool,
}

/// The [`IdStats`] of every ID, in order of first appearance.
#[derive(Debug, Default)]
struct IdIndex {
    by_key: FxHashMap<IdKey, usize>,
    ids: Vec<IdStats>,
    last_lookup: Option<(IdKey, usize)>,
}

impl IdIndex {
    fn observe(&mut self, index: u32, frame: &FrameRef<'_>) {
        let stats = self.stats_index(id_key(frame.channel, frame.id), frame);
        self.ids[stats].observe(index, frame);
    }

    fn stats_index(&mut self, key: IdKey, frame: &FrameRef<'_>) -> usize {
        if let Some((last_key, i)) = self.last_lookup {
            if last_key == key {
                return i;
            }
        }
        let next = self.ids.len();
        let i = *self.by_key.entry(key).or_insert(next);
        if i == next {
            self.ids
                .push(IdStats::new(frame.channel, frame.id, frame.ts_ns));
        }
        self.last_lookup = Some((key, i));
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
    column: &[T],
    order: &[u32],
    transfers: &[(usize, tp::Transfer)],
    reassembled: impl Fn(T, &tp::Transfer) -> T,
) -> Vec<T> {
    let mut reordered = Vec::with_capacity(order.len() + transfers.len());
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

    /// Pre-allocate for roughly `frames` frames carrying `payload_bytes` of data in total.
    pub fn reserve(&mut self, frames: usize, payload_bytes: usize) {
        self.ts_ns.reserve(frames);
        self.id.reserve(frames);
        self.channel.reserve(frames);
        self.flags.reserve(frames);
        self.data_start.reserve(frames);
        self.data.reserve(payload_bytes);
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.ts_ns.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ts_ns.is_empty()
    }

    /// # Panics
    /// If `index` is out of bounds.
    #[must_use]
    pub fn frame(&self, index: usize) -> FrameRef<'_> {
        FrameRef {
            ts_ns: self.ts_ns[index],
            channel: self.channel[index],
            id: self.id[index],
            flags: self.flags[index],
            data: &self.data[self.data_range(index)],
        }
    }

    fn data_range(&self, index: usize) -> Range<usize> {
        let start = self.data_start[index];
        let end = self
            .data_start
            .get(index + 1)
            .copied()
            .unwrap_or(self.data.len());
        start..end
    }

    #[must_use]
    pub fn first_ts_ns(&self) -> Option<i64> {
        self.ts_ns.first().copied()
    }

    #[must_use]
    pub fn last_ts_ns(&self) -> Option<i64> {
        self.ts_ns.last().copied()
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
        self.ts_ns.partition_point(|&t| t < ts_ns)
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

    /// Like [`IdStats::bit_flips`], counting only changes between consecutive frames that are
    /// both within `[t0_ns, t1_ns]`.
    #[must_use]
    pub fn bit_flips_between(&self, stats: &IdStats, t0_ns: i64, t1_ns: i64) -> Vec<u32> {
        let mut counts = vec![0; stats.bit_flips.len()];
        let range = self.id_frames_between(stats, t0_ns, t1_ns);
        for pair in stats.frames[range].windows(2) {
            let (a, b) = (self.frame(pair[0] as usize), self.frame(pair[1] as usize));
            count_flips(&mut counts, a.data, b.data);
        }
        counts
    }

    /// Payload bits that changed from the previous frame of the same ID, summed per bucket for
    /// the frames of `stats` within `[t0_ns, t1_ns]`. The previous frame may be before `t0_ns`.
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
        for pos in self.id_frames_between(stats, t0_ns, t1_ns) {
            let Some(prev) = pos.checked_sub(1) else {
                continue;
            };
            let frame = self.frame(stats.frames[pos] as usize);
            let before = self.frame(stats.frames[prev] as usize);
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
        let end = self.ts_ns.partition_point(|&t| t <= t1_ns).max(start);
        for i in start..end {
            let ts = self.ts_ns[i];
            if self.channel[i] != channel
                || self.flags[i] & (flags::ERROR | flags::REASSEMBLED) != 0
                || !(t0_ns..=t1_ns).contains(&ts)
            {
                continue;
            }
            let len = self.data_range(i).len();
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
        self.ts_ns.capacity() * size_of::<i64>()
            + self.id.capacity() * size_of::<u32>()
            + self.channel.capacity()
            + self.flags.capacity()
            + self.data_start.capacity() * size_of::<usize>()
            + self.data.capacity()
            + self
                .index
                .ids
                .iter()
                .map(|s| {
                    s.frames.capacity() * size_of::<u32>()
                        + s.bit_flips.capacity() * size_of::<u32>()
                })
                .sum::<usize>()
    }

    /// Puts the frames in time order if any came earlier than a frame before them, keeping
    /// the order of frames with the same time, and redoes what was worked out in the order
    /// they came: the per-ID statistics and the J1939 transfers. Call it once the log is read.
    ///
    /// The columns are rebuilt in turn, so beyond the store this needs 4 bytes per frame, the
    /// J1939 transfers, and the data with its offsets or one other column at a time. A store
    /// already in order costs nothing.
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
        let mut order: Vec<u32> = Vec::new();
        order.try_reserve_exact(self.len())?;
        order.extend(
            (0..self.len() as u32).filter(|&i| self.flags[i as usize] & flags::REASSEMBLED == 0),
        );
        order.sort_unstable_by_key(|&i| (self.ts_ns[i as usize], i));

        let mut reassembler = tp::Reassembler::default();
        let mut transfers = Vec::new();
        for (position, &i) in order.iter().enumerate() {
            if let Some(transfer) = reassembler.push(&self.frame(i as usize)) {
                transfers.push((position, transfer));
            }
        }
        let rows = order.len() + transfers.len();

        let mut data_len = 0;
        for_each_row(&order, &transfers, |row| {
            data_len += match row {
                Row::Logged(i) => self.data_range(i).len(),
                Row::Reassembled(_, transfer) => transfer.data.len(),
            }
        });
        let mut data = Vec::new();
        data.try_reserve_exact(data_len)?;
        let mut data_start = Vec::new();
        data_start.try_reserve_exact(rows)?;
        self.out_of_order = false;
        self.reassembler = reassembler;
        self.reassembled_frames = transfers.len();
        for_each_row(&order, &transfers, |row| {
            data_start.push(data.len());
            match row {
                Row::Logged(i) => data.extend_from_slice(&self.data[self.data_range(i)]),
                Row::Reassembled(_, transfer) => data.extend_from_slice(&transfer.data),
            }
        });
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
        if self.channels.len() > usize::from(u8::MAX) {
            return u8::MAX;
        }
        self.channels
            .push(String::from_utf8_lossy(name).into_owned());
        (self.channels.len() - 1) as u8
    }

    fn push(&mut self, frame: FrameRef<'_>) {
        self.store(&frame);
        if let Some(transfer) = self.reassembler.push(&frame) {
            self.reassembled_frames += 1;
            self.store(&FrameRef {
                ts_ns: transfer.ts_ns,
                channel: frame.channel,
                id: transfer.id,
                flags: flags::REASSEMBLED,
                data: &transfer.data,
            });
        }
    }
}

impl FrameStore {
    fn store(&mut self, frame: &FrameRef<'_>) {
        if self.ts_ns.last().is_some_and(|&last| frame.ts_ns < last) {
            self.out_of_order = true;
        }
        self.index.observe(self.ts_ns.len() as u32, frame);
        if frame.flags & flags::ERROR != 0 {
            self.error_frames += 1;
        }

        self.ts_ns.push(frame.ts_ns);
        self.id.push(frame.id);
        self.channel.push(frame.channel);
        self.flags.push(frame.flags);
        self.data_start.push(self.data.len());
        self.data.extend_from_slice(frame.data);
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
        assert_eq!(stats.bit_flips[0], 0);
        assert_eq!(stats.bit_flips[1], 2);
        assert_eq!(stats.bit_flips[15], 1);
        assert_eq!(stats.bit_flips.iter().sum::<u32>(), 3);
        assert_eq!(stats.mean_period_ns(), Some(1.5));
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
        assert_eq!(between.len(), 16);
        assert_eq!(between[1], 1);
        assert_eq!(between[15], 1);
        assert_eq!(between.iter().sum::<u32>(), 2);
        assert_eq!(
            s.bit_flips_between(stats, i64::MIN, i64::MAX),
            stats.bit_flips
        );
        assert_eq!(s.bit_flips_between(stats, 11, 19), vec![0; 16]);
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
        assert_eq!(stats.bit_flips.len(), 800);

        // A second transfer of the same group counts its bit flips against the first: byte 99
        // goes from 0x63 to 0xFF, four bits.
        let mut changed = payload.clone();
        changed[99] = 0xFF;
        push_bam(&mut s, 0, 100, 0x00, &changed);
        let stats = s.id_stats(id_key(0, 0x18FE_CA00 | EXT_FLAG)).unwrap();
        assert_eq!(stats.frames, [16, 33]);
        assert_eq!(stats.bit_flips.iter().sum::<u32>(), 4);
        assert_eq!(stats.bit_flips[99 * 8 + 7], 1);
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
        assert_eq!(stats.bit_flips[..2], [1, 1]);
        assert_eq!(stats.bit_flips.iter().sum::<u32>(), 2);
        assert_eq!(s.previous_of_same_kind(3), Some(0));
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
}
