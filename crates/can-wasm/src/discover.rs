//! Suggested signals: proposes likely signals in one message from how its bits change. Every
//! suggestion is a guess for a person to check against the log, never a decode.
//!
//! The bits are first split into fields by their change rates: within a counter or a value each
//! more significant bit changes less often than the one below it, so a bit that changes more
//! often than its lower neighbour starts a new field. That is tried in both byte orders. Each
//! field, neighbouring fields joined, their pieces and their byte-aligned widths are then read
//! over a sample of frames and tested in turn as a counter, a signed or unsigned value or an
//! enum; single bits that change rarely are flags, and whole bytes are tested against checksum
//! rules. The best-scoring candidates that don't overlap are kept. Words that read as IEEE 754
//! floats get no suggestions, since a raw bit range can't describe them.

use can_core::{FrameStore, IdStats, MAX_PAYLOAD};
use can_dbc_model::{bits, ByteOrder};
use serde::Serialize;

use crate::checksum;

/// At most this many frames of an ID are read, in blocks of consecutive frames spread evenly
/// across the log, so a scan takes about as long for a long log as for a short one.
const SAMPLE_FRAMES: usize = 20_000;
const SAMPLE_BLOCKS: usize = 20;
const SPARK_POINTS: usize = 64;
/// Suggestions scoring below this are left out.
const MIN_SCORE: f64 = 0.35;
const MAX_SUGGESTIONS: usize = 16;
/// A single bit that changes on fewer than this share of frames can be a flag.
const FLAG_RATE: f64 = 0.05;
/// Within a field a bit changes at most this much more often than the bit below it.
const RATE_TOLERANCE: f64 = 1.25;
/// A drop in change rate this steep from one bit to the next may be a boundary between fields.
const CUT_RATIO: f64 = 3.0;
const MAX_CUTS: usize = 3;
/// At most this many neighbouring fields are joined into one candidate.
const MAX_JOINED: usize = 3;
/// A change within this long of an event marker counts as near it.
const MARKER_WINDOW_NS: i64 = 1_000_000_000;
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

    fn read(self, data: &[u8]) -> u64 {
        bits::extract(data, self.start_bit, self.size, self.byte_order).unwrap_or(0)
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

/// Frames read to score candidates, with whether each directly follows the one before it in the
/// log (false at the start of each block).
struct Sample<'a> {
    data: Vec<&'a [u8]>,
    ts: Vec<i64>,
    follows: Vec<bool>,
}

