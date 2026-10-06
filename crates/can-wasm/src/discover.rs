//! Suggested signals: proposes likely signals in one message from how its bits change. Every
//! suggestion is a guess for a person to check against the log, never a decode.
//!
//! The bits are first split into fields by their change rates: within a counter or a value each
//! more significant bit changes less often than the one below it, so a bit that changes more
//! often than its lower neighbour starts a new field. That is tried in both byte orders. Each
//! field, neighbouring fields joined, their pieces and their byte-aligned widths are then read
//! over a sample of frames and tested in turn as a counter, a signed or unsigned value or an
//! enum; single bits that change rarely are flags, or toggles when they change more often, and
//! whole bytes are tested against checksum rules. The best-scoring candidates that don't overlap
//! are kept, and an unsigned value is widened over never-set bits above it to an aligned field.
//! Words that read as IEEE 754 floats are suggested as floats when the evidence is strict
//! enough, and get no other suggestions either way; nor do the bytes of a multiplexed message
//! that take turns with its selector.

use std::borrow::Cow;

use can_core::{flags, FrameStore, IdStats, MAX_PAYLOAD};
use can_dbc_model::{bits, ByteOrder};
use serde::Serialize;

use crate::checksum;

/// At most this many frames of an ID are read, in blocks of consecutive frames spread across the
/// log, so a scan takes about as long for a long log as for a short one. Each event marker adds
/// a block around it, and fields that rarely change are read over the whole log.
const SAMPLE_FRAMES: usize = 20_000;
const SAMPLE_BLOCKS: usize = 20;
/// Payloads longer than this many bytes get proportionally fewer frames, so a 64-byte CAN FD
/// message takes not much longer than a classic one.
const SAMPLE_FULL_BYTES: usize = 8;
const SPARK_POINTS: usize = 64;
/// Suggestions scoring below this are left out.
const MIN_SCORE: f64 = 0.35;
/// At most this many suggestions, or one per payload byte when that is more.
const MAX_SUGGESTIONS: usize = 16;
/// A single bit that changes on fewer than this share of frames can be a flag.
const FLAG_RATE: f64 = 0.05;
/// One that changes more often, but on fewer than this share, can be a toggle such as a blinker.
const TOGGLE_RATE: f64 = 0.3;
/// The payload length read is the longest that at least this share of frames carry.
const LENGTH_SHARE: f64 = 0.99;
/// Within a field a bit changes at most this much more often than the bit below it.
const RATE_TOLERANCE: f64 = 1.25;
/// A drop in change rate this steep from one bit to the next may be a boundary between fields.
const CUT_RATIO: f64 = 3.0;
const MAX_CUTS: usize = 3;
/// At most this many neighbouring fields are joined into one candidate.
const MAX_JOINED: usize = 3;
/// A change within this long of an event marker counts as near it.
const MARKER_WINDOW_NS: i64 = 1_000_000_000;
/// Markers looked at, which bounds the reads near them.
const MAX_MARKERS: usize = 20;
/// Scores within this of each other are about as good.
const CLOSE_SCORE: f64 = 0.03;
/// A value's step counts as small up to this share of its range.
const SMALL_STEP: f64 = 0.2;
/// A step across more than this share of the range is a wrap, as when a counter rolls over.
const WRAP_STEP: f64 = 0.75;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Counter,
    Checksum,
    Flag,
    Enum,
    Continuous,
    Signed,
    /// An IEEE 754 single-precision float, always 32 bits.
    Float,
}

/// A bit range in DBC conventions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start_bit: u16,
    pub size: u16,
    pub byte_order: ByteOrder,
}

impl Range {
    fn intel(start_bit: usize, size: usize) -> Self {
        Self {
            start_bit: start_bit as u16,
            size: size as u16,
            byte_order: ByteOrder::Intel,
        }
    }

    /// The raw value, or 0 when the frame is too short. Like `bits::extract`, but in 64-bit
    /// arithmetic when the bits span at most 8 bytes, which is much faster in WebAssembly.
    fn read(self, data: &[u8]) -> u64 {
        let (start, size) = (usize::from(self.start_bit), usize::from(self.size));
        if size == 0 {
            return 0;
        }
        let (first, last, shift) = match self.byte_order {
            ByteOrder::Intel => (start / 8, (start + size - 1) / 8, start % 8),
            ByteOrder::Motorola => {
                let msb = start / 8 * 8 + 7 - start % 8;
                let lsb = msb + size - 1;
                (msb / 8, lsb / 8, (lsb / 8 + 1) * 8 - 1 - lsb)
            }
        };
        if last - first >= 8 {
            return bits::extract(data, self.start_bit, self.size, self.byte_order).unwrap_or(0);
        }
        let Some(bytes) = data.get(first..=last) else {
            return 0;
        };
        let loaded = match self.byte_order {
            ByteOrder::Intel => bytes
                .iter()
                .rev()
                .fold(0u64, |acc, &b| acc << 8 | u64::from(b)),
            ByteOrder::Motorola => bytes.iter().fold(0u64, |acc, &b| acc << 8 | u64::from(b)),
        };
        (loaded >> shift) & (u64::MAX >> (64 - size))
    }

    /// Payload bits covered, `byte * 8 + bit`.
    fn bits(self) -> Vec<usize> {
        let (start, size) = (usize::from(self.start_bit), usize::from(self.size));
        match self.byte_order {
            ByteOrder::Intel => (start..start + size).collect(),
            ByteOrder::Motorola => {
                let msb = start / 8 * 8 + 7 - start % 8;
                (msb..msb + size).map(bit_at_msb_position).collect()
            }
        }
    }

    fn mask(self) -> [u64; MAX_PAYLOAD / 8] {
        let mut mask = [0u64; MAX_PAYLOAD / 8];
        for bit in self.bits() {
            mask[bit / 64] |= 1 << (bit % 64);
        }
        mask
    }

    fn sort_key(self) -> (u16, u16, bool) {
        (
            self.start_bit,
            self.size,
            self.byte_order == ByteOrder::Motorola,
        )
    }
}

/// The bit index of position `m` counted from the most significant bit of byte 0, where
/// big-endian fields are contiguous.
fn bit_at_msb_position(m: usize) -> usize {
    m / 8 * 8 + 7 - m % 8
}

/// "I pressed the brake here": changes near it make a candidate more likely.
pub struct Marker {
    pub t_ns: i64,
    /// How the reason names it, such as `12 s`.
    pub label: String,
}

/// A decoded signal to compare value candidates with.
pub struct Reference {
    pub name: String,
    /// Timestamps in order, with the signal's value at each.
    pub t_ns: Vec<i64>,
    pub values: Vec<f64>,
}

#[derive(Default)]
pub struct Hints {
    pub markers: Vec<Marker>,
    pub reference: Option<Reference>,
}

/// A linear fit of the reference to a candidate: `reference = raw * factor + offset`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    /// Pearson correlation of the raw value with the reference.
    pub r: f64,
    pub factor: f64,
    pub offset: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Suggestion {
    pub kind: Kind,
    pub range: Range,
    pub signed: bool,
    /// 0 to 1: how sure the guess is.
    pub score: f64,
    /// One line on why, such as `Increments by 1 each frame; wraps at 255`.
    pub reason: String,
    /// A checksum whose rule did not hold on every frame, or was not found at all.
    pub unconfirmed: bool,
    pub fit: Option<Fit>,
    /// Timestamps and scaled values across the whole log, for a sparkline.
    pub spark: Vec<(i64, f64)>,
}

/// What [`suggest`] looked at.
pub struct Findings {
    pub suggestions: Vec<Suggestion>,
    /// Frames of the ID read to score candidates.
    pub sampled_frames: usize,
}

/// The frames of an ID worth reading, and how much of their payloads: remote frames and empty
/// ones carry no data, and the odd short frame should not hide the bytes most frames carry.
struct Frames<'a> {
    list: Cow<'a, [u32]>,
    len: usize,
    /// Changes of each payload bit between consecutive frames of `list`.
    flips: Cow<'a, [u32]>,
}

impl<'a> Frames<'a> {
    fn new(store: &FrameStore, stats: &'a IdStats) -> Self {
        if stats.flags & flags::RTR == 0 && stats.min_len == stats.max_len {
            return Self {
                list: Cow::Borrowed(&stats.frames),
                len: usize::from(stats.min_len).min(MAX_PAYLOAD),
                flips: Cow::Borrowed(&stats.bit_flips),
            };
        }
        let carries_data = |f: u32| {
            let frame = store.frame(f as usize);
            (frame.flags & flags::RTR == 0 && !frame.data.is_empty()).then_some(frame.data.len())
        };
        let mut at_length = [0usize; MAX_PAYLOAD + 1];
        for &f in &stats.frames {
            if let Some(len) = carries_data(f) {
                at_length[len.min(MAX_PAYLOAD)] += 1;
            }
        }
        let total: usize = at_length.iter().sum();
        let mut at_least = 0;
        let mut len = 0;
        for l in (1..=MAX_PAYLOAD).rev() {
            at_least += at_length[l];
            if at_least as f64 >= LENGTH_SHARE * total as f64 {
                len = l;
                break;
            }
        }
        let list: Vec<u32> = stats
            .frames
            .iter()
            .copied()
            .filter(|&f| carries_data(f).is_some_and(|l| l >= len))
            .collect();
        let mut flips = vec![0u32; len * 8];
        for pair in list.windows(2) {
            let (a, b) = (store.frame(pair[0] as usize), store.frame(pair[1] as usize));
            for (byte, (x, y)) in a.data[..len].iter().zip(&b.data[..len]).enumerate() {
                let mut changed = x ^ y;
                while changed != 0 {
                    flips[byte * 8 + changed.trailing_zeros() as usize] += 1;
                    changed &= changed - 1;
                }
            }
        }
        Self {
            list: Cow::Owned(list),
            len,
            flips: Cow::Owned(flips),
        }
    }

    fn steps(&self) -> usize {
        self.list.len().saturating_sub(1)
    }

    /// Positions in `list` of the frames timestamped within `[t0_ns, t1_ns]`.
    fn between(&self, store: &FrameStore, t0_ns: i64, t1_ns: i64) -> std::ops::Range<usize> {
        let ts = |f: &u32| store.frame(*f as usize).ts_ns;
        let start = self.list.partition_point(|f| ts(f) < t0_ns);
        let end = self.list.partition_point(|f| ts(f) <= t1_ns);
        start..end.max(start)
    }

    fn data<'s>(&self, store: &'s FrameStore, position: usize) -> &'s [u8] {
        store.frame(self.list[position] as usize).data
    }
}

/// A fixed pseudo-random number for `n` (SplitMix64).
fn scramble(n: u64) -> u64 {
    let mut z = n.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Frames read to score candidates, with whether each directly follows the one before it in the
/// log (false at the start of each block).
struct Sample<'a> {
    data: Vec<&'a [u8]>,
    ts: Vec<i64>,
    follows: Vec<bool>,
    /// Whether this is only part of the frames.
    partial: bool,
}

