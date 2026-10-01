use std::ops::Range;

use rustc_hash::FxHashMap;

use crate::{flags, FrameRef, FrameSink, EXT_FLAG, MAX_PAYLOAD};

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
    /// Store indices of every frame with this ID, in ingest order.
    pub frames: Vec<u32>,
    pub first_ts_ns: i64,
    pub last_ts_ns: i64,
    pub min_len: u8,
    pub max_len: u8,
    /// How often each payload bit changed between consecutive frames of this ID, indexed by
    /// `byte * 8 + bit` where bit 0 is the least significant bit of the byte.
    pub bit_flips: Vec<u32>,
    last_data: [u8; MAX_PAYLOAD],
    last_len: u8,
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
            min_len: u8::MAX,
            max_len: 0,
            bit_flips: Vec::new(),
            last_data: [0; MAX_PAYLOAD],
            last_len: 0,
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
            count_flips(
                &mut self.bit_flips,
                &self.last_data[..usize::from(self.last_len)],
                frame.data,
            );
            let gap = (frame.ts_ns - self.last_ts_ns) as f64;
            let delta = gap - self.gap_mean_ns;
            self.gap_mean_ns += delta / self.frames.len() as f64;
            self.gap_m2 += delta * (gap - self.gap_mean_ns);
        }
        self.frames.push(index);
        self.flags |= frame.flags;
        self.last_ts_ns = frame.ts_ns;
        let len8 = len as u8;
        self.min_len = self.min_len.min(len8);
        self.max_len = self.max_len.max(len8);
        self.last_data[..len].copy_from_slice(frame.data);
        self.last_len = len8;
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

/// Columnar store of every frame in a log.
///
/// Classic frames cost 27 bytes each on wasm32 (plus 4 in the per-ID index), so ten
/// million frames fit comfortably under the 4 GB wasm32 address space.
#[derive(Debug, Default)]
pub struct FrameStore {
    ts_ns: Vec<i64>,
    id: Vec<u32>,
    channel: Vec<u8>,
    flags: Vec<u8>,
    len: Vec<u8>,
    data_start: Vec<usize>,
    data: Vec<u8>,
    channels: Vec<String>,
    by_key: FxHashMap<IdKey, usize>,
    ids: Vec<IdStats>,
    last_lookup: Option<(IdKey, usize)>,
    error_frames: usize,
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
        self.len.reserve(frames);
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
        let start = self.data_start[index];
        FrameRef {
            ts_ns: self.ts_ns[index],
            channel: self.channel[index],
            id: self.id[index],
            flags: self.flags[index],
            data: &self.data[start..start + usize::from(self.len[index])],
        }
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

    /// Every distinct ID, in order of first appearance.
    #[must_use]
    pub fn ids(&self) -> &[IdStats] {
        &self.ids
    }

    #[must_use]
    pub fn id_stats(&self, key: IdKey) -> Option<&IdStats> {
        self.by_key.get(&key).map(|&i| &self.ids[i])
    }

    /// Index of the previous frame with the same channel and ID as frame `index`.
    #[must_use]
    pub fn previous_of_same_id(&self, index: usize) -> Option<usize> {
        let stats = self.id_stats(id_key(self.channel[index], self.id[index]))?;
        let pos = stats.frames.partition_point(|&f| (f as usize) < index);
        pos.checked_sub(1).map(|p| stats.frames[p] as usize)
    }

    /// Index of the first frame at or after `ts_ns`, or `len()` if there is none.
    ///
    /// Time lookups binary-search on the assumption that frames are in time order, as loggers
    /// write them. Slightly out-of-order timestamps only shift the answer by those frames.
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
    /// put an error frame on the wire.
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
                || self.flags[i] & flags::ERROR != 0
                || !(t0_ns..=t1_ns).contains(&ts)
            {
                continue;
            }
            let len = usize::from(self.len[i]);
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
            + self.len.capacity()
            + self.data_start.capacity() * size_of::<usize>()
            + self.data.capacity()
            + self
                .ids
                .iter()
                .map(|s| {
                    s.frames.capacity() * size_of::<u32>()
                        + s.bit_flips.capacity() * size_of::<u32>()
                })
                .sum::<usize>()
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
        let index = self.ts_ns.len() as u32;
        let stats = self.stats_index(id_key(frame.channel, frame.id), &frame);
        self.ids[stats].observe(index, &frame);
        if frame.flags & flags::ERROR != 0 {
            self.error_frames += 1;
        }

        self.ts_ns.push(frame.ts_ns);
        self.id.push(frame.id);
        self.channel.push(frame.channel);
        self.flags.push(frame.flags);
        self.len.push(frame.data.len() as u8);
        self.data_start.push(self.data.len());
        self.data.extend_from_slice(frame.data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(s.previous_of_same_id(0), None);
        assert_eq!(s.previous_of_same_id(1), None);
        assert_eq!(s.previous_of_same_id(2), Some(0));
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
    fn counts_error_frames() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0x100, &[0]);
        push_on(&mut s, 1, 0, 0x80, flags::ERROR, &[0; 8]);
        push_on(&mut s, 2, 1, 0x04, flags::ERROR | flags::TX, &[0; 8]);
        assert_eq!(s.error_frames(), 2);
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
        push_on(&mut s, 300 * MS, 0, 0x80, flags::ERROR, &[0; 8]); // skipped
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
