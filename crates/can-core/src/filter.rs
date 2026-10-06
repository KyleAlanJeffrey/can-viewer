//! Picks the frames of a [`FrameStore`] that match a [`FrameFilter`], for a filtered trace.

use std::collections::TryReserveError;

use crate::{flags, id_key, FrameStore, IdKey, IdStats};

/// What kind of frame a stored frame is. Every frame is exactly one kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Data,
    Remote,
    Error,
    /// A J1939 transfer reassembled from its transport protocol packets.
    Reassembled,
}

impl FrameKind {
    #[must_use]
    pub fn of(frame_flags: u8) -> Self {
        if frame_flags & flags::ERROR != 0 {
            Self::Error
        } else if frame_flags & flags::REASSEMBLED != 0 {
            Self::Reassembled
        } else if frame_flags & flags::RTR != 0 {
            Self::Remote
        } else {
            Self::Data
        }
    }
}

/// A condition on a frame's payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataRule {
    /// Byte `byte` holds `value`.
    ByteEquals { byte: usize, value: u8 },
    /// Bit `bit` (0 is the least significant) of byte `byte` is `set`.
    Bit { byte: usize, bit: u8, set: bool },
    /// Some byte differs from the previous frame of the same ID and kind, over the bytes both
    /// have, so a remote frame between two data frames is skipped. A longer or shorter payload
    /// alone is no change. An ID's first frame of a kind has nothing to differ from.
    Changes,
}