impl<'a> Sample<'a> {
    /// The frames at `around` get a block of their own when the log is sampled.
    fn new(store: &'a FrameStore, frames: &Frames, around: &[usize]) -> Self {
        let n = frames.list.len();
        let budget = SAMPLE_FRAMES * SAMPLE_FULL_BYTES / frames.len.max(SAMPLE_FULL_BYTES);
        let block = budget / SAMPLE_BLOCKS;
        let mut spans: Vec<(usize, usize)> = if n <= budget {
            vec![(0, n)]
        } else {
            // Evenly spaced blocks can each land on the same phase of a periodic signal, so each
            // start moves by a fixed pseudo-random amount, never into the next block.
            let stride = (n - block) / (SAMPLE_BLOCKS - 1);
            let slack = (stride - block) / 2;
            let mut spans: Vec<(usize, usize)> = (0..SAMPLE_BLOCKS)
                .map(|b| {
                    let shift = scramble(b as u64) % (2 * slack as u64 + 1);
                    let start = (b * stride + shift as usize)
                        .saturating_sub(slack)
                        .min(n - block);
                    (start, start + block)
                })
                .collect();
            for &at in around {
                let start = at.saturating_sub(block / 2).min(n - block);
                spans.push((start, start + block));
            }
            spans
        };
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in spans {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        let count = merged.iter().map(|(a, b)| b - a).sum();
        let mut sample = Self {
            data: Vec::with_capacity(count),
            ts: Vec::with_capacity(count),
            follows: Vec::with_capacity(count),
            partial: count < n,
        };
        for (start, end) in merged {
            for i in start..end {
                let frame = store.frame(frames.list[i] as usize);
                sample.data.push(frame.data);
                sample.ts.push(frame.ts_ns);
                sample.follows.push(i > start);
            }
        }
        sample
    }

    fn len(&self) -> usize {
        self.data.len()
    }

    fn steps(&self) -> usize {
        self.follows.iter().filter(|&&f| f).count()
    }
}

/// A range the sample sees change about this many times is judged from the sample; one that
/// changes less is read over the whole log, where its few changes are.
const SEEN_ENOUGH: usize = 1000;
/// Positions read across all of an ID's rarely changing ranges, which bounds the work per ID.
const REREAD_BUDGET: usize = 1_000_000;
/// Values read for the whole-log range of values judged from a sample.
const VALUE_READS: usize = 2_000_000;

/// For each byte whose rarely changing bits change too seldom for the sample to show, the
/// positions in the frame list where those bits differ from the frame before, found in one
/// pass over the log. `None` for other bytes, and for all of them when the sample is the log.
struct Rereads {
    rare: Vec<u8>,
    changes: Vec<Option<Vec<u32>>>,
    /// Positions still to be read by [`Rereads::profile`].
    budget: std::cell::Cell<usize>,
}

impl Rereads {
    fn new(store: &FrameStore, frames: &Frames, sample: &Sample, rates: &[f64]) -> Self {
        let len = frames.len;
        let rare: Vec<u8> = (0..len)
            .map(|byte| {
                (0..8)
                    .filter(|b| rates[byte * 8 + b] < FLAG_RATE)
                    .fold(0, |m, b| m | 1 << b)
            })
            .collect();
        let mut changes: Vec<Option<Vec<u32>>> = vec![None; len];
        let n = frames.list.len();
        if sample.partial {
            let most = most_changes_to_list(n, sample.len());
            // Each change of a byte's rare bits flips at least one of them, so the flips bound
            // the list, and all the lists stay within the budget.
            let mut listed = 0;
            for (byte, list) in changes.iter_mut().enumerate() {
                let flips: usize = (0..8)
                    .filter(|b| rare[byte] >> b & 1 == 1)
                    .map(|b| frames.flips[byte * 8 + b] as usize)
                    .sum();
                if rare[byte] != 0 && flips <= most && listed + flips <= REREAD_BUDGET {
                    listed += flips;
                    *list = Some(Vec::with_capacity(flips));
                }
            }
        }
        // Compared eight bytes at a time; most frames change none of the listed bits.
        let words = len.div_ceil(8);
        let mut watch = vec![0u64; words];
        for (byte, list) in changes.iter().enumerate() {
            if list.is_some() {
                watch[byte / 8] |= u64::from(rare[byte]) << (byte % 8 * 8);
            }
        }
        let word = |data: &[u8], w: usize| {
            let mut bytes = [0u8; 8];
            let chunk = &data[w * 8..len.min(w * 8 + 8)];
            bytes[..chunk.len()].copy_from_slice(chunk);
            u64::from_le_bytes(bytes)
        };
        let watched: Vec<usize> = (0..words).filter(|&w| watch[w] != 0).collect();
        if !watched.is_empty() {
            let mut before = frames.data(store, 0);
            for position in 1..n {
                let after = frames.data(store, position);
                for &w in &watched {
                    let mut changed = (word(before, w) ^ word(after, w)) & watch[w];
                    while changed != 0 {
                        let byte = w * 8 + changed.trailing_zeros() as usize / 8;
                        changes[byte]
                            .as_mut()
                            .expect("watched")
                            .push(position as u32);
                        changed &= !(0xFFu64 << (byte % 8 * 8));
                    }
                }
                before = after;
            }
        }
        Self {
            rare,
            changes,
            budget: REREAD_BUDGET.into(),
        }
    }

    /// Where the bits of `range` may change after the first frame, if all its bytes are listed
    /// and its bits are rarely changing ones.
    fn positions(&self, range: Range) -> Option<Vec<u32>> {
        let bits = range.bits();
        if !bits
            .iter()
            .all(|&b| self.rare.get(b / 8).is_some_and(|r| r >> (b % 8) & 1 == 1))
        {
            return None;
        }
        let mut bytes: Vec<usize> = bits.iter().map(|b| b / 8).collect();
        bytes.sort_unstable();
        bytes.dedup();
        let mut out: Vec<u32> = Vec::new();
        for byte in bytes {
            out = merge(&out, self.changes[byte].as_ref()?);
        }
        Some(out)
    }

    /// Over every frame, keeping only the values that differ from the one before: for a range
    /// that rarely changes, where a sample can miss what it does. Read only where its bytes
    /// change; `None` when they are not listed or the budget is spent.
    fn profile<'p>(
        &self,
        store: &FrameStore,
        frames: &Frames,
        range: Range,
    ) -> Option<Profile<'p>> {
        let positions = self.positions(range)?;
        let budget = self.budget.get().checked_sub(positions.len())?;
        self.budget.set(budget);
        let mut values = vec![range.read(frames.data(store, 0))];
        for &position in &positions {
            let v = range.read(frames.data(store, position as usize));
            if values.last() != Some(&v) {
                values.push(v);
            }
        }
        let follows: Vec<bool> = (0..values.len()).map(|i| i > 0).collect();
        let mut p = Profile::from_values(values, Cow::Owned(follows));
        p.steps = frames.steps();
        Some(p)
    }
}

/// The most changes a byte may have for its changes to be listed: about as many as would show
/// [`SEEN_ENOUGH`] of them in a sample of `sampled` of the `n` frames. In 64-bit arithmetic, as
/// a long log overflows a 32-bit `usize`.
fn most_changes_to_list(n: usize, sampled: usize) -> usize {
    let most = SEEN_ENOUGH as u64 * n as u64 / sampled.max(1) as u64;
    usize::try_from(most).unwrap_or(usize::MAX)
}

/// The sorted union of two sorted lists.
fn merge(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (x, y) = (a[i], b[j]);
        out.push(x.min(y));
        i += usize::from(x <= y);
        j += usize::from(y <= x);
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

/// What candidates are judged against.
struct Log<'a> {
    store: &'a FrameStore,
    frames: &'a Frames<'a>,
    sample: &'a Sample<'a>,
    /// Each payload bit's share of frames on which it changes.
    rates: &'a [f64],
    rereads: &'a Rereads,
}

/// A candidate's raw values, and how they move.
struct Profile<'a> {
    values: Vec<u64>,
    /// Whether each value directly follows the one before it.
    follows: Cow<'a, [bool]>,
    steps: usize,
    changes: usize,
    max: u64,
    distinct: usize,
}

impl<'a> Profile<'a> {
    fn new(sample: &'a Sample, range: Range) -> Self {
        let values = sample.data.iter().map(|d| range.read(d)).collect();
        Self::from_values(values, Cow::Borrowed(&sample.follows))
    }

    fn from_values(values: Vec<u64>, follows: Cow<'a, [bool]>) -> Self {
        let (mut steps, mut changes) = (0, 0);
        for i in 1..values.len() {
            if follows[i] {
                steps += 1;
                changes += usize::from(values[i] != values[i - 1]);
            }
        }
        let max = values.iter().copied().max().unwrap_or(0);
        let distinct = if max < 1 << 16 {
            let mut seen = vec![0u64; (max as usize >> 6) + 1];
            let mut count = 0;
            for &v in &values {
                let (word, bit) = (v as usize >> 6, 1u64 << (v & 63));
                count += usize::from(seen[word] & bit == 0);
                seen[word] |= bit;
            }
            count
        } else {
            let mut sorted = values.clone();
            sorted.sort_unstable();
            sorted.dedup();
            sorted.len()
        };
        Self {
            max,
            distinct,
            values,
            follows,
            steps,
            changes,
        }
    }

    fn change_rate(&self) -> f64 {
        self.changes as f64 / self.steps.max(1) as f64
    }

    /// Bits that differ from the first value somewhere.
    fn varying(&self) -> u64 {
        let first = self.values.first().copied().unwrap_or(0);
        self.values.iter().fold(0, |acc, &v| acc | (v ^ first))
    }
}

/// Raw values read as `size`-bit two's complement, or as they are.
fn interpret(values: &[u64], size: u16, signed: bool) -> Vec<f64> {
    values
        .iter()
        .map(|&v| {
            if signed {
                bits::sign_extend(v, size) as f64
            } else {
                v as f64
            }
        })
        .collect()
}

struct Smoothness {
    /// Share of changes that are small for the value's range.
    small: f64,
    /// Share of changes that jump across most of the range.
    wraps: f64,
    min: f64,
    max: f64,
}

fn smoothness(values: &[f64], follows: &[bool]) -> Option<Smoothness> {
    let min = values.iter().copied().reduce(f64::min)?;
    let max = values.iter().copied().reduce(f64::max)?;
    let span = max - min;
    if !(span > 0.0 && span.is_finite()) {
        return None;
    }
    let small_limit = (span * SMALL_STEP).max(1.0);
    let (mut changes, mut small, mut wraps) = (0usize, 0usize, 0usize);
    for i in 1..values.len() {
        if !follows[i] || values[i] == values[i - 1] {
            continue;
        }
        let step = (values[i] - values[i - 1]).abs();
        changes += 1;
        small += usize::from(step <= small_limit);
        wraps += usize::from(span >= 4.0 && step > span * WRAP_STEP);
    }
    let changes = changes.max(1) as f64;
    Some(Smoothness {
        small: small as f64 / changes,
        wraps: wraps as f64 / changes,
        min,
        max,
    })
}

/// For a value wider than `split` bits, whether its low `split` bits belong with the bits above.
///
/// When the bits above step by one, a real value's low bits have just wrapped the same way: up
/// past their top to a small value, or down past 0. A byte of noise beside a slow value, or a
/// second value packed below the first, wraps either way at random, though the two together can
/// look smooth. With too few such steps to tell, the low bits must themselves move by small
/// steps, counted across a wrap.
fn low_bits_belong(values: &[u64], follows: &[bool], split: u16) -> bool {
    let low_mask = (1u64 << split) - 1;
    let small_step = 1u64 << (split - 3);
    let (mut changes, mut small) = (0usize, 0usize);
    for i in 1..values.len() {
        let (low_before, low_after) = (values[i - 1] & low_mask, values[i] & low_mask);
        if follows[i] && low_before != low_after {
            let up = low_after.wrapping_sub(low_before) & low_mask;
            let down = low_before.wrapping_sub(low_after) & low_mask;
            changes += 1;
            small += usize::from(up.min(down) <= small_step);
        }
    }
    carries_agree(values, follows, split)
        .unwrap_or(changes == 0 || small as f64 / changes as f64 >= 0.6)
}

/// When the bits above `split` step by one, whether the bits below wrapped the same way on most
/// such steps, or `None` with too few of them to tell.
fn carries_agree(values: &[u64], follows: &[bool], split: u16) -> Option<bool> {
    let low_mask = (1u64 << split) - 1;
    let (mut carries, mut consistent) = (0usize, 0usize);
    for i in 1..values.len() {
        if !follows[i] {
            continue;
        }
        let (before, after) = (values[i - 1], values[i]);
        let (low_before, low_after) = (before & low_mask, after & low_mask);
        let (high_before, high_after) = (before >> split, after >> split);
        if high_after == high_before.wrapping_add(1) {
            carries += 1;
            consistent += usize::from(low_after < low_before);
        } else if high_before == high_after.wrapping_add(1) {
            carries += 1;
            consistent += usize::from(low_after > low_before);
        }
    }
    (carries >= 5).then(|| consistent as f64 / carries as f64 >= 0.8)
}

/// The commonest step between consecutive values modulo `modulus`, and its share of steps.
fn commonest_step(values: &[u64], follows: &[bool], modulus: u128) -> (u64, f64) {
    let mut steps: Vec<u64> = (1..values.len())
        .filter(|&i| follows[i])
        .map(|i| {
            ((u128::from(values[i]) + modulus - u128::from(values[i - 1]) % modulus) % modulus)
                as u64
        })
        .collect();
    if steps.is_empty() {
        return (0, 0.0);
    }
    steps.sort_unstable();
    let (mut best, mut best_n, mut run) = (steps[0], 0usize, 0usize);
    for i in 0..steps.len() {
        run = if i > 0 && steps[i] == steps[i - 1] {
            run + 1
        } else {
            1
        };
        if run > best_n {
            best_n = run;
            best = steps[i];
        }
    }
    (best, best_n as f64 / steps.len() as f64)
}