impl<'a> Sample<'a> {
    fn new(store: &'a FrameStore, frames: &[u32]) -> Self {
        let n = frames.len();
        let picks: Vec<(usize, bool)> = if n <= SAMPLE_FRAMES {
            (0..n).map(|i| (i, i > 0)).collect()
        } else {
            let block = SAMPLE_FRAMES / SAMPLE_BLOCKS;
            (0..SAMPLE_BLOCKS)
                .flat_map(|b| {
                    let start = b * (n - block) / (SAMPLE_BLOCKS - 1);
                    (0..block).map(move |k| (start + k, k > 0))
                })
                .collect()
        };
        let mut sample = Self {
            data: Vec::with_capacity(picks.len()),
            ts: Vec::with_capacity(picks.len()),
            follows: Vec::with_capacity(picks.len()),
        };
        for (i, follows) in picks {
            let frame = store.frame(frames[i] as usize);
            sample.data.push(frame.data);
            sample.ts.push(frame.ts_ns);
            sample.follows.push(follows);
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

/// A candidate's raw values over the sample, and how they move.
struct Profile {
    values: Vec<u64>,
    steps: usize,
    changes: usize,
    max: u64,
    distinct: usize,
}

impl Profile {
    fn new(sample: &Sample, range: Range) -> Self {
        let values: Vec<u64> = sample.data.iter().map(|d| range.read(d)).collect();
        let (mut steps, mut changes) = (0, 0);
        for i in 1..values.len() {
            if sample.follows[i] {
                steps += 1;
                changes += usize::from(values[i] != values[i - 1]);
            }
        }
        let mut sorted = values.clone();
        sorted.sort_unstable();
        sorted.dedup();
        Self {
            max: sorted.last().copied().unwrap_or(0),
            distinct: sorted.len(),
            values,
            steps,
            changes,
        }
    }

    fn change_rate(&self) -> f64 {
        self.changes as f64 / self.steps.max(1) as f64
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
    let (mut carries, mut consistent) = (0usize, 0usize);
    let (mut changes, mut small) = (0usize, 0usize);
    for i in 1..values.len() {
        if !follows[i] {
            continue;
        }
        let (before, after) = (values[i - 1], values[i]);
        let (low_before, low_after) = (before & low_mask, after & low_mask);
        if low_before != low_after {
            let up = low_after.wrapping_sub(low_before) & low_mask;
            let down = low_before.wrapping_sub(low_after) & low_mask;
            changes += 1;
            small += usize::from(up.min(down) <= small_step);
        }
        let (high_before, high_after) = (before >> split, after >> split);
        if high_after == high_before.wrapping_add(1) {
            carries += 1;
            consistent += usize::from(low_after < low_before);
        } else if high_before == high_after.wrapping_add(1) {
            carries += 1;
            consistent += usize::from(low_after > low_before);
        }
    }
    if carries >= 5 {
        consistent as f64 / carries as f64 >= 0.8
    } else {
        changes == 0 || small as f64 / changes as f64 >= 0.6
    }
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

fn counter(range: Range, p: &Profile, follows: &[bool]) -> Option<Scored> {
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
            let (step, share) = commonest_step(&p.values, follows, m);
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
    let reason = if range.size == 1 {
        score = score.min(0.7);
        "Toggles every frame".to_string()
    } else if top == 1 && share >= 0.995 {
        "Alternates between 0 and 1 each frame".to_string()
    } else if share >= 0.995 {
        format!("Increments by {step} each frame; wraps at {top}")
    } else {
        format!(
            "Increments by {step} on {} of frames; wraps at {top}",
            percent(share)
        )
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

/// Whether the range starts at bit 0 of a byte and covers whole bytes.
fn byte_aligned(range: Range) -> bool {
    let bits = range.bits();
    range.size.is_multiple_of(8) && bits.iter().min().is_some_and(|&b| b % 8 == 0)
}

fn value(range: Range, p: &Profile, follows: &[bool]) -> Option<Scored> {
    if range.size < 4 || p.distinct < 12 {
        return None;
    }
    let low_ok = (8..range.size)
        .step_by(8)
        .all(|split| low_bits_belong(&p.values, follows, split));
    let ok = |s: &Smoothness| low_ok && s.small >= 0.85 && s.wraps <= 0.02;
    let unsigned = smoothness(&interpret(&p.values, range.size, false), follows)?;
    let signed = smoothness(&interpret(&p.values, range.size, true), follows);
    let use_signed = signed.as_ref().is_some_and(|s| {
        ok(s)
            && s.min < 0.0
            && s.max > 0.0
            && (!ok(&unsigned) || s.wraps < unsigned.wraps || s.small > unsigned.small + 0.05)
    });
    let chosen = if use_signed {
        signed.expect("checked")
    } else if ok(&unsigned) {
        unsigned
    } else {
        return None;
    };
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

fn enumeration(range: Range, p: &Profile) -> Option<Scored> {
    let rate = p.change_rate();
    if range.size < 2 || !(2..=16).contains(&p.distinct) || rate > 0.2 || p.changes == 0 {
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

fn flag_reason(flips: u32, set: f64) -> String {
    format!(
        "Switches {}; set {} of the time",
        times(flips),
        percent(set)
    )
}

fn flag(range: Range, p: &Profile, flips: u32, steps: usize) -> Option<Scored> {
    let rate = f64::from(flips) / steps.max(1) as f64;
    if range.size != 1 || flips == 0 || rate >= FLAG_RATE {
        return None;
    }
    let set = p.values.iter().filter(|&&v| v != 0).count() as f64 / p.values.len().max(1) as f64;
    Some(Scored {
        kind: Kind::Flag,
        range,
        signed: false,
        score: 0.5 + 0.2 * (1.0 - rate / FLAG_RATE),
        reason: flag_reason(flips, set),
        unconfirmed: false,
    })
}

/// The share of all frames of the ID with the flag set; the sample can miss a short stretch.
fn whole_log_set_share(store: &FrameStore, stats: &IdStats, range: Range) -> f64 {
    let set = stats
        .frames
        .iter()
        .filter(|&&f| range.read(store.frame(f as usize).data) != 0)
        .count();
    set as f64 / stats.frames.len().max(1) as f64
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

/// Bits of 32-bit words that read as smoothly changing IEEE 754 floats. Nothing is suggested
/// inside them: a float is not a bit range these kinds describe, and its exponent bits would
/// otherwise look like flags.
fn float_words(sample: &Sample, len: usize) -> [u64; MAX_PAYLOAD / 8] {
    let mut taken = [0u64; MAX_PAYLOAD / 8];
    for byte in 0..len.saturating_sub(3) {
        for range in [
            Range::intel(byte * 8, 32),
            Range {
                start_bit: (byte * 8 + 7) as u16,
                size: 32,
                byte_order: ByteOrder::Motorola,
            },
        ] {
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
            let smooth = smoothness(&values, &sample.follows)
                .is_some_and(|s| s.small >= 0.85 && s.wraps <= 0.02);
            if distinct.len() >= 16 && smooth {
                for (t, m) in taken.iter_mut().zip(range.mask()) {
                    *t |= m;
                }
            }
        }
    }
    taken
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
        if rate > 0.0 && rate < FLAG_RATE {
            out.push(Range::intel(bit, 1));
        }
    }
    out.sort_by_key(|r| r.sort_key());
    out.dedup();
    out
}

fn classify(
    range: Range,
    p: &Profile,
    sample: &Sample,
    stats: &IdStats,
    steps: usize,
) -> Option<Scored> {
    if p.changes == 0 && range.size > 1 {
        return None;
    }
    counter(range, p, &sample.follows)
        .or_else(|| value(range, p, &sample.follows))
        .or_else(|| enumeration(range, p))
        .or_else(|| {
            let flips = stats
                .bit_flips
                .get(usize::from(range.start_bit))
                .copied()
                .unwrap_or(0);
            flag(range, p, flips, steps)
        })
}

/// Markers the range changes unusually often near.
fn markers_near<'h>(
    store: &FrameStore,
    stats: &IdStats,
    range: Range,
    change_rate: f64,
    markers: &'h [Marker],
) -> Vec<&'h Marker> {
    markers
        .iter()
        .filter(|m| {
            let near = store.id_frames_between(
                stats,
                m.t_ns.saturating_sub(MARKER_WINDOW_NS),
                m.t_ns.saturating_add(MARKER_WINDOW_NS),
            );
            let frames = &stats.frames[near];
            if frames.len() < 2 {
                return false;
            }
            let changes = frames
                .windows(2)
                .filter(|w| {
                    range.read(store.frame(w[0] as usize).data)
                        != range.read(store.frame(w[1] as usize).data)
                })
                .count();
            let expected = change_rate * (frames.len() - 1) as f64;
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
    let factor = cov / vx;
    let offset = (sy - factor * sx) / n;
    let factor = nice(factor);
    // An offset under one step of the raw value is rounding in the reference, not a real offset.
    let offset = if offset.abs() <= factor.abs() {
        0.0
    } else {
        nice(offset)
    };
    Some(Fit { r, factor, offset })
}

fn sparkline(store: &FrameStore, stats: &IdStats, s: &Scored, fit: Option<Fit>) -> Vec<(i64, f64)> {
    let n = stats.frames.len();
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
            let frame = store.frame(stats.frames[i] as usize);
            let raw = s.range.read(frame.data);
            let v = if s.signed {
                bits::sign_extend(raw, s.range.size) as f64
            } else {
                raw as f64
            };
            (frame.ts_ns, v * factor + offset)
        })
        .collect()
}

/// Suggested signals for one ID, best first. Bits past [`MAX_PAYLOAD`] and past the ID's shortest
/// frame are not looked at. Deterministic: the same log and hints give the same suggestions.
#[must_use]
pub fn suggest(store: &FrameStore, stats: &IdStats, hints: &Hints) -> Findings {
    let len = usize::from(stats.min_len).min(MAX_PAYLOAD);
    let sample = Sample::new(store, &stats.frames);
    let steps = stats.frames.len().saturating_sub(1);
    if len == 0 || sample.steps() == 0 {
        return Findings {
            suggestions: Vec::new(),
            sampled_frames: sample.len(),
        };
    }
    let bits = len * 8;
    let rates: Vec<f64> = (0..bits)
        .map(|b| f64::from(stats.bit_flips.get(b).copied().unwrap_or(0)) / steps as f64)
        .collect();

    let mut scored = checksums(&sample, len, &rates);
    for range in candidates(&rates, bits) {
        let profile = Profile::new(&sample, range);
        let Some(mut s) = classify(range, &profile, &sample, stats, steps) else {
            continue;
        };
        let near = markers_near(store, stats, range, profile.change_rate(), &hints.markers);
        if !near.is_empty() {
            s.score += (0.15 * near.len() as f64).min(0.25);
            let labels: Vec<&str> = near.iter().map(|m| m.label.as_str()).collect();
            s.reason += &format!("; changes near your marker at {}", labels.join(", "));
        }
        scored.push(s);
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
                s.reason = format!(
                    "Tracks {} (r = {:.2}); scale {} fitted, check it",
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
    let mut taken = float_words(&sample, len);
    let mut suggestions = Vec::new();
    for i in order {
        let s = &scored[i];
        let mask = s.range.mask();
        if s.score < MIN_SCORE || mask.iter().zip(&taken).any(|(m, t)| m & t != 0) {
            continue;
        }
        for (t, m) in taken.iter_mut().zip(mask) {
            *t |= m;
        }
        let fit = fits[i].take();
        let reason = if s.kind == Kind::Flag {
            let flips = stats.bit_flips[usize::from(s.range.start_bit)];
            let marker_note = s
                .reason
                .find("; changes near")
                .map_or("", |at| &s.reason[at..]);
            flag_reason(flips, whole_log_set_share(store, stats, s.range)) + marker_note
        } else {
            s.reason.clone()
        };
        suggestions.push(Suggestion {
            kind: s.kind,
            range: s.range,
            signed: s.signed,
            score: s.score.clamp(0.0, 0.99),
            reason,
            unconfirmed: s.unconfirmed,
            fit,
            spark: sparkline(store, stats, s, fit),
        });
        if suggestions.len() == MAX_SUGGESTIONS {
            break;
        }
    }
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
        let mut store = FrameStore::new();
        let mut rng = Rng(0x2545_F491_4F6C_DD1D);
        for i in 0..n {
            store.push(FrameRef {
                ts_ns: i as i64 * 10 * MS,
                channel: 0,
                id: 0x100,
                flags: 0,
                data: &payload(i, &mut rng),
            });
        }
        store
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
    fn floats_are_left_alone() {
        let s = store(6000, |i, _| {
            let f = ((wave(i) - 0.5) * 24.0) as f32;
            let b = f.to_le_bytes();
            [b[0], b[1], b[2], b[3], 0, 0, 0, 0]
        });
        assert!(found(&s).is_empty(), "{:?}", found(&s));
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
}
