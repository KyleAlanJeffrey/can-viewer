//! Counting how often each payload bit changes between pairs of frames.

use std::borrow::Cow;
use std::fmt;

/// How often each payload bit changed, indexed `byte * 8 + bit`.
///
/// Counting a changed bit at a time costs a hard-to-predict branch per bit, which was most of
/// the cost of a frame's per-ID statistics. Instead each pair's changes are first added to eight
/// 8-bit counters per byte, one `u64` per byte, a few instructions per byte with no branch, and
/// moved into the per-bit counts every 255 pairs, before a counter could overflow.
#[derive(Clone, Default)]
pub(super) struct FlipTally {
    counts: Vec<u32>,
    /// Per byte, bits `8 * lane..8 * lane + 8` count the changes of bit `7 - lane` that are not
    /// in `counts` yet.
    pending: Vec<u64>,
    /// Pairs added to `pending` since it was last moved into `counts`.
    pending_pairs: u8,
}

impl FlipTally {
    pub(super) fn from_counts(counts: Vec<u32>) -> Self {
        Self {
            counts,
            ..Self::default()
        }
    }

    /// The number of bits counted.
    pub(super) fn len(&self) -> usize {
        self.counts.len()
    }

    /// Makes room for payloads of `bytes` bytes.
    pub(super) fn grow(&mut self, bytes: usize) {
        if self.counts.len() < bytes * 8 {
            self.counts.resize(bytes * 8, 0);
        }
    }

    /// Counts the bits that differ between `a` and `b`, over the bytes both have.
    pub(super) fn add_pair(&mut self, a: &[u8], b: &[u8]) {
        let common = a.len().min(b.len());
        self.grow(common);
        if self.pending.len() < common {
            self.pending.resize(common, 0);
        }
        if self.pending_pairs == u8::MAX {
            self.flush();
        }
        self.pending_pairs += 1;
        for ((lanes, x), y) in self.pending[..common].iter_mut().zip(a).zip(b) {
            *lanes += spread(x ^ y);
        }
    }

    /// Adds per-bit counts, indexed as these are.
    pub(super) fn add_counts(&mut self, counts: impl IntoIterator<Item = u32>) {
        for (count, more) in self.counts.iter_mut().zip(counts) {
            *count += more;
        }
    }

    /// The per-bit counts.
    pub(super) fn counts(&self) -> Cow<'_, [u32]> {
        if self.pending_pairs == 0 {
            return Cow::Borrowed(&self.counts);
        }
        let mut counts = self.counts.clone();
        add_pending(&mut counts, &self.pending);
        Cow::Owned(counts)
    }

    pub(super) fn into_counts(mut self) -> Vec<u32> {
        self.flush();
        self.counts
    }

    /// Moves the pending counts into the per-bit counts and frees their room.
    pub(super) fn shrink_to_fit(&mut self) {
        self.flush();
        self.pending = Vec::new();
        self.counts.shrink_to_fit();
    }

    pub(super) fn heap_bytes(&self) -> usize {
        self.counts.capacity() * size_of::<u32>() + self.pending.capacity() * size_of::<u64>()
    }

    fn flush(&mut self) {
        if self.pending_pairs > 0 {
            add_pending(&mut self.counts, &self.pending);
            self.pending.fill(0);
            self.pending_pairs = 0;
        }
    }
}

/// Shown as the per-bit counts, however many are still pending.
impl fmt::Debug for FlipTally {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.counts().fmt(f)
    }
}

/// Bit `bit` of `x` as the lowest bit of byte `7 - bit`. The multiplication puts copies of `x`
/// 9 bits apart, so they never carry into each other, and bit `bit` of copy `7 - bit` lands on
/// the top bit of byte `7 - bit`.
fn spread(x: u8) -> u64 {
    (u64::from(x).wrapping_mul(0x8040_2010_0804_0201) >> 7) & 0x0101_0101_0101_0101
}

fn add_pending(counts: &mut [u32], pending: &[u64]) {
    for (bits, lanes) in counts.as_chunks_mut::<8>().0.iter_mut().zip(pending) {
        for (bit, count) in bits.iter_mut().enumerate() {
            *count += ((lanes >> (8 * (7 - bit))) & 0xFF) as u32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One branch per changed bit, as the counts were first worked out.
    fn count_each_bit(counts: &mut Vec<u32>, a: &[u8], b: &[u8]) {
        let common = a.len().min(b.len());
        if counts.len() < common * 8 {
            counts.resize(common * 8, 0);
        }
        for (byte, (x, y)) in a.iter().zip(b).enumerate() {
            for bit in 0..8 {
                counts[byte * 8 + bit] += u32::from((x ^ y) >> bit & 1);
            }
        }
    }

    #[test]
    fn spreads_each_bit_to_its_own_byte() {
        for bit in 0..8 {
            assert_eq!(spread(1 << bit), 1 << (8 * (7 - bit)));
        }
        assert_eq!(spread(0xFF), 0x0101_0101_0101_0101);
        assert_eq!(spread(0), 0);
    }

    /// A small xorshift generator, so the test needs no dependency and fails the same way twice.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> usize {
            (self.next() % n) as usize
        }
    }

    #[test]
    fn counts_as_one_bit_at_a_time_does_however_many_pairs_are_pending() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for round in 0..200 {
            let mut tally = FlipTally::default();
            let mut expected = Vec::new();
            // Rounds of all-changing payloads overflow a lane unless it is moved in time.
            let all_ones = round % 4 == 0;
            let pairs = rng.below(2_000);
            let mut last = vec![0u8; rng.below(9)];
            for pair in 0..pairs {
                let len = if rng.below(10) == 0 {
                    rng.below(65)
                } else {
                    last.len()
                };
                let data: Vec<u8> = (0..len)
                    .map(|i| {
                        if all_ones {
                            !last.get(i).copied().unwrap_or(0)
                        } else {
                            rng.next() as u8 & rng.next() as u8
                        }
                    })
                    .collect();
                tally.add_pair(&last, &data);
                count_each_bit(&mut expected, &last, &data);
                last = data;
                if pair % 97 == 0 {
                    assert_eq!(*tally.counts(), expected[..], "round {round}, pair {pair}");
                }
            }
            assert_eq!(*tally.counts(), expected[..], "round {round}");
            assert_eq!(format!("{tally:?}"), format!("{expected:?}"));
            let mut shrunk = tally.clone();
            shrunk.shrink_to_fit();
            assert_eq!(*shrunk.counts(), expected[..]);
            assert_eq!(shrunk.pending.capacity(), 0);
            assert_eq!(tally.into_counts(), expected);
        }
    }
}