struct Scored {
    kind: Kind,
    range: Range,
    signed: bool,
    score: f64,
    reason: String,
    unconfirmed: bool,
}

fn percent(share: f64) -> String {
    if share > 0.0 && share < 0.01 {
        "under 1%".into()
    } else if share > 0.99 && share < 1.0 {
        "over 99%".into()
    } else {
        format!("{:.0}%", share * 100.0)
    }
}

fn counter(range: Range, p: &Profile) -> Option<Scored> {
    if p.steps < 8 || p.change_rate() < 0.9 {
        return None;
    }
    let natural = 1u128 << range.size;
    let mut moduli = vec![natural];
    if u128::from(p.max) + 1 < natural && p.max >= 1 {
        moduli.push(u128::from(p.max) + 1);
    }
    let (step, share, modulus) = moduli
        .into_iter()
        .map(|m| {
            // Most candidates are no counter, which a few hundred steps already show.
            let (_, early) = commonest_step(&p.values[..p.values.len().min(256)], &p.follows, m);
            if early < 0.6 {
                return (0, early, m);
            }
            let (step, share) = commonest_step(&p.values, &p.follows, m);
            (step, share, m)
        })
        .filter(|&(step, _, _)| step != 0)
        .max_by(|a, b| a.1.total_cmp(&b.1).then(b.2.cmp(&a.2)))?;
    if share < 0.9 {
        return None;
    }
    let top = modulus - 1;
    let mut score = 0.6 + 0.38 * ((share - 0.9) / 0.1);
    // The same counter read with constant bits above it: the tighter range is the likelier one.
    if modulus != natural {
        score -= 0.03;
    }
    let moves = if u128::from(step) * 2 > modulus {
        format!("Decrements by {}", modulus - u128::from(step))
    } else {
        format!("Increments by {step}")
    };
    let reason = if range.size == 1 {
        score = score.min(0.7);
        "Toggles every frame".to_string()
    } else if top == 1 && share >= 0.995 {
        format!("Alternates between 0 and 1 each frame{SELECTOR_NOTE}")
    } else if top < MAX_PAGES && share >= 0.995 {
        format!("{moves} each frame; wraps at {top}{SELECTOR_NOTE}")
    } else if share >= 0.995 {
        format!("{moves} each frame; wraps at {top}")
    } else {
        format!("{moves} on {} of frames; wraps at {top}", percent(share))
    };
    Some(Scored {
        kind: Kind::Counter,
        range,
        signed: false,
        score,
        reason,
        unconfirmed: false,
    })
}

/// A few values in turn is also how a multiplexed message names the page each frame carries.
const MAX_PAGES: u128 = 8;
const SELECTOR_NOTE: &str = ": a counter or multiplexer selector";

/// The best counter that could be a multiplexer selector, with its number of pages.
fn selector(scored: &[Scored], sample: &Sample) -> Option<(Range, usize)> {
    let best = scored
        .iter()
        .filter(|s| s.kind == Kind::Counter && s.score >= 0.9 && s.reason.ends_with(SELECTOR_NOTE))
        .max_by(|a, b| a.score.total_cmp(&b.score))?;
    let pages = Profile::new(sample, best.range).max as usize + 1;
    Some((best.range, pages))
}

/// Whether the range reads like part of a multiplexed cell: it moves much more from one frame to
/// the next than from one frame of a page to the next frame of that page.
fn changes_with_the_page(sample: &Sample, range: Range, pages: usize) -> bool {
    let values: Vec<u64> = sample.data.iter().map(|d| range.read(d)).collect();
    let (mut steps, mut each_frame, mut each_page) = (0u64, 0u64, 0u64);
    for i in pages..values.len() {
        if !sample.follows[i + 1 - pages..=i].iter().all(|&f| f) {
            continue;
        }
        steps += 1;
        each_frame += values[i].abs_diff(values[i - 1]).min(u64::from(u32::MAX));
        each_page += values[i]
            .abs_diff(values[i - pages])
            .min(u64::from(u32::MAX));
    }
    each_frame > 3 * each_page + steps / 20
}

/// How many bits of `byte` change from one frame to the next, on average.
fn changed_bits_per_step(sample: &Sample, byte: usize) -> f64 {
    let changed: u32 = (1..sample.len())
        .filter(|&i| sample.follows[i])
        .map(|i| (sample.data[i][byte] ^ sample.data[i - 1][byte]).count_ones())
        .sum();
    f64::from(changed) / sample.steps().max(1) as f64
}

/// Whether the range starts at bit 0 of a byte and covers whole bytes.
fn byte_aligned(range: Range) -> bool {
    let bits = range.bits();
    range.size.is_multiple_of(8) && bits.iter().min().is_some_and(|&b| b % 8 == 0)
}

/// How `values` of a `size`-bit field read best, as signed or unsigned, if either changes
/// smoothly.
fn reading(values: &[u64], size: u16, follows: &[bool]) -> Option<(bool, Smoothness)> {
    let low_ok = (8..size)
        .step_by(8)
        .all(|split| low_bits_belong(values, follows, split));
    let ok = |s: &Smoothness| low_ok && s.small >= 0.85 && s.wraps <= 0.02;
    let unsigned = smoothness(&interpret(values, size, false), follows)?;
    let signed = smoothness(&interpret(values, size, true), follows);
    let use_signed = signed.as_ref().is_some_and(|s| {
        ok(s)
            && s.min < 0.0
            && s.max > 0.0
            && (!ok(&unsigned) || s.wraps < unsigned.wraps || s.small > unsigned.small + 0.05)
    });
    if use_signed {
        signed.map(|s| (true, s))
    } else {
        ok(&unsigned).then_some((false, unsigned))
    }
}

fn value(range: Range, p: &Profile) -> Option<Scored> {
    if range.size < 4 || p.distinct < 12 {
        return None;
    }
    // A signed value with constant bits above it reads as an unsigned one that jumps at zero,
    // too rarely to count against it; the narrower signed range is the likelier signal.
    let width = (64 - p.varying().leading_zeros()) as u16;
    if width < range.size && width >= 4 {
        let narrow: Vec<u64> = p.values.iter().map(|v| v & ((1 << width) - 1)).collect();
        if matches!(reading(&narrow, width, &p.follows), Some((true, _))) {
            return None;
        }
    }
    let (use_signed, chosen) = reading(&p.values, range.size, &p.follows)?;
    let resolution = ((p.distinct as f64).log2() / 12.0).min(1.0);
    let score = 0.45 + 0.3 * ((chosen.small - 0.85) / 0.15) + 0.15 * resolution
        - 15.0 * chosen.wraps
        + if byte_aligned(range) { 0.03 } else { 0.0 };
    let reason = if use_signed {
        "Crosses zero with smooth changes".to_string()
    } else {
        format!(
            "Changes smoothly; {} values from {} to {}",
            p.distinct, chosen.min, chosen.max
        )
    };
    Some(Scored {
        kind: if use_signed {
            Kind::Signed
        } else {
            Kind::Continuous
        },
        range,
        signed: use_signed,
        score,
        reason,
        unconfirmed: false,
    })
}

/// Whether the bits that change in `p` look like separate flags: each changes several times, and
/// almost never on the same frame as another.
fn separate_bits(p: &Profile) -> bool {
    let (mut changes, mut together) = (0usize, 0usize);
    let mut per_bit = [0usize; 64];
    for i in 1..p.values.len() {
        let changed = p.values[i] ^ p.values[i - 1];
        if !p.follows[i] || changed == 0 {
            continue;
        }
        changes += 1;
        together += usize::from(changed.count_ones() > 1);
        let mut rest = changed;
        while rest != 0 {
            per_bit[rest.trailing_zeros() as usize] += 1;
            rest &= rest - 1;
        }
    }
    let varying = p.varying();
    let often = (0..64)
        .filter(|b| varying >> b & 1 == 1)
        .all(|b| per_bit[b] >= 6);
    often && together * 20 <= changes
}

fn enumeration(range: Range, p: &Profile) -> Option<Scored> {
    let rate = p.change_rate();
    if range.size < 2 || !(2..=16).contains(&p.distinct) || rate > 0.2 || p.changes == 0 {
        return None;
    }
    // One changing bit is a flag, whatever constant bits sit beside it.
    if p.varying().count_ones() < 2 || separate_bits(p) {
        return None;
    }
    let mut values = p.values.clone();
    values.sort_unstable();
    values.dedup();
    let listed = if values.len() <= 6 {
        let text: Vec<String> = values.iter().map(u64::to_string).collect();
        format!(": {}", text.join(", "))
    } else {
        String::new()
    };
    Some(Scored {
        kind: Kind::Enum,
        range,
        signed: false,
        score: 0.55 + 0.25 * (1.0 - rate / 0.2),
        reason: format!("Takes {} distinct values{listed}", p.distinct),
        unconfirmed: false,
    })
}

fn times(n: u32) -> String {
    match n {
        1 => "once".into(),
        2 => "twice".into(),
        _ => format!("{n} times"),
    }
}

fn flag_reason(flips: u32, steps: usize, set: f64) -> String {
    let rate = f64::from(flips) / steps.max(1) as f64;
    if rate >= FLAG_RATE {
        format!(
            "Toggles on {} of frames; set {} of the time",
            percent(rate),
            percent(set)
        )
    } else {
        format!(
            "Switches {}; set {} of the time",
            times(flips),
            percent(set)
        )
    }
}

/// Whether `bit` mostly changes on the same frames as a neighbouring bit, as a bit inside a
/// counter or value does when the bits below carry into it.
fn moves_with_a_neighbour<'d>(
    pairs: impl Iterator<Item = (&'d [u8], &'d [u8])>,
    bit: usize,
    rates: &[f64],
) -> bool {
    let mut neighbours = Vec::new();
    if bit > 0 {
        neighbours.push(bit - 1);
    }
    if bit + 1 < rates.len() {
        neighbours.push(bit + 1);
    }
    // In big-endian order bit 0 of a byte sits just above bit 7 of the next.
    if bit.is_multiple_of(8) && bit + 15 < rates.len() {
        neighbours.push(bit + 15);
    }
    if bit % 8 == 7 && bit >= 15 {
        neighbours.push(bit - 15);
    }
    neighbours.retain(|&n| rates[n] > 0.0);
    let get = |d: &[u8], b: usize| d[b / 8] >> (b % 8) & 1;
    let mut changes = 0usize;
    let mut together = vec![0usize; neighbours.len()];
    for (before, after) in pairs {
        if get(before, bit) == get(after, bit) {
            continue;
        }
        changes += 1;
        for (t, &n) in together.iter_mut().zip(&neighbours) {
            *t += usize::from(get(before, n) != get(after, n));
        }
    }
    together.iter().zip(&neighbours).any(|(&t, &n)| {
        let share = t as f64 / changes.max(1) as f64;
        // With a change or two, a busy neighbour can change on the same frame by chance.
        share > 0.4 && share > rates[n] + 0.3 && (changes >= 3 || rates[n] < FLAG_RATE)
    })
}

fn flag(range: Range, p: &Profile, log: &Log) -> Option<Scored> {
    let bit = usize::from(range.start_bit);
    let flips = log.frames.flips.get(bit).copied().unwrap_or(0);
    let rate = f64::from(flips) / log.frames.steps().max(1) as f64;
    if range.size != 1 || flips == 0 || rate >= TOGGLE_RATE {
        return None;
    }
    // A bit that toggles often is a blinker or such only when it does so at a steady pace; bits
    // set at random are noise.
    if rate >= FLAG_RATE && !steady_runs(p) {
        return None;
    }
    let set = p.values.iter().filter(|&&v| v != 0).count() as f64 / p.values.len().max(1) as f64;
    let score = if rate < FLAG_RATE {
        0.5 + 0.2 * (1.0 - rate / FLAG_RATE)
    } else {
        0.5
    };
    Some(Scored {
        kind: Kind::Flag,
        range,
        signed: false,
        score,
        reason: flag_reason(flips, log.frames.steps(), set),
        unconfirmed: false,
    })
}