impl DataRule {
    fn matches(self, data: &[u8], previous: Option<&[u8]>) -> bool {
        match self {
            Self::ByteEquals { byte, value } => data.get(byte) == Some(&value),
            Self::Bit { byte, bit, set } => data
                .get(byte)
                .is_some_and(|b| (b >> (bit & 7)) & 1 == u8::from(set)),
            Self::Changes => previous.is_some_and(|p| data.iter().zip(p).any(|(a, b)| a != b)),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Combine {
    /// Every data rule must match.
    #[default]
    All,
    /// At least one data rule must match.
    Any,
}

/// Which frames to keep. Every part that is set must match; `None` means no restriction, and
/// an empty list matches nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameFilter {
    pub channels: Option<Vec<u8>>,
    pub keys: Option<Vec<IdKey>>,
    pub kinds: Option<Vec<FrameKind>>,
    /// No rules means no condition on the payload.
    pub rules: Vec<DataRule>,
    pub combine: Combine,
    /// Inclusive time window in nanoseconds.
    pub t0_ns: i64,
    pub t1_ns: i64,
}

impl Default for FrameFilter {
    fn default() -> Self {
        Self {
            channels: None,
            keys: None,
            kinds: None,
            rules: Vec::new(),
            combine: Combine::All,
            t0_ns: i64::MIN,
            t1_ns: i64::MAX,
        }
    }
}

impl FrameFilter {
    fn keeps_id(&self, stats: &IdStats) -> bool {
        self.channels
            .as_ref()
            .is_none_or(|c| c.contains(&stats.channel))
    }

    fn keeps_kind(&self, frame_flags: u8) -> bool {
        self.kinds
            .as_ref()
            .is_none_or(|k| k.contains(&FrameKind::of(frame_flags)))
    }

    fn keeps_payload(&self, data: &[u8], previous: Option<&[u8]>) -> bool {
        if self.rules.is_empty() {
            return true;
        }
        let mut results = self.rules.iter().map(|r| r.matches(data, previous));
        match self.combine {
            Combine::All => results.all(|m| m),
            Combine::Any => results.any(|m| m),
        }
    }
}

/// A pass over the frames that match a [`FrameFilter`], made a slice at a time with
/// [`FilterPass::step`], so it can stop between slices. It covers the frames stored when it
/// began; frames stored since are left out.
#[derive(Debug)]
pub struct FilterPass {
    filter: FrameFilter,
    /// The IDs to visit, in order.
    keys: Vec<IdKey>,
    /// The ID of `keys` the next step starts in, and the position in its frames to go on from.
    next_key: usize,
    next_pos: usize,
    /// Frames in the store when the pass began.
    frames: usize,
    /// A bit per frame, so the matches of each ID merge back into store order without a sort.
    matched: Vec<u64>,
    count: usize,
}

impl FilterPass {
    /// A pass over the frames now in `store`, or an error if there is no memory for a bit per
    /// frame.
    pub fn new(store: &FrameStore, filter: FrameFilter) -> Result<Self, TryReserveError> {
        let frames = store.len();
        let words = frames.div_ceil(64);
        let mut matched = Vec::new();
        matched.try_reserve_exact(words)?;
        matched.resize(words, 0u64);
        let keys = if filter.t1_ns < filter.t0_ns {
            Vec::new()
        } else if let Some(keys) = &filter.keys {
            let mut keys = keys.clone();
            keys.sort_unstable();
            keys.dedup();
            keys
        } else {
            store.ids().iter().map(IdStats::key).collect()
        };
        Ok(Self {
            filter,
            keys,
            next_key: 0,
            next_pos: 0,
            frames,
            matched,
            count: 0,
        })
    }

    #[must_use]
    pub fn filter(&self) -> &FrameFilter {
        &self.filter
    }

    /// Frames in the store when the pass began: the frames it covers.
    #[must_use]
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// Matches found so far.
    #[must_use]
    pub fn count(&self) -> usize {
        self.count
    }

    /// Visits about `budget` more frames of `store`, which must be the store the pass began on,
    /// with frames only added since; the frames a "changes" rule walks back over to find the
    /// frame it compares with count too. Returns whether the pass is done.
    pub fn step(&mut self, store: &FrameStore, budget: usize) -> bool {
        let wants_previous = self.filter.rules.contains(&DataRule::Changes);
        let mut budget = budget.max(1);
        while let Some(&key) = self.keys.get(self.next_key) {
            if budget == 0 {
                return false;
            }
            if let Some(stats) = store.id_stats(key).filter(|s| self.filter.keeps_id(s)) {
                let window = store.id_frames_between(stats, self.filter.t0_ns, self.filter.t1_ns);
                let covered = stats
                    .frames
                    .partition_point(|&f| (f as usize) < self.frames);
                let end = window.end.min(covered);
                let mut pos = window.start.max(self.next_pos);
                let mut last_of_kind = [None; 4];
                while pos < end && budget > 0 {
                    let index = stats.frames[pos] as usize;
                    let frame = store.frame(index);
                    pos += 1;
                    budget -= 1;
                    if !self.filter.keeps_kind(frame.flags) {
                        continue;
                    }
                    let kind = FrameKind::of(frame.flags) as usize;
                    let previous = if wants_previous {
                        let previous = last_of_kind[kind].or_else(|| {
                            let (previous, walked) = previous_of_kind(store, stats, pos - 1);
                            budget = budget.saturating_sub(walked);
                            previous
                        });
                        last_of_kind[kind] = Some(index);
                        previous.map(|p| store.frame(p).data)
                    } else {
                        None
                    };
                    if self.filter.keeps_payload(frame.data, previous) {
                        self.matched[index / 64] |= 1 << (index % 64);
                        self.count += 1;
                    }
                }
                if pos < end {
                    self.next_pos = pos;
                    return false;
                }
            }
            self.next_key += 1;
            self.next_pos = 0;
        }
        true
    }

    /// Indices of the matches found, in store (time) order, or an error if there is no memory
    /// for them.
    pub fn rows(&self) -> Result<Vec<u32>, TryReserveError> {
        let mut out = Vec::new();
        out.try_reserve_exact(self.count)?;
        for (word_index, &word) in self.matched.iter().enumerate() {
            let mut bits = word;
            while bits != 0 {
                out.push((word_index * 64 + bits.trailing_zeros() as usize) as u32);
                bits &= bits - 1;
            }
        }
        Ok(out)
    }
}

/// The frame before position `pos` of `stats` of the same [`FrameKind`], as
/// [`FrameStore::previous_of_same_kind_at`] finds it, and how many frames were walked back.
fn previous_of_kind(store: &FrameStore, stats: &IdStats, pos: usize) -> (Option<usize>, usize) {
    let kind = FrameKind::of(store.frame(stats.frames[pos] as usize).flags);
    let found = stats.frames[..pos]
        .iter()
        .rposition(|&f| FrameKind::of(store.frame(f as usize).flags) == kind);
    (
        found.map(|p| stats.frames[p] as usize),
        pos - found.map_or(0, |p| p + 1),
    )
}

impl FrameStore {
    /// Indices of the frames that match `filter`, in store (time) order, or an error if there
    /// is no memory for them.
    pub fn filter(&self, filter: &FrameFilter) -> Result<Vec<u32>, TryReserveError> {
        let mut pass = FilterPass::new(self, filter.clone())?;
        pass.step(self, usize::MAX);
        pass.rows()
    }

    /// Appends to `rows` the frames from index `from` on that match `filter`, in store order, so
    /// the matches of [`FrameStore::filter`] can follow the frames stored after it. On an error
    /// `rows` is as it was.
    pub fn extend_matches(
        &self,
        filter: &FrameFilter,
        from: usize,
        rows: &mut Vec<u32>,
    ) -> Result<(), TryReserveError> {
        let kept = rows.len();
        let keys = filter.keys.as_ref().map(|keys| {
            let mut keys = keys.clone();
            keys.sort_unstable();
            keys
        });
        let wants_previous = filter.rules.contains(&DataRule::Changes);
        for index in from..self.len() {
            let frame = self.frame(index);
            let wanted = (filter.t0_ns..=filter.t1_ns).contains(&frame.ts_ns)
                && filter
                    .channels
                    .as_ref()
                    .is_none_or(|c| c.contains(&frame.channel))
                && keys
                    .as_ref()
                    .is_none_or(|k| k.binary_search(&id_key(frame.channel, frame.id)).is_ok())
                && filter.keeps_kind(frame.flags);
            if !wanted {
                continue;
            }
            let previous = wants_previous
                .then(|| self.previous_of_same_kind(index))
                .flatten()
                .map(|p| self.frame(p).data);
            if filter.keeps_payload(frame.data, previous) {
                if let Err(e) = rows.try_reserve(1) {
                    rows.truncate(kept);
                    return Err(e);
                }
                rows.push(index as u32);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{id_key, FrameRef, FrameSink, ERR_FLAG, EXT_FLAG};

    fn push(
        store: &mut FrameStore,
        ts_ns: i64,
        channel: u8,
        id: u32,
        frame_flags: u8,
        data: &[u8],
    ) {
        store.push(FrameRef {
            ts_ns,
            channel,
            id,
            flags: frame_flags,
            data,
        });
    }

    /// Frames 0 to 7:
    /// 0: t0  can0 100 [01 1F]
    /// 1: t10 can0 200 [FF]
    /// 2: t20 can0 100 [01 1F]   (no change)
    /// 3: t30 can1 100 [08 1F]   (another bus, so another ID)
    /// 4: t40 can0 100 [09 20]   (changes)
    /// 5: t50 can0 100 RTR []
    /// 6: t60 can0 error frame
    /// 7: t70 can0 18FEF100 ext [08]
    fn store() -> FrameStore {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0, 0x100, 0, &[0x01, 0x1F]);
        push(&mut s, 10, 0, 0x200, 0, &[0xFF]);
        push(&mut s, 20, 0, 0x100, 0, &[0x01, 0x1F]);
        push(&mut s, 30, 1, 0x100, 0, &[0x08, 0x1F]);
        push(&mut s, 40, 0, 0x100, 0, &[0x09, 0x20]);
        push(&mut s, 50, 0, 0x100, flags::RTR, &[]);
        push(&mut s, 60, 0, 0x80 | ERR_FLAG, flags::ERROR, &[0; 8]);
        push(&mut s, 70, 0, 0x18FE_F100 | EXT_FLAG, 0, &[0x08]);
        s
    }

    fn check(s: &FrameStore, filter: &FrameFilter, expected: &[u32]) {
        assert_eq!(s.filter(filter).unwrap(), expected, "{filter:?}");
        for budget in [1, 2, 3] {
            let mut pass = FilterPass::new(s, filter.clone()).unwrap();
            let mut steps = 0;
            while !pass.step(s, budget) {
                steps += 1;
                assert!(steps <= s.len(), "{filter:?} never ends");
            }
            assert_eq!(pass.rows().unwrap(), expected, "{filter:?} by {budget}");
            assert_eq!(pass.count(), expected.len());
        }
    }

    #[test]
    fn no_restriction_keeps_every_frame_in_time_order() {
        let s = store();
        check(&s, &FrameFilter::default(), &[0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn filters_by_bus_id_and_time() {
        let s = store();
        let on = |channels: Vec<u8>| FrameFilter {
            channels: Some(channels),
            ..FrameFilter::default()
        };
        check(&s, &on(vec![1]), &[3]);
        check(&s, &on(vec![0, 1]), &[0, 1, 2, 3, 4, 5, 6, 7]);
        check(&s, &on(vec![]), &[]);

        let ids = |keys: Vec<IdKey>| FrameFilter {
            keys: Some(keys),
            ..FrameFilter::default()
        };
        check(&s, &ids(vec![id_key(0, 0x100)]), &[0, 2, 4, 5]);
        check(
            &s,
            &ids(vec![id_key(1, 0x100), id_key(0, 0x200), id_key(0, 0x200)]),
            &[1, 3],
        );
        check(&s, &ids(vec![id_key(9, 0x100)]), &[]);
        check(&s, &ids(vec![]), &[]);

        let between = |t0_ns, t1_ns| FrameFilter {
            t0_ns,
            t1_ns,
            ..FrameFilter::default()
        };
        check(&s, &between(10, 40), &[1, 2, 3, 4]);
        check(&s, &between(11, 39), &[2, 3]);
        check(&s, &between(40, 10), &[]);

        let both = FrameFilter {
            channels: Some(vec![0]),
            keys: Some(vec![id_key(0, 0x100), id_key(1, 0x100)]),
            t0_ns: 10,
            ..FrameFilter::default()
        };
        check(&s, &both, &[2, 4, 5]);
    }

    #[test]
    fn filters_by_frame_kind() {
        let s = store();
        let kinds = |kinds: Vec<FrameKind>| FrameFilter {
            kinds: Some(kinds),
            ..FrameFilter::default()
        };
        check(&s, &kinds(vec![FrameKind::Remote]), &[5]);
        check(&s, &kinds(vec![FrameKind::Error]), &[6]);
        check(&s, &kinds(vec![FrameKind::Data]), &[0, 1, 2, 3, 4, 7]);
        check(
            &s,
            &kinds(vec![FrameKind::Remote, FrameKind::Error]),
            &[5, 6],
        );
        check(&s, &kinds(vec![FrameKind::Reassembled]), &[]);
        check(&s, &kinds(vec![]), &[]);
    }

    #[test]
    fn reassembled_transfers_are_their_own_kind() {
        let mut s = FrameStore::new();
        let (announce, packet) = (0x18EC_FF00 | EXT_FLAG, 0x18EB_FF00 | EXT_FLAG);
        push(
            &mut s,
            0,
            0,
            announce,
            0,
            &[0x20, 9, 0, 2, 0xFF, 0xCA, 0xFE, 0],
        );
        push(&mut s, 1, 0, packet, 0, &[1, 1, 2, 3, 4, 5, 6, 7]);
        push(
            &mut s,
            2,
            0,
            packet,
            0,
            &[2, 8, 9, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        );
        assert_eq!(s.reassembled_frames(), 1);
        let filter = FrameFilter {
            kinds: Some(vec![FrameKind::Reassembled]),
            ..FrameFilter::default()
        };
        check(&s, &filter, &[3]);
        let data = FrameFilter {
            kinds: Some(vec![FrameKind::Data]),
            ..FrameFilter::default()
        };
        check(&s, &data, &[0, 1, 2]);
    }

    #[test]
    fn matches_data_rules_alone_and_combined() {
        let s = store();
        let rules = |rules: Vec<DataRule>, combine| FrameFilter {
            rules,
            combine,
            ..FrameFilter::default()
        };
        let byte_1_is_1f = DataRule::ByteEquals {
            byte: 1,
            value: 0x1F,
        };
        let bit_3_set = DataRule::Bit {
            byte: 0,
            bit: 3,
            set: true,
        };
        let bit_0_clear = DataRule::Bit {
            byte: 0,
            bit: 0,
            set: false,
        };
        check(&s, &rules(vec![byte_1_is_1f], Combine::All), &[0, 2, 3]);
        check(&s, &rules(vec![bit_3_set], Combine::All), &[1, 3, 4, 7]);
        // Frames without byte 0 (the remote frame) match neither a set nor a clear bit.
        check(&s, &rules(vec![bit_0_clear], Combine::All), &[3, 6, 7]);
        check(
            &s,
            &rules(vec![byte_1_is_1f, bit_3_set], Combine::All),
            &[3],
        );
        check(
            &s,
            &rules(vec![byte_1_is_1f, bit_3_set], Combine::Any),
            &[0, 1, 2, 3, 4, 7],
        );
        check(
            &s,
            &rules(
                vec![DataRule::ByteEquals { byte: 40, value: 0 }],
                Combine::Any,
            ),
            &[],
        );
    }

    #[test]
    fn changes_compare_with_the_previous_frame_of_the_same_id_even_outside_the_window() {
        let s = store();
        let changes = FrameFilter {
            rules: vec![DataRule::Changes],
            ..FrameFilter::default()
        };
        // 4 differs from 2; 5 has no bytes to compare; first frames of an ID never match.
        check(&s, &changes, &[4]);
        let late = FrameFilter {
            t0_ns: 40,
            ..changes.clone()
        };
        check(&s, &late, &[4]);
        let after = FrameFilter {
            t0_ns: 41,
            ..changes
        };
        check(&s, &after, &[]);
    }

    #[test]
    fn changes_skip_the_remote_frames_of_a_polled_id() {
        let mut s = FrameStore::new();
        for (t, data) in [(0, [1, 2]), (2, [3, 4]), (4, [5, 6])] {
            push(&mut s, t, 0, 0x100, flags::RTR, &[]);
            push(&mut s, t + 1, 0, 0x100, 0, &data);
        }
        let changes = FrameFilter {
            rules: vec![DataRule::Changes],
            ..FrameFilter::default()
        };
        check(&s, &changes, &[3, 5]);
        let late = FrameFilter {
            t0_ns: 3,
            ..changes
        };
        check(&s, &late, &[3, 5]);
    }

    #[test]
    fn matches_extend_over_frames_stored_later_as_if_found_at_once() {
        let whole = store();
        let filters = [
            FrameFilter::default(),
            FrameFilter {
                channels: Some(vec![0]),
                keys: Some(vec![id_key(0, 0x200), id_key(0, 0x100)]),
                kinds: Some(vec![FrameKind::Data]),
                t0_ns: 10,
                t1_ns: 60,
                ..FrameFilter::default()
            },
            FrameFilter {
                rules: vec![DataRule::Changes],
                ..FrameFilter::default()
            },
            FrameFilter {
                t0_ns: 40,
                t1_ns: 10,
                ..FrameFilter::default()
            },
        ];
        for filter in &filters {
            for split in 0..=whole.len() {
                let mut growing = FrameStore::new();
                for i in 0..split {
                    growing.push(whole.frame(i));
                }
                let mut rows = growing.filter(filter).unwrap();
                for i in split..whole.len() {
                    growing.push(whole.frame(i));
                }
                growing.extend_matches(filter, split, &mut rows).unwrap();
                assert_eq!(rows, whole.filter(filter).unwrap(), "{filter:?} at {split}");
            }
        }
    }

    #[test]
    fn a_pass_leaves_out_the_frames_stored_after_it_began() {
        let mut s = store();
        let mut pass = FilterPass::new(&s, FrameFilter::default()).unwrap();
        assert!(!pass.step(&s, 3));
        push(&mut s, 80, 0, 0x100, 0, &[0x01, 0x1F]);
        push(&mut s, 90, 0, 0x300, 0, &[]);
        while !pass.step(&s, 3) {}
        assert_eq!(pass.frames(), 8);
        assert_eq!(pass.rows().unwrap(), [0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn a_step_counts_the_frames_walked_back_for_a_change() {
        let mut s = FrameStore::new();
        push(&mut s, 0, 0, 0x100, flags::RTR, &[]);
        for t in 1..=10 {
            push(&mut s, t, 0, 0x100, 0, &[t as u8]);
        }
        push(&mut s, 11, 0, 0x100, flags::RTR, &[]);
        push(&mut s, 12, 0, 0x200, flags::RTR, &[]);
        let late = FrameFilter {
            rules: vec![DataRule::Changes],
            kinds: Some(vec![FrameKind::Remote]),
            t0_ns: 11,
            ..FrameFilter::default()
        };
        let mut pass = FilterPass::new(&s, late).unwrap();
        // The remote frame at 11 walks back over the ten data frames to the one at 0, which
        // leaves no budget for ID 200.
        assert!(!pass.step(&s, 5));
        assert!(pass.step(&s, 5));
        assert_eq!(pass.count(), 0);
    }
}
