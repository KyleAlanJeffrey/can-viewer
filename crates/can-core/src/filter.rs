//! Picks the frames of a [`FrameStore`] that match a [`FrameFilter`], for a filtered trace.

use std::collections::TryReserveError;

use crate::{flags, FrameStore, IdKey, IdStats};

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

impl FrameStore {
    /// Indices of the frames that match `filter`, in store (time) order, or an error if there
    /// is no memory for them.
    pub fn filter(&self, filter: &FrameFilter) -> Result<Vec<u32>, TryReserveError> {
        // A bit per frame, so the matches of each ID merge back into time order without a sort.
        let words = self.len().div_ceil(64);
        let mut matched = Vec::new();
        matched.try_reserve_exact(words)?;
        matched.resize(words, 0u64);
        let mut count = 0;
        self.visit_matches(filter, |index| {
            matched[index / 64] |= 1 << (index % 64);
            count += 1;
        });
        let mut out = Vec::new();
        out.try_reserve_exact(count)?;
        for (word_index, &word) in matched.iter().enumerate() {
            let mut bits = word;
            while bits != 0 {
                out.push((word_index * 64 + bits.trailing_zeros() as usize) as u32);
                bits &= bits - 1;
            }
        }
        Ok(out)
    }

    /// How many frames match `filter`, without keeping them.
    #[must_use]
    pub fn count_matches(&self, filter: &FrameFilter) -> usize {
        let mut count = 0;
        self.visit_matches(filter, |_| count += 1);
        count
    }

    /// Calls `visit` with the index of each matching frame, an ID at a time.
    fn visit_matches(&self, filter: &FrameFilter, mut visit: impl FnMut(usize)) {
        if filter.t1_ns < filter.t0_ns {
            return;
        }
        let ids: Vec<&IdStats> = match &filter.keys {
            Some(keys) => {
                let mut keys = keys.clone();
                keys.sort_unstable();
                keys.dedup();
                keys.iter().filter_map(|&k| self.id_stats(k)).collect()
            }
            None => self.ids().iter().collect(),
        };
        let wants_previous = filter.rules.contains(&DataRule::Changes);
        for stats in ids {
            if !filter.keeps_id(stats) {
                continue;
            }
            for pos in self.id_frames_between(stats, filter.t0_ns, filter.t1_ns) {
                let index = stats.frames[pos] as usize;
                let frame = self.frame(index);
                if !filter.keeps_kind(frame.flags) {
                    continue;
                }
                let previous = wants_previous
                    .then(|| self.previous_of_same_kind_at(stats, pos))
                    .flatten()
                    .map(|p| self.frame(p).data);
                if filter.keeps_payload(frame.data, previous) {
                    visit(index);
                }
            }
        }
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
        assert_eq!(s.count_matches(filter), expected.len(), "{filter:?}");
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
}