/// Whether a bit stays on, and stays off, for about the same number of frames each time.
fn steady_runs(p: &Profile) -> bool {
    let mut runs: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
    // The first run of each stretch of following frames may have started before it.
    let mut run: Option<usize> = None;
    for i in 1..p.values.len() {
        if !p.follows[i] {
            run = None;
            continue;
        }
        if p.values[i] == p.values[i - 1] {
            run = run.map(|n| n + 1);
            continue;
        }
        if let Some(n) = run {
            runs[usize::from(p.values[i - 1] != 0)].push(n);
        }
        run = Some(1);
    }
    runs.iter_mut().all(|lengths| {
        if lengths.len() < 4 {
            return false;
        }
        lengths.sort_unstable();
        let typical = lengths[lengths.len() / 2];
        let near = lengths
            .iter()
            .filter(|&&n| n.abs_diff(typical) <= (typical / 4).max(1))
            .count();
        near as f64 >= 0.6 * lengths.len() as f64
    })
}

/// Whether a flag's bit is more likely part of a counter or value beside it. Read from the
/// sample when that shows the bit changing a few times, else from the whole log.
fn flag_moves_with_a_neighbour(log: &Log, bit: usize) -> bool {
    let sample = log.sample;
    let in_sample = (1..sample.len())
        .filter(|&i| {
            let changed = sample.data[i][bit / 8] ^ sample.data[i - 1][bit / 8];
            sample.follows[i] && (changed >> (bit % 8)) & 1 == 1
        })
        .count();
    let whole = (in_sample < 3)
        .then(|| log.rereads.positions(Range::intel(bit, 1)))
        .flatten();
    match whole {
        Some(positions) => {
            let data = |p: u32| log.frames.data(log.store, p as usize);
            let pairs = positions.into_iter().map(|p| (data(p - 1), data(p)));
            moves_with_a_neighbour(pairs, bit, log.rates)
        }
        None => {
            let pairs = (1..sample.len())
                .filter(|&i| sample.follows[i])
                .map(|i| (sample.data[i - 1], sample.data[i]));
            moves_with_a_neighbour(pairs, bit, log.rates)
        }
    }
}

/// The share of frames of the ID with the flag set: over all of them when the flag changes
/// rarely, as the sample can miss a short stretch, else over the sample.
fn set_share(log: &Log, range: Range) -> f64 {
    let Some(positions) = log.rereads.positions(range) else {
        let data = &log.sample.data;
        let set = data.iter().filter(|d| range.read(d) != 0).count();
        return set as f64 / data.len().max(1) as f64;
    };
    let n = log.frames.list.len();
    let (mut set, mut from) = (0, 0);
    let mut on = range.read(log.frames.data(log.store, 0)) != 0;
    for p in positions.into_iter().map(|p| p as usize).chain([n]) {
        if on {
            set += p - from;
        }
        if p < n {
            on = range.read(log.frames.data(log.store, p)) != 0;
            from = p;
        }
    }
    set as f64 / n.max(1) as f64
}

/// `0-6`, or `0-2, 4-7` around a byte in the middle.
fn byte_list(len: usize, skip: usize) -> String {
    let mut parts = Vec::new();
    let mut run: Option<(usize, usize)> = None;
    for b in (0..len).filter(|&b| b != skip) {
        run = match run {
            Some((first, last)) if last + 1 == b => Some((first, b)),
            Some(done) => {
                parts.push(done);
                Some((b, b))
            }
            None => Some((b, b)),
        };
    }
    parts.extend(run);
    let text: Vec<String> = parts
        .into_iter()
        .map(|(a, b)| {
            if a == b {
                a.to_string()
            } else {
                format!("{a}-{b}")
            }
        })
        .collect();
    text.join(", ")
}

fn checksums(sample: &Sample, len: usize, rates: &[f64]) -> Vec<Scored> {
    let mut out = Vec::new();
    for byte in 0..len {
        let range = Range::intel(byte * 8, 8);
        let p = Profile::new(sample, range);
        if p.change_rate() < 0.5 || p.distinct < 16 {
            continue;
        }
        let over = byte_list(len, byte);
        if let Some(m) = checksum::detect(&sample.data, byte, len, 0.9) {
            let (score, reason, unconfirmed) = if m.share >= 0.995 {
                (0.97, format!("Matches {} over bytes {over}", m.name), false)
            } else {
                (
                    0.6 + 1.5 * (m.share - 0.9),
                    format!(
                        "Matches {} over bytes {over} on {} of frames; checksum rule unconfirmed",
                        m.name,
                        percent(m.share)
                    ),
                    true,
                )
            };
            out.push(Scored {
                kind: Kind::Checksum,
                range,
                signed: false,
                score,
                reason,
                unconfirmed,
            });
            continue;
        }
        let random = (0..8).all(|b| (0.3..=0.7).contains(&rates[byte * 8 + b]));
        if byte == len - 1 && random && p.distinct >= 64 {
            out.push(Scored {
                kind: Kind::Checksum,
                range,
                signed: false,
                score: 0.4,
                reason: "Changes on most frames and looks random; checksum rule unconfirmed".into(),
                unconfirmed: true,
            });
        }
    }
    out
}

/// 32-bit words that read as smoothly changing IEEE 754 single floats. Nothing else is suggested
/// inside them: their exponent and mantissa bits would otherwise look like flags and values. The
/// words with the strictest evidence, whose mantissa also carries as one number, are suggested as
/// floats themselves. A word holding one of the ranges in `kept`, such as a counter's, is not a
/// float, and nor is one overlapping such a range suggested.
fn float_words(
    sample: &Sample,
    len: usize,
    kept: &[[u64; MAX_PAYLOAD / 8]],
) -> ([u64; MAX_PAYLOAD / 8], Vec<Scored>) {
    let mut taken = [0u64; MAX_PAYLOAD / 8];
    let mut found = Vec::new();
    for byte in 0..len.saturating_sub(3) {
        for range in [
            Range::intel(byte * 8, 32),
            Range {
                start_bit: (byte * 8 + 7) as u16,
                size: 32,
                byte_order: ByteOrder::Motorola,
            },
        ] {
            let word = range.mask();
            if kept
                .iter()
                .any(|k| k.iter().zip(&word).all(|(k, w)| k & !w == 0))
            {
                continue;
            }
            let floats: Vec<f32> = sample
                .data
                .iter()
                .map(|d| f32::from_bits(range.read(d) as u32))
                .collect();
            // Integers read as floats take every exponent; real readings keep to a few decades.
            let plausible = floats
                .iter()
                .filter(|v| **v == 0.0 || (1e-6..=1e6).contains(&v.abs()))
                .count();
            if (plausible as f64) < 0.99 * floats.len() as f64 {
                continue;
            }
            let values: Vec<f64> = floats.iter().map(|&v| f64::from(v)).collect();
            let mut distinct: Vec<u32> = floats.iter().map(|v| v.to_bits()).collect();
            distinct.sort_unstable();
            distinct.dedup();
            let exponent = |bits: u32| bits >> 23 & 0xFF;
            let exponents_vary = distinct
                .iter()
                .any(|&b| exponent(b) != exponent(distinct[0]));
            // With one exponent, a constant byte such as 0x42 ahead of three separate values
            // also reads as smooth floats; a real reading's mantissa carries as one number.
            let mantissas: Vec<u64> = floats
                .iter()
                .map(|v| u64::from(v.to_bits() & 0x7F_FFFF))
                .collect();
            let one_number = low_bits_belong(&mantissas, &sample.follows, 16);
            let carries = carries_agree(&mantissas, &sample.follows, 16);
            let Some(smooth) =
                smoothness(&values, &sample.follows).filter(|s| s.small >= 0.85 && s.wraps <= 0.02)
            else {
                continue;
            };
            if distinct.len() < 16 || !(exponents_vary || one_number) {
                continue;
            }
            for (t, m) in taken.iter_mut().zip(word) {
                *t |= m;
            }
            let overlaps_kept = kept
                .iter()
                .any(|k| k.iter().zip(&word).any(|(k, w)| k & w != 0));
            // A real float's low mantissa bits jitter as it moves, or carry into the bits above;
            // ones that change smoothly on their own are a second value beside the one on top.
            let lows: Vec<f64> = floats
                .iter()
                .map(|v| f64::from(v.to_bits() as u16))
                .collect();
            let low_is_a_value = smoothness(&lows, &sample.follows)
                .is_some_and(|s| s.small >= 0.85 && s.wraps <= 0.02);
            // An integer read as a float moves its exponent in step with its own bits, sweeping
            // many decades; a reading keeps to a few, apart from the odd value near zero.
            let mut magnitudes: Vec<f32> = floats
                .iter()
                .filter(|v| **v != 0.0)
                .map(|v| v.abs())
                .collect();
            let few_decades = magnitudes.len() >= 2 && {
                let low = magnitudes.len() / 20;
                let (_, &mut low, _) = magnitudes.select_nth_unstable_by(low, f32::total_cmp);
                let high = magnitudes.iter().copied().fold(0.0, f32::max);
                high <= low * 1e6
            };
            if !overlaps_kept && few_decades && (!low_is_a_value || carries == Some(true)) {
                // Within one exponent an integer with a constant top byte reads the same way.
                let score = 0.65 + 0.3 * ((smooth.small - 0.85) / 0.15)
                    - 15.0 * smooth.wraps
                    - if exponents_vary { 0.0 } else { 0.05 };
                found.push(Scored {
                    kind: Kind::Float,
                    range,
                    signed: false,
                    score,
                    reason: format!(
                        "Reads as a 32-bit float changing smoothly from {} to {}",
                        short_number(smooth.min),
                        short_number(smooth.max)
                    ),
                    unconfirmed: false,
                });
            }
        }
    }
    (taken, found)
}

/// `x` to four significant digits, without trailing zeros.
fn short_number(x: f64) -> String {
    let decimals = if x == 0.0 {
        0
    } else {
        (3 - x.abs().log10().floor() as i32).clamp(0, 6) as usize
    };
    let text = format!("{x:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// Bits from least to most significant, as if the payload were one integer in `order`.
fn significance(order: ByteOrder, bits: usize) -> Vec<usize> {
    match order {
        ByteOrder::Intel => (0..bits).collect(),
        ByteOrder::Motorola => (0..bits)
            .map(|i| bit_at_msb_position(bits - 1 - i))
            .collect(),
    }
}

/// The range of positions `lo..=hi` of `seq` in `order`. A big-endian range inside one byte reads
/// like the little-endian one, which is used instead.
fn range_of(order: ByteOrder, seq: &[usize], lo: usize, hi: usize) -> Range {
    let size = hi - lo + 1;
    let (low_bit, high_bit) = (seq[lo], seq[hi]);
    if order == ByteOrder::Intel || low_bit / 8 == high_bit / 8 {
        Range::intel(low_bit.min(high_bit), size)
    } else {
        Range {
            start_bit: high_bit as u16,
            size: size as u16,
            byte_order: ByteOrder::Motorola,
        }
    }
}

/// Runs of positions of `seq` whose change rates fall, or stay about level, from each bit to
/// the next more significant one.
fn fields(rates: &[f64], seq: &[usize]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < seq.len() {
        if rates[seq[i]] == 0.0 {
            i += 1;
            continue;
        }
        let lo = i;
        while i + 1 < seq.len() {
            let (here, next) = (rates[seq[i]], rates[seq[i + 1]]);
            if next == 0.0 || next > here * RATE_TOLERANCE {
                break;
            }
            i += 1;
        }
        out.push((lo, i));
        i += 1;
    }
    out
}

/// Ranges to test within one field: the field, its pieces between steep drops in change rate,
/// and whole-byte widths from each piece's start; each also widened over constant bits above it
/// to a whole number of bytes.
fn pieces(rates: &[f64], seq: &[usize], (lo, hi): (usize, usize)) -> Vec<(usize, usize)> {
    let mut cuts: Vec<(f64, usize)> = (lo..hi)
        .filter_map(|k| {
            let ratio = rates[seq[k]] / rates[seq[k + 1]];
            (ratio > CUT_RATIO).then_some((ratio, k + 1))
        })
        .collect();
    cuts.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut bounds: Vec<usize> = cuts.into_iter().take(MAX_CUTS).map(|(_, k)| k).collect();
    bounds.push(lo);
    bounds.push(hi + 1);
    bounds.sort_unstable();

    let mut out = Vec::new();
    for (i, &a) in bounds.iter().enumerate() {
        for &b in &bounds[i + 1..] {
            out.push((a, b - 1));
        }
        for width in [8, 16, 32] {
            if a + width - 1 <= hi {
                out.push((a, a + width - 1));
            }
        }
    }
    let widened: Vec<(usize, usize)> = out
        .iter()
        .filter_map(|&(a, mut b)| {
            if a % 8 != 0 {
                return None;
            }
            while (b - a + 1) % 8 != 0 && b + 1 < seq.len() && rates[seq[b + 1]] == 0.0 {
                b += 1;
            }
            ((b - a + 1) % 8 == 0).then_some((a, b))
        })
        .collect();
    out.extend(widened);
    out.retain(|&(a, b)| b - a < 64);
    out
}

fn candidates(rates: &[f64], bits: usize) -> Vec<Range> {
    let mut out = Vec::new();
    for order in [ByteOrder::Intel, ByteOrder::Motorola] {
        let seq = significance(order, bits);
        let found = fields(rates, &seq);
        // The low bits of a value moving several steps a frame all change about half the time,
        // in no order, so they can split from the rest; neighbouring fields are tried together.
        let mut joined = found.clone();
        for (i, &(lo, _)) in found.iter().enumerate() {
            for later in 1..MAX_JOINED {
                let Some(&(_, hi)) = found.get(i + later) else {
                    break;
                };
                if found[i + later - 1].1 + 1 != found[i + later].0 {
                    break;
                }
                joined.push((lo, hi));
            }
        }
        for field in joined {
            for (lo, hi) in pieces(rates, &seq, field) {
                out.push(range_of(order, &seq, lo, hi));
            }
        }
    }
    for (bit, &rate) in rates.iter().enumerate().take(bits) {
        if rate > 0.0 && rate < TOGGLE_RATE {
            out.push(Range::intel(bit, 1));
        }
    }
    out.sort_by_key(|r| r.sort_key());
    out.dedup();
    out
}

fn classify(range: Range, p: &Profile, log: &Log) -> Option<Scored> {
    if p.changes == 0 && range.size > 1 {
        return None;
    }
    counter(range, p)
        .or_else(|| value(range, p))
        .or_else(|| enumeration(range, p))
        .or_else(|| flag(range, p, log))
}

/// Markers the range changes unusually often near.
fn markers_near<'h>(
    log: &Log,
    range: Range,
    change_rate: f64,
    markers: &'h [Marker],
) -> Vec<&'h Marker> {
    markers
        .iter()
        .filter(|m| {
            let near = log.frames.between(
                log.store,
                m.t_ns.saturating_sub(MARKER_WINDOW_NS),
                m.t_ns.saturating_add(MARKER_WINDOW_NS),
            );
            if near.len() < 2 {
                return false;
            }
            let values: Vec<u64> = near
                .clone()
                .map(|i| range.read(log.frames.data(log.store, i)))
                .collect();
            let changes = values.windows(2).filter(|w| w[0] != w[1]).count();
            let expected = change_rate * (near.len() - 1) as f64;
            changes >= 1 && changes as f64 >= 3.0 * expected + 0.5
        })
        .collect()
}

/// `x` rounded to three significant digits, or to a round factor such as 0.25 when it is
/// within 3% of one.
fn nice(x: f64) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return 0.0;
    }
    let magnitude = 10f64.powf(x.abs().log10().floor());
    let mantissa = x.abs() / magnitude;
    for round in [1.0, 2.0, 2.5, 5.0, 10.0] {
        if (mantissa - round).abs() / round < 0.03 {
            let text = format!("{:e}", round * magnitude);
            return x.signum() * text.parse::<f64>().unwrap_or(round * magnitude);
        }
    }
    format!("{x:.2e}").parse().unwrap_or(x)
}

fn fit(sample: &Sample, values: &[f64], reference: &Reference) -> Option<Fit> {
    let (mut n, mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, &v) in values.iter().enumerate() {
        let at = reference.t_ns.partition_point(|&t| t <= sample.ts[i]);
        let Some(&y) = at.checked_sub(1).and_then(|j| reference.values.get(j)) else {
            continue;
        };
        let x = v;
        n += 1.0;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }
    if n < 10.0 {
        return None;
    }
    let vx = sxx - sx * sx / n;
    let vy = syy - sy * sy / n;
    let cov = sxy - sx * sy / n;
    if vx <= 0.0 || vy <= 0.0 {
        return None;
    }
    let r = cov / (vx * vy).sqrt();
    let factor = nice(cov / vx);
    let offset = (sy - factor * sx) / n;
    // An offset under one step of the raw value is rounding in the reference, not a real offset.
    let offset = if offset.abs() <= factor.abs() {
        0.0
    } else {
        nice(offset)
    };
    Some(Fit { r, factor, offset })
}

fn sparkline(log: &Log, s: &Scored, fit: Option<Fit>) -> Vec<(i64, f64)> {
    let n = log.frames.list.len();
    if n == 0 {
        return Vec::new();
    }
    let points = SPARK_POINTS.min(n);
    let (factor, offset) = fit.map_or((1.0, 0.0), |f| (f.factor, f.offset));
    (0..points)
        .map(|k| {
            let i = if points == 1 {
                0
            } else {
                k * (n - 1) / (points - 1)
            };
            let frame = log.store.frame(log.frames.list[i] as usize);
            let raw = s.range.read(frame.data);
            let value = if s.kind == Kind::Float {
                f64::from(f32::from_bits(raw as u32))
            } else {
                read_as(raw, s.range.size, s.signed)
            };
            (frame.ts_ns, value * factor + offset)
        })
        .collect()
}

fn read_as(raw: u64, size: u16, signed: bool) -> f64 {
    if signed {
        bits::sign_extend(raw, size) as f64
    } else {
        raw as f64
    }
}

/// An unsigned value's range grown over the bits above it that are 0 in every frame and in no
/// `claimed` range, up to a nibble boundary, and on to a byte boundary when the value starts on
/// one: a value that never reaches its top bits in the log reads narrower than its field. A range
/// inside one byte is never grown past that byte, as either byte order would read it the same.
fn widened(range: Range, rates: &[f64], first: &[u8], claimed: &[u64]) -> Option<Range> {
    let size = usize::from(range.size);
    let start = usize::from(range.start_bit);
    let position = |bit: usize| bit / 8 * 8 + 7 - bit % 8;
    let (lsb, mut msb) = match range.byte_order {
        ByteOrder::Intel => (start, start + size - 1),
        ByteOrder::Motorola => (bit_at_msb_position(position(start) + size - 1), start),
    };
    if !lsb.is_multiple_of(4) {
        return None;
    }
    let one_byte = lsb / 8 == msb / 8;
    let mut goal = size.next_multiple_of(4);
    if lsb.is_multiple_of(8) {
        goal = goal.next_multiple_of(8);
    }
    let (mut width, mut best) = (size, None);
    while width < goal.min(64) {
        let next = match range.byte_order {
            ByteOrder::Intel => msb + 1,
            ByteOrder::Motorola => match position(msb).checked_sub(1) {
                Some(m) => bit_at_msb_position(m),
                None => break,
            },
        };
        let usable = next < rates.len()
            && rates[next] == 0.0
            && first[next / 8] >> (next % 8) & 1 == 0
            && claimed[next / 64] >> (next % 64) & 1 == 0
            && !(one_byte && next / 8 != lsb / 8);
        if !usable {
            break;
        }
        msb = next;
        width += 1;
        if width.is_multiple_of(4) {
            best = Some((width, msb));
        }
    }
    let (width, msb) = best?;
    Some(Range {
        start_bit: match range.byte_order {
            ByteOrder::Intel => range.start_bit,
            ByteOrder::Motorola => msb as u16,
        },
        size: width as u16,
        byte_order: range.byte_order,
    })
}

/// The reasons for unsigned values judged from a sample, with their ranges over the whole log.
fn whole_log_value_reasons(log: &Log, ranges: &[Range]) -> Vec<String> {
    let n = log.frames.list.len();
    let first = log.frames.data(log.store, 0);
    let mut limits: Vec<(u64, u64)> = ranges
        .iter()
        .map(|r| (r.read(first), r.read(first)))
        .collect();
    let mut rest = Vec::new();
    for (i, range) in ranges.iter().enumerate() {
        match log.rereads.positions(*range) {
            Some(positions) => {
                for p in positions {
                    let v = range.read(log.frames.data(log.store, p as usize));
                    limits[i] = (limits[i].0.min(v), limits[i].1.max(v));
                }
            }
            None => rest.push(i),
        }
    }
    // A value read on every few frames of a very long log still finds about its range.
    let stride = (n * rest.len()).div_ceil(VALUE_READS).max(1);
    for position in (0..n).step_by(stride) {
        let data = log.frames.data(log.store, position);
        for &i in &rest {
            let v = ranges[i].read(data);
            limits[i] = (limits[i].0.min(v), limits[i].1.max(v));
        }
    }
    limits
        .into_iter()
        .map(|(min, max)| format!("Changes smoothly from {min} to {max}"))
        .collect()
}

/// Suggested signals for one ID, best first. Bits past [`MAX_PAYLOAD`], and past the length that
/// almost every data frame of the ID carries, are not looked at. Deterministic: the same log and
/// hints give the same suggestions.
#[must_use]
pub fn suggest(store: &FrameStore, stats: &IdStats, hints: &Hints) -> Findings {
    let frames = Frames::new(store, stats);
    let len = frames.len;
    let markers = &hints.markers[..hints.markers.len().min(MAX_MARKERS)];
    let around: Vec<usize> = markers
        .iter()
        .map(|m| frames.between(store, m.t_ns, i64::MAX).start)
        .filter(|&at| at < frames.list.len())
        .collect();
    let sample = Sample::new(store, &frames, &around);
    let steps = frames.steps();
    if len == 0 || sample.steps() == 0 {
        return Findings {
            suggestions: Vec::new(),
            sampled_frames: sample.len(),
        };
    }
    let bits = len * 8;
    let rates: Vec<f64> = (0..bits)
        .map(|b| f64::from(frames.flips.get(b).copied().unwrap_or(0)) / steps as f64)
        .collect();
    let rereads = Rereads::new(store, &frames, &sample, &rates);
    let log = Log {
        store,
        frames: &frames,
        sample: &sample,
        rates: &rates,
        rereads: &rereads,
    };

    let mut scored = checksums(&sample, len, &rates);
    for range in candidates(&rates, bits) {
        let rarely_changes = range.size > 1 && range.bits().iter().all(|&b| rates[b] < FLAG_RATE);
        let profile = rarely_changes
            .then(|| rereads.profile(store, &frames, range))
            .flatten()
            .unwrap_or_else(|| Profile::new(&sample, range));
        let Some(mut s) = classify(range, &profile, &log) else {
            continue;
        };
        let near = markers_near(&log, range, profile.change_rate(), markers);
        if !near.is_empty() {
            s.score += (0.15 * near.len() as f64).min(0.25);
            let labels: Vec<&str> = near.iter().map(|m| m.label.as_str()).collect();
            s.reason += &format!("; changes near your marker at {}", labels.join(", "));
        }
        scored.push(s);
    }

    // Cells of a multiplexed message take turns with the selector, which read frame to frame
    // can pass for toggles and values; nothing is suggested in them. A byte is a cell when many
    // of its bits change with the page; elsewhere each candidate is judged on its own, apart from
    // counters: a heartbeat bit, or a second counter whose period divides the pages, moves the
    // same way.
    if let Some((selector, pages)) = selector(&scored, &sample) {
        let selector_mask = selector.mask();
        let overlaps = |a: &[u64], b: &[u64]| a.iter().zip(b).any(|(x, y)| x & y != 0);
        let mut cells = [0u64; MAX_PAYLOAD / 8];
        for byte in 0..len {
            let mask = Range::intel(byte * 8, 8).mask();
            if !overlaps(&mask, &selector_mask)
                && changed_bits_per_step(&sample, byte) > 1.5
                && changes_with_the_page(&sample, Range::intel(byte * 8, 8), pages)
            {
                for (c, m) in cells.iter_mut().zip(mask) {
                    *c |= m;
                }
            }
        }
        scored.retain(|s| {
            let mask = s.range.mask();
            s.kind == Kind::Checksum
                || overlaps(&mask, &selector_mask)
                || (!overlaps(&mask, &cells)
                    && (s.kind == Kind::Counter || !changes_with_the_page(&sample, s.range, pages)))
        });
    }

    let mut fits: Vec<Option<Fit>> = scored
        .iter()
        .map(|s| {
            let reference = hints.reference.as_ref()?;
            if !matches!(s.kind, Kind::Continuous | Kind::Signed) {
                return None;
            }
            let values = interpret(
                &Profile::new(&sample, s.range).values,
                s.range.size,
                s.signed,
            );
            fit(&sample, &values, reference).filter(|f| f.r.abs() >= 0.8)
        })
        .collect();
    if let Some(reference) = &hints.reference {
        for (s, f) in scored.iter_mut().zip(&fits) {
            if let Some(f) = f {
                s.score += 0.05 + 0.1 * (f.r.abs() - 0.8) / 0.2;
                let marker_note = s
                    .reason
                    .find("; changes near")
                    .map_or("", |at| &s.reason[at..]);
                s.reason = format!(
                    "Tracks {} (r = {:.2}); scale {} fitted, check it{marker_note}",
                    reference.name, f.r, f.factor
                );
            }
        }
    }
    let mut order: Vec<usize> = (0..scored.len()).collect();
    order.sort_by(|&a, &b| {
        let (a, b) = (&scored[a], &scored[b]);
        b.score
            .total_cmp(&a.score)
            .then(a.range.sort_key().cmp(&b.range.sort_key()))
    });
    let masks: Vec<[u64; MAX_PAYLOAD / 8]> = scored.iter().map(|s| s.range.mask()).collect();
    let overlaps = |a: &[u64], b: &[u64]| a.iter().zip(b).any(|(x, y)| x & y != 0);
    // The counters and checksums that will be suggested, best first.
    let mut kept: Vec<[u64; MAX_PAYLOAD / 8]> = Vec::new();
    for &i in &order {
        let s = &scored[i];
        if s.score >= MIN_SCORE
            && !s.unconfirmed
            && matches!(s.kind, Kind::Counter | Kind::Checksum)
            && !kept.iter().any(|k| overlaps(k, &masks[i]))
        {
            kept.push(masks[i]);
        }
    }
    let (mut taken, mut floats) = float_words(&sample, len, &kept);
    let inside = |a: &[u64], b: &[u64]| a.iter().zip(b).all(|(x, y)| x & !y == 0);
    let cap = MAX_SUGGESTIONS.max(len);
    let mut chosen = Vec::new();
    // The float words, best first, that don't overlap one another.
    floats.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.range.sort_key().cmp(&b.range.sort_key()))
    });
    let mut float_bits = [0u64; MAX_PAYLOAD / 8];
    for f in floats {
        let mask = f.range.mask();
        if f.score < MIN_SCORE || overlaps(&mask, &float_bits) || chosen.len() == cap {
            continue;
        }
        for (t, m) in float_bits.iter_mut().zip(mask) {
            *t |= m;
        }
        chosen.push(scored.len());
        scored.push(f);
        fits.push(None);
    }
    for (rank, &i) in order.iter().enumerate() {
        let s = &scored[i];
        let mask = &masks[i];
        if s.score < MIN_SCORE || overlaps(mask, &taken) {
            continue;
        }
        // Two ranges side by side beat one that straddles them: a candidate gives way to a
        // range inside it when both that range and a neighbour it overlaps score about as well.
        let close: Vec<usize> = order[rank + 1..]
            .iter()
            .copied()
            .take_while(|&j| scored[j].score >= s.score - CLOSE_SCORE)
            .filter(|&j| scored[j].score >= MIN_SCORE && !overlaps(&masks[j], &taken))
            .collect();
        let gives_way = close.iter().any(|&b| {
            overlaps(&masks[b], mask)
                && !inside(&masks[b], mask)
                && close
                    .iter()
                    .any(|&a| inside(&masks[a], mask) && !overlaps(&masks[a], &masks[b]))
        });
        if gives_way
            || (s.kind == Kind::Flag
                && flag_moves_with_a_neighbour(&log, usize::from(s.range.start_bit)))
        {
            continue;
        }
        for (t, m) in taken.iter_mut().zip(mask) {
            *t |= *m;
        }
        chosen.push(i);
        if chosen.len() == cap {
            break;
        }
    }

    chosen.sort_by(|&a, &b| scored[b].score.total_cmp(&scored[a].score));
    let from_sample: Vec<usize> = chosen
        .iter()
        .copied()
        .filter(|&i| scored[i].kind == Kind::Continuous && fits[i].is_none() && sample.partial)
        .collect();
    let ranges: Vec<Range> = from_sample.iter().map(|&i| scored[i].range).collect();
    for (i, reason) in from_sample
        .into_iter()
        .zip(whole_log_value_reasons(&log, &ranges))
    {
        let marker_note = scored[i]
            .reason
            .find("; changes near")
            .map_or(String::new(), |at| scored[i].reason[at..].to_string());
        scored[i].reason = reason + &marker_note;
    }
    let first = frames.data(store, 0);
    for &i in &chosen {
        if scored[i].kind != Kind::Continuous {
            continue;
        }
        let mut claimed = [0u64; MAX_PAYLOAD / 8];
        for &j in chosen.iter().filter(|&&j| j != i) {
            for (c, m) in claimed.iter_mut().zip(scored[j].range.mask()) {
                *c |= m;
            }
        }
        if let Some(range) = widened(scored[i].range, &rates, first, &claimed) {
            let added = range.size - scored[i].range.size;
            scored[i].range = range;
            scored[i].reason += &if added == 1 {
                "; width inferred: its top bit is 0 throughout".to_string()
            } else {
                format!("; width inferred: its top {added} bits are 0 throughout")
            };
        }
    }
    let suggestions = chosen
        .into_iter()
        .map(|i| {
            let s = &scored[i];
            let fit = fits[i].take();
            let reason = if s.kind == Kind::Flag {
                let marker_note = s
                    .reason
                    .find("; changes near")
                    .map_or("", |at| &s.reason[at..]);
                let flips = frames.flips[usize::from(s.range.start_bit)];
                flag_reason(flips, steps, set_share(&log, s.range)) + marker_note
            } else {
                s.reason.clone()
            };
            Suggestion {
                kind: s.kind,
                range: s.range,
                signed: s.signed,
                score: s.score.clamp(0.0, 0.99),
                reason,
                unconfirmed: s.unconfirmed,
                fit,
                spark: sparkline(&log, s, fit),
            }
        })
        .collect();
    Findings {
        suggestions,
        sampled_frames: sample.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use can_core::{id_key, FrameRef, FrameSink};
    use std::f64::consts::TAU;

    const MS: i64 = 1_000_000;

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    /// `n` frames of ID 0x100 at 100 Hz, each from `payload(i, rng)`.
    fn store(n: usize, payload: impl Fn(usize, &mut Rng) -> [u8; 8]) -> FrameStore {
        store_of(n, |i, rng| (0, payload(i, rng).to_vec()))
    }

    /// Like [`store`], with each frame's flags and a payload of any length.
    fn store_of(n: usize, frame: impl Fn(usize, &mut Rng) -> (u8, Vec<u8>)) -> FrameStore {
        let mut store = FrameStore::new();
        let mut rng = Rng(0x2545_F491_4F6C_DD1D);
        for i in 0..n {
            let (flags, data) = frame(i, &mut rng);
            store.push(FrameRef {
                ts_ns: i as i64 * 10 * MS,
                channel: 0,
                id: 0x100,
                flags,
                data: &data,
            });
        }
        store
    }

    /// Eight bytes holding `fields`, each `(start bit, size, raw value)` in little-endian order.
    fn intel(fields: &[(u32, u32, i64)]) -> [u8; 8] {
        let mut word = 0u64;
        for &(start, size, raw) in fields {
            word |= (raw as u64 & ((1 << size) - 1)) << start;
        }
        word.to_le_bytes()
    }

    fn run(store: &FrameStore, hints: &Hints) -> Vec<Suggestion> {
        suggest(store, store.id_stats(id_key(0, 0x100)).unwrap(), hints).suggestions
    }

    fn found(store: &FrameStore) -> Vec<(Kind, u16, u16, ByteOrder, bool)> {
        run(store, &Hints::default())
            .iter()
            .map(|s| {
                (
                    s.kind,
                    s.range.start_bit,
                    s.range.size,
                    s.range.byte_order,
                    s.signed,
                )
            })
            .collect()
    }

    /// A slow wave from 0 to 1 and back over about a minute.
    fn wave(i: usize) -> f64 {
        0.5 - 0.5 * (TAU * i as f64 / 6000.0).cos()
    }

    #[test]
    fn finds_a_counter_and_its_wrap() {
        let s = store(3000, |i, _| [i as u8, 0, 0, 0, 0, 0, 0, 0]);
        let all = run(&s, &Hints::default());
        assert_eq!(all.len(), 1, "{all:?}");
        assert_eq!(
            (all[0].kind, all[0].range),
            (Kind::Counter, Range::intel(0, 8))
        );
        assert_eq!(all[0].reason, "Increments by 1 each frame; wraps at 255");
        assert!(all[0].score > 0.95);

        // A nibble counter in the high half of byte 1 stays four bits wide.
        let s = store(3000, |i, _| [0, (i % 16) as u8 * 16, 0, 0, 0, 0, 0, 0]);
        let all = run(&s, &Hints::default());
        assert_eq!(
            (all[0].kind, all[0].range),
            (Kind::Counter, Range::intel(12, 4))
        );
        assert_eq!(all[0].reason, "Increments by 1 each frame; wraps at 15");
    }

    #[test]
    fn finds_a_crc8_sae_j1850_checksum() {
        let j1850 = |bytes: &[u8]| {
            let mut crc = 0xFFu8;
            for &b in bytes {
                crc ^= b;
                for _ in 0..8 {
                    crc = if crc & 0x80 != 0 {
                        (crc << 1) ^ 0x1D
                    } else {
                        crc << 1
                    };
                }
            }
            crc ^ 0xFF
        };
        let frame = move |i: usize, rng: &mut Rng| {
            let mut d = [(i % 16) as u8, rng.next() as u8, 0x40, 0, 0, 0, 0, 0];
            d[7] = j1850(&d[..7]);
            d
        };
        let s = store(2000, frame);
        let all = run(&s, &Hints::default());
        let checksum = all.iter().find(|s| s.kind == Kind::Checksum).unwrap();
        assert_eq!(checksum.range, Range::intel(56, 8));
        assert_eq!(checksum.reason, "Matches CRC-8 SAE J1850 over bytes 0-6");
        assert!(!checksum.unconfirmed && checksum.score > 0.95);

        // Corrupted on one frame in twenty, the rule holds on 95%: still a guess, unconfirmed.
        let s = store(2000, move |i, rng| {
            let mut d = frame(i, rng);
            if i % 20 == 0 {
                d[7] ^= 0x5A;
            }
            d
        });
        let checksum = run(&s, &Hints::default())
            .into_iter()
            .find(|s| s.kind == Kind::Checksum)
            .unwrap();
        assert!(checksum.unconfirmed);
        assert!(
            checksum
                .reason
                .contains("on 95% of frames; checksum rule unconfirmed"),
            "{}",
            checksum.reason
        );
        assert!(checksum.score < 0.85);
    }

    #[test]
    fn finds_flags_and_enums() {
        // Bit 9 switches every 7 s; bits 16-17 step through 0, 1, 2, 3 every 3 s.
        let s = store(6000, |i, _| {
            let door = u8::from((i / 700) % 2 == 1) << 1;
            let gear = ((i / 300) % 4) as u8;
            [0, door, gear, 0, 0, 0, 0, 0]
        });
        let all = run(&s, &Hints::default());
        let flag = all.iter().find(|s| s.kind == Kind::Flag).unwrap();
        assert_eq!(flag.range, Range::intel(9, 1));
        assert_eq!(flag.reason, "Switches 8 times; set 47% of the time");
        let gear = all.iter().find(|s| s.kind == Kind::Enum).unwrap();
        assert_eq!(gear.range, Range::intel(16, 2));
        assert_eq!(gear.reason, "Takes 4 distinct values: 0, 1, 2, 3");
        assert_eq!(all.len(), 2, "{all:?}");
    }

    #[test]
    fn finds_continuous_values_in_either_byte_order() {
        // A big-endian value in bytes 2-3 and a little-endian one in bytes 4-5.
        let s = store(6000, |i, _| {
            let big = ((wave(i) * 12_000.0) as u16).to_be_bytes();
            let little = ((wave(i + 1500) * 40_000.0) as u16).to_le_bytes();
            [0, 0, big[0], big[1], little[0], little[1], 0, 0]
        });
        let mut all = found(&s);
        all.sort_by_key(|f| f.1);
        assert_eq!(
            all,
            [
                (Kind::Continuous, 23, 16, ByteOrder::Motorola, false),
                (Kind::Continuous, 32, 16, ByteOrder::Intel, false),
            ]
        );
    }

    #[test]
    fn finds_signed_values_that_cross_zero() {
        let s = store(6000, |i, _| {
            let v = ((TAU * i as f64 / 3000.0).sin() * 900.0) as i16;
            let b = v.to_le_bytes();
            [b[0], b[1], 0, 0, 0, 0, 0, 0]
        });
        let all = run(&s, &Hints::default());
        assert_eq!(all.len(), 1, "{all:?}");
        assert_eq!(
            (all[0].kind, all[0].range, all[0].signed),
            (Kind::Signed, Range::intel(0, 16), true)
        );
        assert_eq!(all[0].reason, "Crosses zero with smooth changes");
    }

    #[test]
    fn noise_and_constant_bytes_give_nothing() {
        // A noise byte beside a slow byte reads smoothly as one big-endian value; it is still noise.
        let s = store(6000, |i, rng| {
            [
                0xAA,
                0,
                (wave(i) * 20.0) as u8,
                rng.next() as u8,
                0x55,
                0,
                0,
                0,
            ]
        });
        assert_eq!(
            found(&s),
            [(Kind::Continuous, 16, 8, ByteOrder::Intel, false)]
        );
        assert!(found(&store(500, |_, _| *b"1G1RC6E4")).is_empty());
        assert!(found(&store(1, |_, _| [1; 8])).is_empty());
    }

    #[test]
    fn two_values_side_by_side_stay_apart() {
        // Two signed big-endian values in bytes 0-1 and 2-3 read smoothly as one 32-bit value.
        let s = store(6000, |i, _| {
            let angle = ((wave(i) - 0.5) * 9000.0) as i16;
            let rate = ((TAU * i as f64 / 700.0).sin() * 3000.0) as i16;
            let (a, r) = (angle.to_be_bytes(), rate.to_be_bytes());
            [a[0], a[1], r[0], r[1], 0, 0, 0, 0]
        });
        assert_eq!(
            found(&s),
            [
                (Kind::Signed, 7, 16, ByteOrder::Motorola, true),
                (Kind::Signed, 23, 16, ByteOrder::Motorola, true),
            ]
        );
    }

    #[test]
    fn finds_floats_in_either_byte_order() {
        let s = store(6000, |i, _| {
            let f = ((wave(i) - 0.5) * 24.0) as f32;
            let b = f.to_le_bytes();
            [b[0], b[1], b[2], b[3], 0, 0, 0, 0]
        });
        let all = run(&s, &Hints::default());
        assert_eq!(
            found(&s),
            [(Kind::Float, 0, 32, ByteOrder::Intel, false)],
            "{all:?}"
        );
        assert_eq!(
            all[0].reason,
            "Reads as a 32-bit float changing smoothly from -12 to 12"
        );
        let (_, last) = all[0].spark.last().copied().unwrap();
        assert!((last - f64::from(((wave(5999) - 0.5) * 24.0) as f32)).abs() < 1e-6);

        // Beside a counter, in either byte order, and within one binade.
        let with_counter = |at: usize, float: &dyn Fn(usize) -> [u8; 4], range: Range| {
            let s = store(6000, |i, _| {
                let mut d = [0u8; 8];
                d[at..at + 4].copy_from_slice(&float(i));
                d[if at == 0 { 4 } else { 0 }] = i as u8;
                d
            });
            let all = run(&s, &Hints::default());
            let kinds: Vec<(Kind, Range)> = all.iter().map(|s| (s.kind, s.range)).collect();
            assert_eq!(kinds.len(), 2, "{all:?}");
            assert_eq!(kinds[0].0, Kind::Counter, "{all:?}");
            assert_eq!(kinds[1], (Kind::Float, range), "{all:?}");
        };
        let motorola = Range {
            start_bit: 39,
            size: 32,
            byte_order: ByteOrder::Motorola,
        };
        with_counter(
            0,
            &|i| ((20.0 + wave(i) * 60.0) as f32).to_le_bytes(),
            Range::intel(0, 32),
        );
        with_counter(
            4,
            &|i| ((100.0 + wave(i) * 100.0) as f32).to_be_bytes(),
            motorola,
        );
        with_counter(
            0,
            &|i| ((12.0 + wave(i) * 3.5) as f32).to_le_bytes(),
            Range::intel(0, 32),
        );
        with_counter(
            4,
            &|i| ((3.3 + wave(i) * 0.6) as f32).to_be_bytes(),
            motorola,
        );
    }

    #[test]
    fn integers_that_read_as_floats_are_not_suggested_as_floats() {
        // A value whose high byte falls in a float's exponent range, over two bytes of noise:
        // as a float it sweeps many decades, which no reading does.
        let s = store(6000, |i, rng| {
            let b = ((14000.0 + wave(i) * 4000.0) as u16).to_le_bytes();
            [
                rng.next() as u8,
                rng.next() as u8,
                b[0],
                b[1],
                i as u8,
                0,
                0,
                0,
            ]
        });
        assert!(run(&s, &Hints::default())
            .iter()
            .all(|s| s.kind != Kind::Float));
        // The same value beside a second one, which would carry into it as one number.
        let s = store(6000, |i, _| {
            let a = ((wave(i + 1000) * 60000.0) as u16).to_le_bytes();
            let b = ((14000.0 + wave(i) * 4000.0) as u16).to_le_bytes();
            [a[0], a[1], b[0], b[1], i as u8, 0, 0, 0]
        });
        assert!(run(&s, &Hints::default())
            .iter()
            .all(|s| s.kind != Kind::Float));
    }

    #[test]
    fn a_constant_byte_ahead_of_separate_values_is_no_float() {
        let s = store(6000, |i, _| {
            [
                0x42,
                (wave(i) * 120.0) as u8,
                (wave(i + 1500) * 200.0) as u8,
                (wave(i + 4000) * 180.0) as u8,
                0,
                0,
                0,
                0,
            ]
        });
        let mut starts: Vec<u16> = found(&s).iter().map(|f| f.1).collect();
        starts.sort_unstable();
        assert_eq!(starts, [8, 16, 24], "{:?}", found(&s));
    }

    #[test]
    fn a_marker_raises_what_changes_near_it() {
        // Bit 0 switches on at 12 s and off at 14 s; bit 8 at 30 s and 32 s.
        let s = store(6000, |i, _| {
            let brake = u8::from((1200..1400).contains(&i));
            let other = u8::from((3000..3200).contains(&i));
            [brake, other, 0, 0, 0, 0, 0, 0]
        });
        let plain = run(&s, &Hints::default());
        let hints = Hints {
            markers: vec![Marker {
                t_ns: 12_000 * MS,
                label: "12 s".into(),
            }],
            reference: None,
        };
        let hinted = run(&s, &hints);
        let score = |all: &[Suggestion], bit: u16| {
            all.iter().find(|s| s.range.start_bit == bit).unwrap().score
        };
        assert_eq!(score(&plain, 0), score(&plain, 8));
        assert!(score(&hinted, 0) > score(&plain, 0));
        assert_eq!(score(&hinted, 8), score(&plain, 8));
        assert_eq!(hinted[0].range.start_bit, 0);
        assert!(
            hinted[0]
                .reason
                .ends_with("; changes near your marker at 12 s"),
            "{}",
            hinted[0].reason
        );
    }

    #[test]
    fn a_reference_fits_a_scale() {
        let speed = |i: usize| wave(i) * 120.0;
        let s = store(6000, move |i, _| {
            let raw = ((speed(i) * 100.0) as u16).to_be_bytes();
            [raw[0], raw[1], (i % 256) as u8, 0, 0, 0, 0, 0]
        });
        let reference = Reference {
            name: "VehicleSpeed".into(),
            t_ns: (0..6000).map(|i| i as i64 * 10 * MS + 3 * MS).collect(),
            values: (0..6000).map(speed).collect(),
        };
        let all = run(
            &s,
            &Hints {
                markers: Vec::new(),
                reference: Some(reference),
            },
        );
        assert_eq!(
            all[0].range,
            Range {
                start_bit: 7,
                size: 16,
                byte_order: ByteOrder::Motorola
            }
        );
        let fit = all[0].fit.unwrap();
        assert_eq!((fit.factor, fit.offset), (0.01, 0.0));
        assert!(fit.r > 0.999);
        assert!(
            all[0]
                .reason
                .starts_with("Tracks VehicleSpeed (r = 1.00); scale 0.01"),
            "{}",
            all[0].reason
        );
        let (t, v) = all[0].spark.last().copied().unwrap();
        assert_eq!(t, 5999 * 10 * MS);
        assert!((v - speed(5999)).abs() < 0.02, "{v}");
        assert!(all.iter().skip(1).all(|s| s.fit.is_none()));
    }

    #[test]
    fn long_logs_are_sampled_and_stay_deterministic() {
        let s = store(200_000, |i, rng| {
            let v = ((wave(i % 6000) * 3000.0) as u16).to_le_bytes();
            [i as u8, v[0], v[1], rng.next() as u8 & 0x80, 0, 0, 0, 0]
        });
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        let first = suggest(&s, stats, &Hints::default());
        assert_eq!(first.sampled_frames, SAMPLE_FRAMES);
        let again = suggest(&s, stats, &Hints::default());
        assert_eq!(first.suggestions, again.suggestions);
        let kinds: Vec<(Kind, Range)> = first
            .suggestions
            .iter()
            .map(|s| (s.kind, s.range))
            .collect();
        assert_eq!(
            kinds,
            [
                (Kind::Counter, Range::intel(0, 8)),
                (Kind::Continuous, Range::intel(8, 16))
            ]
        );
        assert_eq!(first.suggestions[0].spark.len(), SPARK_POINTS);
    }

    #[test]
    fn ranges_and_byte_lists_follow_dbc_numbering() {
        let motorola = Range {
            start_bit: 23,
            size: 16,
            byte_order: ByteOrder::Motorola,
        };
        let mut bits = motorola.bits();
        bits.sort_unstable();
        assert_eq!(bits, (16..32).collect::<Vec<_>>());
        assert_eq!(significance(ByteOrder::Motorola, 16)[..3], [8, 9, 10]);
        assert_eq!(significance(ByteOrder::Motorola, 16)[15], 7);
        assert_eq!(byte_list(8, 7), "0-6");
        assert_eq!(byte_list(8, 0), "1-7");
        assert_eq!(byte_list(8, 3), "0-2, 4-7");
        assert_eq!(nice(0.010_04), 0.01);
        assert_eq!(nice(-0.2507), -0.25);
        assert_eq!(nice(0.123_45), 0.123);
    }

    #[test]
    fn signed_values_with_constant_bits_above_stay_narrow() {
        // 12 and 10 bits wide, each with never-set bits above it up to the next byte.
        let s = store(6000, |i, _| {
            let a = ((TAU * i as f64 / 3000.0).sin() * 1500.0) as i64;
            let c = ((TAU * i as f64 / 1100.0).sin() * 400.0) as i64;
            intel(&[(16, 12, a), (48, 10, c)])
        });
        let mut all = found(&s);
        all.sort_by_key(|f| f.1);
        assert_eq!(
            all,
            [
                (Kind::Signed, 16, 12, ByteOrder::Intel, true),
                (Kind::Signed, 48, 10, ByteOrder::Intel, true),
            ]
        );
    }

    #[test]
    fn unsigned_values_that_never_reach_their_top_bits_widen_to_their_field() {
        // Values using 11 bits of 4|12 and 10 of 32|16, and a whole byte at 56.
        let s = store(6000, |i, _| {
            let speed = (wave(i) * 1100.0) as i64;
            let level = (wave(i + 1500) * 1000.0) as i64;
            let byte = (wave(i + 700) * 200.0) as i64;
            intel(&[(0, 4, 3), (4, 12, speed), (32, 16, level), (56, 8, byte)])
        });
        let all = run(&s, &Hints::default());
        let mut ranges: Vec<(Kind, Range)> = all.iter().map(|s| (s.kind, s.range)).collect();
        ranges.sort_by_key(|r| r.1.sort_key());
        assert_eq!(
            ranges,
            [
                (Kind::Continuous, Range::intel(4, 12)),
                (Kind::Continuous, Range::intel(32, 16)),
                (Kind::Continuous, Range::intel(56, 8)),
            ]
        );
        let reason = |start: u16| {
            &all.iter()
                .find(|s| s.range.start_bit == start)
                .unwrap()
                .reason
        };
        assert!(reason(4).ends_with("; width inferred: its top bit is 0 throughout"));
        assert!(!reason(56).contains("width inferred"));

        // Big-endian: 11 bits used of 7|12@0, whose low nibble is the high half of byte 1.
        let s = store(6000, |i, _| {
            let speed = (wave(i) * 1100.0) as u16;
            [(speed >> 4) as u8, (speed << 4) as u8, 0, 0, 0, 0, 0, 0]
        });
        let all = run(&s, &Hints::default());
        assert_eq!(
            all.iter().map(|s| (s.kind, s.range)).collect::<Vec<_>>(),
            [(
                Kind::Continuous,
                Range {
                    start_bit: 7,
                    size: 12,
                    byte_order: ByteOrder::Motorola
                }
            )]
        );
        assert!(all[0].reason.ends_with("its top bit is 0 throughout"));
    }

    #[test]
    fn a_constant_byte_ahead_of_changing_ones_is_no_float() {
        let s = store(6000, |i, _| {
            let slow = (wave(i) * 200.0) as u8;
            [
                0x42,
                i as u8,
                slow,
                (wave(i + 2000) * 180.0) as u8,
                0,
                0,
                0,
                0,
            ]
        });
        let mut all = found(&s);
        all.sort_by_key(|f| f.1);
        assert_eq!(
            all,
            [
                (Kind::Counter, 8, 8, ByteOrder::Intel, false),
                (Kind::Continuous, 16, 8, ByteOrder::Intel, false),
                (Kind::Continuous, 24, 8, ByteOrder::Intel, false),
            ]
        );

        // 0x44 heading a mode, a counter and a slow value: one exponent, so no float.
        let s = store(6000, |i, _| {
            let mode = [0, 1, 2, 0][i * 4 / 6000];
            [
                0x11,
                0x22,
                0x33,
                0x44,
                mode,
                (i % 15) as u8,
                (wave(i) * 250.0) as u8,
                0,
            ]
        });
        let mut all = found(&s);
        all.sort_by_key(|f| f.1);
        let kinds: Vec<(Kind, u16, u16)> = all.iter().map(|f| (f.0, f.1, f.2)).collect();
        assert_eq!(
            kinds,
            [
                (Kind::Enum, 32, 2),
                (Kind::Counter, 40, 4),
                (Kind::Continuous, 48, 8)
            ]
        );
    }

    #[test]
    fn neighbouring_flags_stay_apart_and_toggles_are_found() {
        // Doors in bits 0 and 1, flags either side of a byte boundary in bits 7 and 8, and a
        // blinker in bit 16 that toggles every 5 frames through the second half of the log.
        let s = store(6000, |i, _| {
            let left = u8::from((i / 410) % 2 == 1);
            let right = u8::from((i / 730) % 3 == 1);
            let seven = u8::from((i / 550) % 2 == 1);
            let eight = u8::from((i / 650) % 2 == 1);
            let blinker = u8::from(i >= 3000 && (i / 5) % 2 == 1);
            [
                left | right << 1 | seven << 7,
                eight,
                blinker,
                i as u8,
                0,
                0,
                0,
                0,
            ]
        });
        let all = run(&s, &Hints::default());
        let mut flags: Vec<u16> = all
            .iter()
            .filter(|s| s.kind == Kind::Flag)
            .map(|s| s.range.start_bit)
            .collect();
        flags.sort_unstable();
        assert_eq!(flags, [0, 1, 7, 8, 16], "{all:?}");
        assert!(all
            .iter()
            .all(|s| s.kind != Kind::Enum && s.range.size <= 8));
        let blinker = all.iter().find(|s| s.range.start_bit == 16).unwrap();
        assert_eq!(
            blinker.reason,
            "Toggles on 10% of frames; set 25% of the time"
        );
    }

    #[test]
    fn long_logs_do_not_overflow_the_listing_limit() {
        // 5M frames, past what SEEN_ENOUGH * n fits in a 32-bit usize.
        assert_eq!(most_changes_to_list(5_000_000, 20_000), 250_000);
        assert_eq!(most_changes_to_list(10, 0), 10_000);
    }

    #[test]
    fn bits_set_at_random_are_not_toggles() {
        // Each bit of byte 1 set on 10% of frames, independently.
        let s = store(6000, |i, rng| {
            let mut noise = 0u8;
            for bit in 0..8 {
                if rng.next() % 10 == 0 {
                    noise |= 1 << bit;
                }
            }
            [i as u8, noise, 0, 0, 0, 0, 0, 0]
        });
        let all = found(&s);
        assert_eq!(all, [(Kind::Counter, 0, 8, ByteOrder::Intel, false)]);
    }

    #[test]
    fn bits_carried_into_are_not_flags() {
        // A counter shifted up one bit, big-endian across the whole frame: its upper bits each
        // change rarely, but always with the bits below.
        let s = store(2000, |i, _| ((i as u64) << 1).to_be_bytes());
        let all = run(&s, &Hints::default());
        assert!(all.iter().all(|s| s.kind != Kind::Flag), "{all:?}");
    }

    #[test]
    fn short_events_in_long_logs_are_read_whole() {
        // A 2-bit state stepping 1, 3, 2 over 2 s of a 33-minute log, which the sample misses.
        let state = |i: usize| match i {
            100_000..100_070 => 1,
            100_070..100_140 => 3,
            100_140..100_200 => 2,
            _ => 0,
        };
        let s = store(200_000, move |i, _| [state(i), 0, i as u8, 0, 0, 0, 0, 0]);
        let all = run(&s, &Hints::default());
        let event = all.iter().find(|s| s.kind == Kind::Enum).unwrap();
        assert_eq!(event.range, Range::intel(0, 2));
        assert_eq!(event.reason, "Takes 4 distinct values: 0, 1, 2, 3");

        // A marker adds a block of frames around it to the sample.
        let stats = s.id_stats(id_key(0, 0x100)).unwrap();
        let hints = Hints {
            markers: vec![Marker {
                t_ns: 1_000_500 * MS,
                label: "1000.5 s".into(),
            }],
            reference: None,
        };
        let marked = suggest(&s, stats, &hints);
        assert_eq!(
            marked.sampled_frames,
            SAMPLE_FRAMES + SAMPLE_FRAMES / SAMPLE_BLOCKS
        );
        let event = marked
            .suggestions
            .iter()
            .find(|s| s.kind == Kind::Enum)
            .unwrap();
        assert!(
            event
                .reason
                .ends_with("; changes near your marker at 1000.5 s"),
            "{}",
            event.reason
        );
    }

    #[test]
    fn sampled_values_report_their_range_over_the_whole_log() {
        // A period equal to the spacing of evenly spread blocks would show each block the same
        // stretch of the wave.
        let period = (200_000.0 - 1000.0) / 19.0;
        let level = move |i: usize| ((0.5 - 0.5 * (TAU * i as f64 / period).cos()) * 1000.0) as u16;
        let s = store(200_000, move |i, _| {
            let v = level(i).to_le_bytes();
            [v[0], v[1], 0, 0, 0, 0, 0, 0]
        });
        let all = run(&s, &Hints::default());
        let (min, max) = (0..200_000)
            .map(level)
            .fold((u16::MAX, 0), |(lo, hi), v| (lo.min(v), hi.max(v)));
        assert_eq!(all[0].range, Range::intel(0, 16));
        assert_eq!(
            all[0].reason,
            format!("Changes smoothly from {min} to {max}")
        );
    }

    #[test]
    fn remote_and_short_frames_do_not_hide_bytes() {
        let s = store_of(2010, |i, _| {
            if i % 201 == 200 {
                return (can_core::flags::RTR, Vec::new());
            }
            let mut d = vec![i as u8, 0, 0, 0, 0, 0, (wave(i * 6) * 200.0) as u8, 0];
            if i % 100 == 50 {
                d.truncate(2);
            }
            (0, d)
        });
        let mut all = found(&s);
        all.sort_by_key(|f| f.1);
        let kinds: Vec<(Kind, u16, u16)> = all.iter().map(|f| (f.0, f.1, f.2)).collect();
        assert_eq!(kinds, [(Kind::Counter, 0, 8), (Kind::Continuous, 48, 8)]);
    }

    #[test]
    fn long_can_fd_payloads_get_more_suggestions() {
        let s = store_of(3000, |i, _| {
            let mut d = vec![0u8; 64];
            for k in 0..32 {
                let v = (wave(i * 2 + k * 150) * 20_000.0) as u16;
                d[2 * k..2 * k + 2].copy_from_slice(&v.to_le_bytes());
            }
            (can_core::flags::FD, d)
        });
        let all = found(&s);
        assert_eq!(all.len(), 32);
        assert!(all
            .iter()
            .all(|f| f.0 == Kind::Continuous && f.2 == 16 && f.1 % 16 == 0));
    }

    #[test]
    fn counters_that_count_down_and_multiplexer_selectors() {
        let s = store(3000, |i, _| [255 - i as u8, 0, 0, 0, 0, 0, 0, 0]);
        let all = run(&s, &Hints::default());
        assert_eq!(all[0].reason, "Decrements by 1 each frame; wraps at 255");

        // Page 0 to 3 in byte 0; each page's own value in bytes 1-2; a plain value in byte 3.
        let s = store(6000, |i, _| {
            let page = i % 4;
            let cell = [1000.0, 30_000.0, 500.0, 60_000.0][page] + wave(i * (page + 1)) * 900.0;
            let c = (cell as u16).to_le_bytes();
            [page as u8, c[0], c[1], (wave(i) * 100.0) as u8, 0, 0, 0, 0]
        });
        let all = run(&s, &Hints::default());
        assert_eq!(
            (all[0].kind, all[0].range),
            (Kind::Counter, Range::intel(0, 2))
        );
        assert_eq!(
            all[0].reason,
            "Increments by 1 each frame; wraps at 3: a counter or multiplexer selector"
        );
        let rest: Vec<Range> = all[1..].iter().map(|s| s.range).collect();
        assert_eq!(rest, [Range::intel(24, 8)]);

        // A 2-bit alive counter, with a heartbeat bit toggling each frame and a door flag in
        // another byte: neither is a cell, though the heartbeat repeats with the pages.
        let s = store(6000, |i, _| {
            let door = u8::from((i / 700) % 2 == 1);
            [
                (wave(i) * 200.0) as u8,
                0,
                (i % 2) as u8 | door << 1,
                ((i % 4) as u8) << 4,
                0,
                0,
                0,
                0,
            ]
        });
        let mut got: Vec<(Kind, Range)> = run(&s, &Hints::default())
            .iter()
            .map(|s| (s.kind, s.range))
            .collect();
        got.sort_by_key(|g| g.1.start_bit);
        assert_eq!(
            got,
            [
                (Kind::Continuous, Range::intel(0, 8)),
                (Kind::Counter, Range::intel(16, 1)),
                (Kind::Flag, Range::intel(17, 1)),
                (Kind::Counter, Range::intel(28, 2)),
            ]
        );
    }

    #[test]
    fn a_fit_keeps_the_marker_note_and_offsets_by_the_rounded_scale() {
        // A value that ramps from 0 to 1400 between 12 and 14 s and then holds.
        let raw = |i: usize| (i.clamp(1200, 1400) - 1200) as f64 * 7.0;
        let s = store(6000, move |i, _| {
            let v = (raw(i) as u16).to_le_bytes();
            [v[0], v[1], 0, 0, 0, 0, 0, 0]
        });
        let reference = Reference {
            name: "Ref".into(),
            t_ns: (0..6000).map(|i| i as i64 * 10 * MS).collect(),
            values: (0..6000).map(|i| raw(i) * 0.0101).collect(),
        };
        let hints = Hints {
            markers: vec![Marker {
                t_ns: 12_500 * MS,
                label: "12.5 s".into(),
            }],
            reference: Some(reference),
        };
        let all = run(&s, &hints);
        let fit = all[0].fit.unwrap();
        assert_eq!(fit.factor, 0.01);
        let mean_raw = (0..6000).map(raw).sum::<f64>() / 6000.0;
        assert!((fit.offset - 0.0001 * mean_raw).abs() < 0.01, "{fit:?}");
        assert!(all[0]
            .reason
            .starts_with("Tracks Ref (r = 1.00); scale 0.01"));
        assert!(
            all[0]
                .reason
                .ends_with("; changes near your marker at 12.5 s"),
            "{}",
            all[0].reason
        );
    }
}
