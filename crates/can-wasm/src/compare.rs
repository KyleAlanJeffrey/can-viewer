//! Compare two logs: log A, the open log, and log B, a second log opened to compare against it.
//! IDs are matched by bus name and ID, and each one is scored from 0 to 100 by how differently
//! it behaves in the two logs, with a short reason. API.md documents the scoring under
//! `compareLogs`; in short:
//!
//! - An ID in only one log scores 100. One with fewer than 8 frames in either log is not
//!   scored: "Too few frames to compare".
//! - Discrete changes score 75 to 100: a payload length change or a change between classic CAN
//!   and CAN FD (90), and values of a byte that one log shows and the other never does. A value
//!   only counts as new when the other log's frames would have shown it had it been as common
//!   there, and, unless the other log holds the byte at 3 values or fewer, when it is not within
//!   reach of the other log's values (noise around a value, or a reading drifting on).
//! - Graded changes score at most 50: per bit, the change in the share of frames with the bit
//!   set and in the share where it toggles, scaled down when one log is much shorter.
//! - A rate ratio from 1.1 (more for IDs with few frames) up to 2 scores 0 up to 80.
//! - The ID scores its largest component.
//!
//! Ignore rules leave out bits that behave like a counter or checksum in both logs, and
//! subtract from each component what it scores between the first and second halves of log A.

use std::collections::BTreeMap;

use can_core::{flags, FrameStore, IdKey, IdStats, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{byte_lanes_in, js_err, log_info_json, ns_in, to_json, LogInput, Session};

/// Below this score (0 to 1) an ID or byte shows no significant difference.
pub const SIGNIFICANT: f64 = 0.1;
/// An ID with fewer frames than this in either log is not scored.
pub const MIN_FRAMES: u32 = 8;
/// A byte that takes at most this many values is a state, where any new value matters.
const STATE_VALUES: usize = 3;
/// Ratio of rates that scores nothing, and the share of the rate score a doubling reaches.
const RATE_TOLERANCE: f64 = 1.1;
const RATE_WEIGHT: f64 = 0.8;
/// A change of payload length, or between classic CAN and CAN FD.
const FORMAT_SCORE: f64 = 0.9;
/// What a new value scores at least, given enough evidence.
const QUALITATIVE: f64 = 0.75;
/// The most a graded change of bit behaviour scores.
const GRADED_MAX: f64 = 0.5;
/// A reason that names a byte reads "Small value changes" below this score.
const SMALL: f64 = 0.35;

const TOO_FEW_FRAMES: &str = "Too few frames to compare";

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Leave out bits that behave like a counter or checksum in both logs.
    #[serde(default)]
    pub ignore_counters: bool,
    /// Subtract what each component scores between the two halves of log A.
    #[serde(default)]
    pub ignore_changes_within_a: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Presence {
    Both,
    OnlyA,
    OnlyB,
}

/// One bus/ID pair of either log. Serialized as the CoreApi `IdComparison`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdComparison {
    pub bus: String,
    /// What log B calls the bus, when it has the ID; differs from `bus` when buses were
    /// matched by order.
    pub bus_b: Option<String>,
    /// Without the extended flag; error frames are left out.
    pub id: u32,
    pub extended: bool,
    pub key_a: Option<IdKey>,
    pub key_b: Option<IdKey>,
    pub presence: Presence,
    pub name: Option<String>,
    pub frames_a: u32,
    pub frames_b: u32,
    /// Frames per second of the log's duration; None for a log of no duration.
    pub rate_a: Option<f64>,
    pub rate_b: Option<f64>,
    pub score: u8,
    pub reason: String,
    /// Payload bytes that differ significantly, most different first.
    pub bytes: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IgnoredKind {
    Counter,
    Checksum,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Ignored {
    pub byte: usize,
    pub mask: u8,
    pub kind: IgnoredKind,
}

/// Byte by byte detail of one ID. Serialized as the CoreApi `ByteComparison`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteComparison {
    /// Bytes described: the longer payload of the two logs, at most 64.
    pub len: usize,
    pub frames_a: u32,
    pub frames_b: u32,
    /// Toggles between consecutive frames, indexed `byte * 8 + bit`, as `bitFlips` gives them.
    pub flips_a: Vec<u32>,
    pub flips_b: Vec<u32>,
    /// 0 to 1 per bit, before the log A baseline; 0 for ignored bits.
    pub bit_scores: Vec<f64>,
    pub byte_scores: Vec<u8>,
    pub byte_reasons: Vec<String>,
    /// Up to 16 values of each byte that log B shows and log A never does, counted as new
    /// rather than noise or drift, with ignored bits cleared.
    pub new_values: Vec<Vec<u8>>,
    pub ignored: Vec<Ignored>,
}

/// One ID in one log.
#[derive(Clone, Copy)]
pub struct Side<'a> {
    pub store: &'a FrameStore,
    pub stats: &'a IdStats,
}

/// How one payload byte behaved over a stretch of frames.
#[derive(Clone)]
struct ByteProfile {
    /// Frames per value.
    values: [u32; 256],
    /// Consecutive frame pairs per XOR of their values.
    xors: [u32; 256],
    /// Consecutive frame pairs per difference, later minus earlier, modulo 256.
    steps: [u32; 256],
    /// The same for the high nibble, modulo 16.
    high_steps: [u32; 16],
}

impl ByteProfile {
    fn new() -> Self {
        Self {
            values: [0; 256],
            xors: [0; 256],
            steps: [0; 256],
            high_steps: [0; 16],
        }
    }

    fn pairs(&self) -> u32 {
        self.xors.iter().sum()
    }

    fn flips(&self, bit: usize) -> u32 {
        sum_where(&self.xors, |x| x >> bit & 1 == 1)
    }
}

struct Profile {
    frames: u32,
    /// Seconds the frames were taken from, to turn counts into rates.
    span_s: f64,
    max_len: usize,
    /// Frames sent as CAN FD.
    fd_frames: u32,
    bytes: Vec<ByteProfile>,
    /// Frames as long as `bytes`, which the checksum histograms below cover.
    full_frames: u32,
    /// Per value of `2 * byte - sum of all bytes` (modulo 256), for the first and last byte:
    /// constant when that byte is the sum of the others plus a constant.
    sum_first: [u32; 256],
    sum_last: [u32; 256],
    /// Per XOR of all bytes: constant when one byte is the XOR of the others.
    xor_all: [u32; 256],
}

fn sum_where(hist: &[u32], keep: impl Fn(usize) -> bool) -> u32 {
    hist.iter()
        .enumerate()
        .filter(|&(x, _)| keep(x))
        .map(|(_, &n)| n)
        .sum()
}

/// The first `len` bytes of each of `frames`.
fn profile(store: &FrameStore, frames: &[u32], len: usize, span_s: f64) -> Profile {
    let mut p = Profile {
        frames: 0,
        span_s,
        max_len: 0,
        fd_frames: 0,
        bytes: vec![ByteProfile::new(); len],
        full_frames: 0,
        sum_first: [0; 256],
        sum_last: [0; 256],
        xor_all: [0; 256],
    };
    let mut prev: &[u8] = &[];
    for &index in frames {
        let frame = store.frame(index as usize);
        let data = &frame.data[..frame.data.len().min(len)];
        p.frames += 1;
        p.max_len = p.max_len.max(data.len());
        if frame.flags & flags::FD != 0 {
            p.fd_frames += 1;
        }
        for (k, &v) in data.iter().enumerate() {
            let b = &mut p.bytes[k];
            b.values[usize::from(v)] += 1;
            if let Some(&u) = prev.get(k) {
                b.xors[usize::from(u ^ v)] += 1;
                b.steps[usize::from(v.wrapping_sub(u))] += 1;
                b.high_steps[usize::from((v >> 4).wrapping_sub(u >> 4) & 15)] += 1;
            }
        }
        if len > 0 && data.len() == len {
            p.full_frames += 1;
            let sum = data.iter().fold(0u8, |s, &v| s.wrapping_add(v));
            let xor = data.iter().fold(0u8, |s, &v| s ^ v);
            p.sum_first[usize::from(data[0].wrapping_mul(2).wrapping_sub(sum))] += 1;
            p.sum_last[usize::from(data[len - 1].wrapping_mul(2).wrapping_sub(sum))] += 1;
            p.xor_all[usize::from(xor)] += 1;
        }
        prev = data;
    }
    p
}

fn distinct(values: &[u32; 256], mask: u8) -> usize {
    let mut seen = [false; 256];
    for (v, &n) in values.iter().enumerate() {
        if n > 0 {
            seen[v & usize::from(mask)] = true;
        }
    }
    seen.iter().filter(|&&s| s).count()
}

/// Whether one non-zero step accounts for at least 80% of `pairs`, as a counter's does.
fn counts_up(steps: &[u32], pairs: u32) -> bool {
    let best = steps.iter().skip(1).copied().max().unwrap_or(0);
    pairs >= 8 && f64::from(best) >= 0.8 * f64::from(pairs)
}

/// A counter over the whole byte: one step between most frames, more values than a nibble
/// holds, and carries into the high nibble. A nibble counter beside other bits looks the same
/// except where its nibble wraps, which steps the byte back by 16 instead.
fn whole_byte_counter(b: &ByteProfile) -> bool {
    let pairs = b.pairs();
    let Some((step, _)) = b.steps.iter().enumerate().skip(1).max_by_key(|&(_, &n)| n) else {
        return false;
    };
    let no_carry = b.steps[(step + 256 - 16) % 256] + b.steps[(step + 16) % 256];
    counts_up(&b.steps, pairs) && distinct(&b.values, 0xFF) > 16 && no_carry * 20 < pairs
}

fn mostly_constant(hist: &[u32; 256], frames: u32) -> bool {
    let best = hist.iter().copied().max().unwrap_or(0);
    frames >= 8 && f64::from(best) >= 0.95 * f64::from(frames)
}

/// A byte that changes on nearly every frame with each bit toggling about half the time, as a
/// CRC does.
fn crc_like(b: &ByteProfile) -> bool {
    let pairs = b.pairs();
    let changed = pairs - b.xors[0];
    pairs >= 32
        && f64::from(changed) >= 0.9 * f64::from(pairs)
        && distinct(&b.values, 0xFF) >= 16
        && (0..8).all(|bit| {
            let share = f64::from(b.flips(bit)) / f64::from(pairs);
            (0.25..=0.75).contains(&share)
        })
}

/// Bits of each byte that behave like a counter, and like a checksum. Counters are 4-bit
/// nibbles or whole bytes that step by the same amount between most frames; checksums are the
/// first or last byte when it is the sum or XOR of at least two other changing bytes plus a
/// constant, or looks like a CRC.
fn counters_and_checksums(p: &Profile) -> (Vec<u8>, Vec<u8>) {
    let len = p.bytes.len();
    let mut counter = vec![0u8; len];
    let mut checksum = vec![0u8; len];
    for (k, b) in p.bytes.iter().enumerate() {
        let pairs = b.pairs();
        if whole_byte_counter(b) {
            counter[k] = 0xFF;
            continue;
        }
        let mut low_steps = [0u32; 16];
        for (step, &n) in b.steps.iter().enumerate() {
            low_steps[step & 15] += n;
        }
        if counts_up(&low_steps, pairs) && distinct(&b.values, 0x0F) >= 4 {
            counter[k] |= 0x0F;
        }
        if counts_up(&b.high_steps, pairs) && distinct(&b.values, 0xF0) >= 4 {
            counter[k] |= 0xF0;
        }
    }
    if len >= 2 {
        let changing = |k: usize| distinct(&p.bytes[k].values, 0xFF) >= 2;
        // A byte that only mirrors one other is a copy, not a checksum.
        let candidate = |k: usize| {
            distinct(&p.bytes[k].values, 0xFF) >= 4
                && (0..len).filter(|&j| j != k && changing(j)).count() >= 2
        };
        let first = mostly_constant(&p.sum_first, p.full_frames) && candidate(0);
        let last = mostly_constant(&p.sum_last, p.full_frames) && candidate(len - 1);
        // Both relations holding ties the end bytes to each other; take the last, where
        // checksums usually are, rather than both.
        if last {
            checksum[len - 1] = 0xFF;
        } else if first {
            checksum[0] = 0xFF;
        }
        if mostly_constant(&p.xor_all, p.full_frames) && checksum.iter().all(|&c| c == 0) {
            if let Some(k) = [len - 1, 0].into_iter().find(|&k| candidate(k)) {
                checksum[k] = 0xFF;
            }
        }
        for k in [0, len - 1] {
            if crc_like(&p.bytes[k]) {
                checksum[k] = 0xFF;
            }
        }
    }
    (counter, checksum)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ByteReason {
    NewValues,
    ValuesOnlyInA,
    DifferentValue,
    ChangesMore,
    ChangesLess,
    Shift,
}

/// What one byte scores, and why: the graded change, values only B shows, and values only A
/// shows, kept apart for the log A baseline. Values only B shows are discounted by values
/// A's second half shows that its first never does, as a drifting reading's are; values
/// only A shows by A's halves differing either way, since then B, another stretch of time,
/// may simply miss some of A's values; and graded changes by any change within A. So a
/// change elsewhere in A's byte never hides a new value in B.
struct ByteDiff {
    parts: [(f64, ByteReason); 3],
    bits: [f64; 8],
    new_values: Vec<u8>,
}

impl ByteDiff {
    fn best(&self) -> (f64, ByteReason) {
        self.less(None)
    }

    /// The largest part less its baseline from `within_a`, with its reason.
    fn less(&self, within_a: Option<&ByteDiff>) -> (f64, ByteReason) {
        let baseline = within_a.map_or([0.0; 3], |n| {
            let [graded, new_b, new_a] = n.parts.map(|p| p.0);
            [graded.max(new_b).max(new_a), new_b, new_b.max(new_a)]
        });
        let mut best = (0.0, ByteReason::Shift);
        for (i, &(score, reason)) in self.parts.iter().enumerate() {
            let score = (score - baseline[i]).max(0.0);
            if score > best.0 {
                best = (score, reason);
            }
        }
        best
    }
}

fn masked(values: &[u32; 256], keep: u8) -> [u32; 256] {
    let mut out = [0; 256];
    for (v, &n) in values.iter().enumerate() {
        out[v & usize::from(keep)] += n;
    }
    out
}

/// How much each log's frames are worth as evidence about the other. A log of fewer seconds
/// than the other shows less of what an ID does, so its frames count for less, and graded
/// changes between logs of very different lengths count for less too.
#[derive(Debug, Clone, Copy)]
struct Weight {
    a: f64,
    b: f64,
    graded: f64,
}

fn weight_of(a: &Profile, b: &Profile) -> Weight {
    let at_most_one = |x: f64, y: f64| if y > 0.0 { (x / y).min(1.0) } else { 1.0 };
    let (sa, sb) = (a.span_s, b.span_s);
    Weight {
        a: at_most_one(sa, sb),
        b: at_most_one(sb, sa),
        graded: at_most_one(sa.min(sb), sa.max(sb)).sqrt(),
    }
}

/// Values of `other` within reach of the reference's own: walking the values either log shows
/// in order (wrapping at 255), a run with gaps of at most `step` that holds a reference value
/// takes in every value of it. This is how noise around a value, or a reading drifting on,
/// looks.
fn within_reach(reference: &[u32; 256], other: &[u32; 256], step: usize) -> [bool; 256] {
    let present: Vec<usize> = (0..256)
        .filter(|&v| reference[v] > 0 || other[v] > 0)
        .collect();
    let mut run = vec![0usize; present.len()];
    for i in 1..present.len() {
        run[i] = run[i - 1] + usize::from(present[i] - present[i - 1] > step);
    }
    if let (Some(&first), Some(&last)) = (present.first(), present.last()) {
        if present.len() > 1 && first + 256 - last <= step {
            let wrapped = run[present.len() - 1];
            for r in &mut run {
                if *r == wrapped {
                    *r = 0;
                }
            }
        }
    }
    let mut anchored = vec![false; run.last().map_or(0, |&r| r + 1)];
    for (i, &v) in present.iter().enumerate() {
        if reference[v] > 0 {
            anchored[run[i]] = true;
        }
    }
    let mut out = [false; 256];
    for (i, &v) in present.iter().enumerate() {
        out[v] = anchored[run[i]];
    }
    out
}

/// Values `other` shows that `reference` never does, counted as new: what they score and
/// which they are. `unit` is the smallest step a value takes with ignored bits cleared, and
/// `coverage` the reference's [`Weight`]: a reference log much shorter than the other may just
/// not have run into the values.
fn novelty(
    reference: &[u32; 256],
    other: &[u32; 256],
    other_frames: f64,
    coverage: f64,
    unit: usize,
) -> (f64, Vec<u8>) {
    let values = distinct(reference, 0xFF);
    let reach = if values <= STATE_VALUES {
        [false; 256]
    } else {
        within_reach(reference, other, unit * (values / 4).max(2))
    };
    let new: Vec<u8> = (0..=255u8)
        .filter(|&v| {
            let v = usize::from(v);
            other[v] > 0 && reference[v] == 0 && !reach[v]
        })
        .collect();
    let frames: u32 = new.iter().map(|&v| other[usize::from(v)]).sum();
    if frames == 0 || other_frames <= 0.0 {
        return (0.0, new);
    }
    let share = f64::from(frames) / other_frames;
    // How sure it is that the reference would have shown the values, had they been as common
    // there as they are in the other log.
    let seen = 1.0 - (-share * f64::from(reference.iter().sum::<u32>())).exp();
    let score = seen * (QUALITATIVE + (1.0 - QUALITATIVE) * (4.0 * share).min(1.0));
    (score * coverage, new)
}

/// Bits that tell `new` values apart from the reference's: bits the reference holds steady
/// that a new value flips, or else bits where new values differ from the reference's most
/// common value.
fn telling_bits(reference: &[u32; 256], new: &[u8], keep: u8) -> u8 {
    let (mut ones, mut zeros) = (0u8, 0u8);
    for (v, &n) in reference.iter().enumerate() {
        if n > 0 {
            ones |= v as u8;
            zeros |= !(v as u8);
        }
    }
    let steady = !(ones & zeros) & keep;
    let flipped = new
        .iter()
        .fold(0u8, |m, &v| m | ((v & steady) ^ (ones & steady)));
    if flipped != 0 {
        return flipped;
    }
    let common = (0..256).max_by_key(|&v| reference[v]).unwrap_or(0) as u8;
    new.iter().fold(0u8, |m, &v| m | ((v ^ common) & keep))
}

/// How differently one byte behaves in `a` and `b`, over the bits in `keep`. None when either
/// log has no frame carrying it, or every bit is ignored.
fn byte_diff(a: &ByteProfile, b: &ByteProfile, keep: u8, weight: Weight) -> Option<ByteDiff> {
    let (va, vb) = (masked(&a.values, keep), masked(&b.values, keep));
    let (na, nb) = (va.iter().sum::<u32>(), vb.iter().sum::<u32>());
    if keep == 0 || na == 0 || nb == 0 {
        return None;
    }
    let (na, nb) = (f64::from(na), f64::from(nb));
    let (pairs_a, pairs_b) = (f64::from(a.pairs()), f64::from(b.pairs()));
    let share = |n: u32, of: f64| if of > 0.0 { f64::from(n) / of } else { 0.0 };

    let mut graded_best = (0.0, ByteReason::Shift);
    let mut consider = |score: f64, reason| {
        if score > graded_best.0 {
            graded_best = (score, reason);
        }
    };
    let graded = GRADED_MAX * weight.graded;
    let mut bits = [0.0; 8];
    for (bit, out) in bits.iter_mut().enumerate() {
        if keep >> bit & 1 == 0 {
            continue;
        }
        let set = |v: &[u32; 256]| sum_where(v, |x| x >> bit & 1 == 1);
        let set_change = graded * (share(set(&va), na) - share(set(&vb), nb)).abs();
        let (toggle_a, toggle_b) = (share(a.flips(bit), pairs_a), share(b.flips(bit), pairs_b));
        let toggle_change = graded * (toggle_a - toggle_b).abs();
        *out = set_change.max(toggle_change);
        consider(set_change, ByteReason::Shift);
        consider(
            toggle_change,
            if toggle_b > toggle_a {
                ByteReason::ChangesMore
            } else {
                ByteReason::ChangesLess
            },
        );
    }

    let unit = 1usize << keep.trailing_zeros();
    let (new_b, values_b) = novelty(&va, &vb, nb, weight.a, unit);
    let (new_a, values_a) = novelty(&vb, &va, na, weight.b, unit);
    for (score, reference, values) in [(new_b, &va, &values_b), (new_a, &vb, &values_a)] {
        if score > 0.0 {
            let telling = telling_bits(reference, values, keep);
            for (bit, out) in bits.iter_mut().enumerate() {
                if telling >> bit & 1 == 1 {
                    *out = out.max(score);
                }
            }
        }
    }
    let new_reason = if distinct(&va, 0xFF) == 1 && distinct(&vb, 0xFF) == 1 {
        ByteReason::DifferentValue
    } else {
        ByteReason::NewValues
    };

    let mut new_values = values_b;
    new_values.truncate(16);
    Some(ByteDiff {
        parts: [
            graded_best,
            (new_b, new_reason),
            (new_a, ByteReason::ValuesOnlyInA),
        ],
        bits,
        new_values,
    })
}

/// Everything that differs between two profiles of one ID, before any baseline is subtracted.
struct Components {
    rate: f64,
    /// B's rate over A's; None when either log has no duration.
    ratio: Option<f64>,
    length: f64,
    fd: f64,
    bytes: Vec<Option<ByteDiff>>,
}

fn rate_of(p: &Profile) -> Option<f64> {
    (p.span_s > 0.0).then(|| f64::from(p.frames) / p.span_s)
}

/// A rate ratio's score. Counts of a few frames are off by one frame or so at either end, so
/// the ratio that scores nothing grows as they shrink.
fn rate_score(ratio: f64, frames: u32) -> f64 {
    let up = if ratio < 1.0 { 1.0 / ratio } else { ratio };
    let tolerance = RATE_TOLERANCE + 2.0 / f64::from(frames.max(1));
    if !up.is_finite() || tolerance >= 2.0 {
        return 0.0;
    }
    RATE_WEIGHT * ((up - tolerance) / (2.0 - tolerance)).clamp(0.0, 1.0)
}

fn components(a: &Profile, b: &Profile, keep: &[u8]) -> Components {
    let ratio = match (rate_of(a), rate_of(b)) {
        (Some(ra), Some(rb)) if ra > 0.0 => Some(rb / ra),
        _ => None,
    };
    let weight = weight_of(a, b);
    let common = a.bytes.len().min(b.bytes.len());
    let differ = |x: bool| if x { FORMAT_SCORE } else { 0.0 };
    Components {
        rate: ratio.map_or(0.0, |r| rate_score(r, a.frames.min(b.frames))),
        ratio,
        length: differ(a.max_len != b.max_len),
        fd: differ((a.fd_frames == 0) != (b.fd_frames == 0)),
        bytes: (0..common)
            .map(|k| {
                byte_diff(
                    &a.bytes[k],
                    &b.bytes[k],
                    keep.get(k).copied().unwrap_or(0xFF),
                    weight,
                )
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Finding {
    Rate(f64),
    Length(usize, usize),
    Fd(bool),
    Byte(usize, ByteReason),
}

/// One ID judged: its score and reason after the baseline, and each byte's adjusted score.
struct Verdict {
    score: f64,
    reason: String,
    byte_scores: Vec<f64>,
    byte_reasons: Vec<ByteReason>,
    too_few: bool,
}

fn byte_reason_text(byte: usize, reason: ByteReason, score: f64) -> String {
    match reason {
        ByteReason::NewValues => format!("Byte {byte} takes new values"),
        ByteReason::ValuesOnlyInA => format!("Byte {byte} has values only in A"),
        ByteReason::DifferentValue => format!("Byte {byte} holds a different value"),
        _ if score < SMALL => "Small value changes".to_owned(),
        ByteReason::ChangesMore => format!("Byte {byte} changes more often"),
        ByteReason::ChangesLess => format!("Byte {byte} changes less often"),
        ByteReason::Shift => format!("Byte {byte} values shift"),
    }
}

fn rate_text(ratio: f64) -> String {
    if (1.8..=2.2).contains(&ratio) {
        "Rate doubled".to_owned()
    } else if (0.45..=0.55).contains(&ratio) {
        "Rate halved".to_owned()
    } else if ratio > 1.0 {
        format!("Rate up {ratio:.1}x")
    } else {
        format!("Rate down {:.1}x", 1.0 / ratio)
    }
}

fn judge(ab: &Components, a: &Profile, b: &Profile, noise: Option<&Components>) -> Verdict {
    if a.frames < MIN_FRAMES || b.frames < MIN_FRAMES {
        return Verdict {
            score: 0.0,
            reason: TOO_FEW_FRAMES.to_owned(),
            byte_scores: vec![0.0; ab.bytes.len()],
            byte_reasons: vec![ByteReason::Shift; ab.bytes.len()],
            too_few: true,
        };
    }
    let less = |score: f64, baseline: Option<f64>| (score - baseline.unwrap_or(0.0)).max(0.0);
    let adjusted: Vec<Option<(f64, ByteReason)>> = ab
        .bytes
        .iter()
        .enumerate()
        .map(|(k, d)| {
            let baseline = noise.and_then(|n| n.bytes.get(k)?.as_ref());
            d.as_ref().map(|d| d.less(baseline))
        })
        .collect();
    let byte_scores: Vec<f64> = adjusted.iter().map(|d| d.map_or(0.0, |d| d.0)).collect();
    let byte_reasons = adjusted
        .iter()
        .map(|d| d.map_or(ByteReason::Shift, |d| d.1))
        .collect();

    let mut best: Option<(f64, Finding)> = None;
    let mut raw_best = 0.0f64;
    let mut consider = |raw: f64, adjusted: f64, finding| {
        raw_best = raw_best.max(raw);
        if adjusted > best.map_or(0.0, |(s, _)| s) {
            best = Some((adjusted, finding));
        }
    };
    for (k, d) in ab.bytes.iter().enumerate() {
        if let (Some(d), Some((score, reason))) = (d, adjusted[k]) {
            consider(d.best().0, score, Finding::Byte(k, reason));
        }
    }
    consider(
        ab.length,
        less(ab.length, noise.map(|n| n.length)),
        Finding::Length(a.max_len, b.max_len),
    );
    consider(
        ab.fd,
        less(ab.fd, noise.map(|n| n.fd)),
        Finding::Fd(b.fd_frames > 0),
    );
    if let Some(ratio) = ab.ratio {
        consider(
            ab.rate,
            less(ab.rate, noise.map(|n| n.rate)),
            Finding::Rate(ratio),
        );
    }

    let (score, reason) = match best {
        Some((score, finding)) if score >= SIGNIFICANT => (
            score,
            match finding {
                Finding::Byte(k, reason) => byte_reason_text(k, reason, score),
                Finding::Length(from, to) => format!("Length changes from {from} to {to} bytes"),
                Finding::Fd(true) => "Changes from classic CAN to CAN FD".to_owned(),
                Finding::Fd(false) => "Changes from CAN FD to classic CAN".to_owned(),
                Finding::Rate(ratio) => rate_text(ratio),
            },
        ),
        best => (
            best.map_or(0.0, |(s, _)| s),
            if noise.is_some() && raw_best >= SIGNIFICANT {
                "Also changes within A".to_owned()
            } else {
                "No significant changes".to_owned()
            },
        ),
    };
    Verdict {
        score,
        reason,
        byte_scores,
        byte_reasons,
        too_few: false,
    }
}

fn percent(score: f64) -> u8 {
    (score.clamp(0.0, 1.0) * 100.0).round() as u8
}

fn duration_s(store: &FrameStore) -> f64 {
    match (store.first_ts_ns(), store.last_ts_ns()) {
        (Some(a), Some(b)) => (b - a) as f64 / 1e9,
        _ => 0.0,
    }
}

fn len_of(side: Option<Side<'_>>) -> usize {
    side.map_or(0, |s| usize::from(s.stats.max_len).min(MAX_PAYLOAD))
}

fn whole(side: Side<'_>, len: usize) -> Profile {
    profile(side.store, &side.stats.frames, len, duration_s(side.store))
}

/// The ID's frames in the first and second half of the log's time span.
fn halves(side: Side<'_>, len: usize) -> (Profile, Profile) {
    let span = duration_s(side.store);
    let first = side.store.first_ts_ns().unwrap_or(0);
    let mid = first.saturating_add((span * 0.5e9) as i64);
    let split = side.store.first_of_id_at_or_after(side.stats, mid);
    let (early, late) = side.stats.frames.split_at(split);
    (
        profile(side.store, early, len, span / 2.0),
        profile(side.store, late, len, span / 2.0),
    )
}

/// Both logs' profiles of one ID, with the bits the ignore rules leave out.
struct Analysis {
    a: Option<Profile>,
    b: Option<Profile>,
    ignored: Vec<Ignored>,
    keep: Vec<u8>,
    ab: Option<Components>,
    noise: Option<Components>,
}

fn analyse(a: Option<Side<'_>>, b: Option<Side<'_>>, options: Options) -> Analysis {
    let len = len_of(a).max(len_of(b));
    let pa = a.map(|s| whole(s, len));
    let pb = b.map(|s| whole(s, len));
    let mut keep = vec![0xFF; len];
    let mut ignored = Vec::new();
    if let (true, Some(pa), Some(pb)) = (options.ignore_counters, &pa, &pb) {
        let ((ca, sa), (cb, sb)) = (counters_and_checksums(pa), counters_and_checksums(pb));
        for k in 0..len {
            let counter = ca[k] & cb[k];
            let checksum = sa[k] & sb[k] & !counter;
            for (mask, kind) in [
                (counter, IgnoredKind::Counter),
                (checksum, IgnoredKind::Checksum),
            ] {
                if mask != 0 {
                    ignored.push(Ignored {
                        byte: k,
                        mask,
                        kind,
                    });
                }
            }
            keep[k] = !(counter | checksum);
        }
    }
    let ab = match (&pa, &pb) {
        (Some(pa), Some(pb)) => Some(components(pa, pb, &keep)),
        _ => None,
    };
    let noise = match (a, &ab) {
        (Some(a), Some(_)) if options.ignore_changes_within_a => {
            let (early, late) = halves(a, len);
            Some(components(&early, &late, &keep))
        }
        _ => None,
    };
    Analysis {
        a: pa,
        b: pb,
        ignored,
        keep,
        ab,
        noise,
    }
}

/// Channels of `store` that carry data frames, not just error frames, in order.
fn data_buses(store: &FrameStore) -> Vec<usize> {
    (0..store.channels().len())
        .filter(|&c| {
            store
                .ids()
                .iter()
                .any(|s| usize::from(s.channel) == c && s.id & ERR_FLAG == 0)
        })
        .collect()
}

/// What each of B's channels is called for matching: its own name, unless the logs carry data
/// on as many buses as each other and share no bus name, as when another tool names them
/// `vcan0` rather than `can0`. Then B's buses take A's names in order.
fn b_bus_names(a: &FrameStore, b: &FrameStore) -> Vec<String> {
    let mut names = b.channels().to_vec();
    let (on_a, on_b) = (data_buses(a), data_buses(b));
    let shared = on_b
        .iter()
        .any(|&j| on_a.iter().any(|&i| a.channels()[i] == b.channels()[j]));
    if on_a.len() == on_b.len() && (on_a.len() == 1 || !shared) {
        for (&i, &j) in on_a.iter().zip(&on_b) {
            names[j].clone_from(&a.channels()[i]);
        }
    }
    names
}

/// One bus/ID pair's stats in log A and in log B.
type Pair<'a> = (Option<&'a IdStats>, Option<&'a IdStats>);

/// Every ID of either log, error frames aside, scored. Most different first.
pub fn compare_logs(a: &FrameStore, b: &FrameStore, options: Options) -> Vec<IdComparison> {
    let b_names = b_bus_names(a, b);
    let mut pairs: BTreeMap<(String, u32), Pair<'_>> = BTreeMap::new();
    for s in a.ids().iter().filter(|s| s.id & ERR_FLAG == 0) {
        let bus = a.channels()[usize::from(s.channel)].clone();
        pairs.entry((bus, s.id)).or_default().0 = Some(s);
    }
    for s in b.ids().iter().filter(|s| s.id & ERR_FLAG == 0) {
        let bus = b_names[usize::from(s.channel)].clone();
        pairs.entry((bus, s.id)).or_default().1 = Some(s);
    }
    let (dur_a, dur_b) = (duration_s(a), duration_s(b));
    let rate = |frames: usize, dur: f64| (dur > 0.0).then(|| frames as f64 / dur);

    let mut out: Vec<IdComparison> = pairs
        .into_iter()
        .map(|((bus, id), (sa, sb))| {
            let side_a = sa.map(|stats| Side { store: a, stats });
            let side_b = sb.map(|stats| Side { store: b, stats });
            let (presence, score, reason, bytes) = match (side_a, side_b) {
                (Some(_), None) => (Presence::OnlyA, 100, "Appears only in A".to_owned(), vec![]),
                (None, Some(_)) => (Presence::OnlyB, 100, "Appears only in B".to_owned(), vec![]),
                _ => {
                    let analysis = analyse(side_a, side_b, options);
                    let (Some(pa), Some(pb), Some(ab)) = (&analysis.a, &analysis.b, &analysis.ab)
                    else {
                        unreachable!("both sides are present");
                    };
                    let verdict = judge(ab, pa, pb, analysis.noise.as_ref());
                    let mut bytes: Vec<(usize, f64)> = verdict
                        .byte_scores
                        .iter()
                        .copied()
                        .enumerate()
                        .filter(|&(_, s)| s >= SIGNIFICANT)
                        .collect();
                    bytes.sort_by(|x, y| y.1.total_cmp(&x.1).then(x.0.cmp(&y.0)));
                    (
                        Presence::Both,
                        percent(verdict.score),
                        verdict.reason,
                        bytes.into_iter().map(|(k, _)| k).collect(),
                    )
                }
            };
            let frames_a = sa.map_or(0, |s| s.frames.len());
            let frames_b = sb.map_or(0, |s| s.frames.len());
            IdComparison {
                bus,
                bus_b: sb.map(|s| b.channels()[usize::from(s.channel)].clone()),
                id: id & !EXT_FLAG,
                extended: id & EXT_FLAG != 0,
                key_a: sa.map(IdStats::key),
                key_b: sb.map(IdStats::key),
                presence,
                name: None,
                frames_a: frames_a as u32,
                frames_b: frames_b as u32,
                rate_a: rate(frames_a, dur_a),
                rate_b: rate(frames_b, dur_b),
                score,
                reason,
                bytes,
            }
        })
        .collect();
    out.sort_by_key(|c| std::cmp::Reverse(c.score));
    out
}

/// Byte by byte detail of one ID in either or both logs.
pub fn compare_bytes(a: Option<Side<'_>>, b: Option<Side<'_>>, options: Options) -> ByteComparison {
    let analysis = analyse(a, b, options);
    let len = analysis.keep.len();
    let flips = |p: &Option<Profile>| -> Vec<u32> {
        let mut out = vec![0; len * 8];
        if let Some(p) = p {
            for (k, b) in p.bytes.iter().enumerate() {
                for bit in 0..8 {
                    out[k * 8 + bit] = b.flips(bit);
                }
            }
        }
        out
    };
    let mut bit_scores = vec![0.0; len * 8];
    let mut byte_scores = vec![0u8; len];
    let mut byte_reasons = vec![String::new(); len];
    let mut new_values = vec![Vec::new(); len];
    if let (Some(pa), Some(pb), Some(ab)) = (&analysis.a, &analysis.b, &analysis.ab) {
        let verdict = judge(ab, pa, pb, analysis.noise.as_ref());
        for (k, d) in ab.bytes.iter().enumerate() {
            let Some(d) = d else { continue };
            let score = verdict.byte_scores[k];
            byte_scores[k] = percent(score);
            if verdict.too_few {
                byte_reasons[k] = TOO_FEW_FRAMES.to_owned();
                continue;
            }
            bit_scores[k * 8..k * 8 + 8].copy_from_slice(&d.bits);
            byte_reasons[k] = if score >= SIGNIFICANT {
                byte_reason_text(k, verdict.byte_reasons[k], score)
            } else {
                "No significant changes".to_owned()
            };
            new_values[k].clone_from(&d.new_values);
        }
    }
    ByteComparison {
        len,
        frames_a: analysis.a.as_ref().map_or(0, |p| p.frames),
        frames_b: analysis.b.as_ref().map_or(0, |p| p.frames),
        flips_a: flips(&analysis.a),
        flips_b: flips(&analysis.b),
        bit_scores,
        byte_scores,
        byte_reasons,
        new_values,
        ignored: analysis.ignored,
    }
}

/// What log A and log B may take between them, well under wasm32's 4 GiB, since a browser may
/// allow less and the stores need room to grow and sort.
pub const COMPARE_MEMORY_BUDGET: usize = 2 << 30;

/// Log B, read the way the open log is.
#[derive(Default)]
pub struct LogB {
    store: FrameStore,
    input: LogInput,
    finished: bool,
}

#[wasm_bindgen]
impl Session {
    /// Drop log B, then start reading a new one: the file's name and size, as for the open log.
    /// Push its bytes with [`Session::compare_push_chunk`] and end with
    /// [`Session::compare_finish`]. Log B may take what the open log leaves of
    /// [`COMPARE_MEMORY_BUDGET`]; a file likely to need more is refused once its format is
    /// known, with an error from the next call.
    pub fn compare_begin(&mut self, name: &str, total_bytes: f64) {
        self.log_b = None;
        let mut log = LogB::default();
        log.input.file_name = name.to_owned();
        log.input.total_bytes = total_bytes;
        log.input.limit = Some(COMPARE_MEMORY_BUDGET.saturating_sub(self.store.heap_bytes()));
        self.log_b = Some(log);
    }

    pub fn compare_push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        if let Some(log) = &mut self.log_b {
            log.input.push(chunk, &mut log.store);
            if log.input.refused {
                return Err(js_err(too_large(&log.input.file_name)));
            }
        }
        Ok(())
    }

    /// Flush log B's parser and return its JSON `LogInfo`.
    pub fn compare_finish(&mut self) -> Result<String, JsError> {
        let log = self
            .log_b
            .as_mut()
            .ok_or_else(|| js_err("no second log is being read"))?;
        log.input.finish(&mut log.store);
        if log.input.refused {
            let message = too_large(&log.input.file_name);
            self.log_b = None;
            return Err(js_err(&message));
        }
        log.finished = true;
        Ok(log_info_json(&log.store, &log.input))
    }

    /// Log B's JSON `LogInfo`, or `None` when there is none.
    pub fn compare_log_info(&self) -> Option<String> {
        self.finished_b()
            .map(|log| log_info_json(&log.store, &log.input))
    }

    pub fn close_compare_log(&mut self) {
        self.log_b = None;
    }

    /// Make log B the open log and the open log log B. Every series is dropped, as when a log is
    /// opened. Returns the new open log's JSON `LogInfo`.
    pub fn swap_compare_log(&mut self) -> Result<String, JsError> {
        self.swap_logs().map_err(js_err)?;
        Ok(self.log_info())
    }

    /// Every ID of the two logs, scored, as a JSON array of `IdComparison`, most different
    /// first. `options` is a JSON `CompareOptions`. Empty without log B.
    pub fn compare_logs(&self, options: &str) -> Result<String, JsError> {
        let options: Options = serde_json::from_str(options).map_err(js_err)?;
        let Some(log) = self.finished_b() else {
            return Ok("[]".to_owned());
        };
        let mut found = compare_logs(&self.store, &log.store, options);
        for c in &mut found {
            let dbc_id = c.id | if c.extended { EXT_FLAG } else { 0 };
            c.name = self
                .resolve_on(Some(&c.bus), dbc_id)
                .map(|(_, m)| m.name.clone());
        }
        Ok(to_json(&found))
    }

    /// JSON `ByteComparison` of ID `key_a` of the open log and `key_b` of log B; pass -1 for an
    /// ID one log lacks.
    pub fn compare_bytes(&self, key_a: f64, key_b: f64, options: &str) -> Result<String, JsError> {
        let options: Options = serde_json::from_str(options).map_err(js_err)?;
        let b = self.finished_b().and_then(|log| side_of(&log.store, key_b));
        Ok(to_json(&compare_bytes(
            side_of(&self.store, key_a),
            b,
            options,
        )))
    }

    /// Like [`Session::byte_lanes`], for ID `key` of log B, in seconds from log B's first frame.
    pub fn compare_byte_lanes(
        &self,
        key: f64,
        first: u32,
        count: u32,
        t0: f64,
        t1: f64,
        buckets: u32,
    ) -> Vec<f64> {
        self.finished_b().map_or_else(Vec::new, |log| {
            byte_lanes_in(&log.store, key, first, count, t0, t1, buckets)
        })
    }

    /// The payload of log B's last frame of ID `key` at or before `t` seconds from its first
    /// frame, or its first frame when `t` is earlier. Empty for an unknown key.
    pub fn compare_frame_at(&self, key: f64, t: f64) -> Vec<u8> {
        let Some(log) = self.finished_b() else {
            return Vec::new();
        };
        if key < 0.0 {
            return Vec::new();
        }
        let Some(stats) = log.store.id_stats(key as IdKey) else {
            return Vec::new();
        };
        let after = log
            .store
            .first_of_id_at_or_after(stats, ns_in(&log.store, t).saturating_add(1));
        stats
            .frames
            .get(after.saturating_sub(1))
            .map_or_else(Vec::new, |&i| log.store.frame(i as usize).data.to_vec())
    }
}

fn too_large(name: &str) -> String {
    format!(
        "{name} is too large to read beside the open log in this browser's memory. Compare a shorter log, or open a smaller log A."
    )
}

fn side_of(store: &FrameStore, key: f64) -> Option<Side<'_>> {
    let stats = store.id_stats(key as IdKey).filter(|_| key >= 0.0)?;
    Some(Side { store, stats })
}

impl Session {
    fn swap_logs(&mut self) -> Result<(), &'static str> {
        // A capture's frames are kept apart from any file's reader, so they can't trade places.
        if self.capture.is_some() {
            return Err("a capture can't be swapped; save it and open the file instead");
        }
        let log = match &mut self.log_b {
            Some(log) if log.finished => log,
            _ => return Err("there is no second log to swap with"),
        };
        std::mem::swap(&mut self.store, &mut log.store);
        std::mem::swap(&mut self.input, &mut log.input);
        self.series.clear();
        self.filtered = None;
        Ok(())
    }

    fn finished_b(&self) -> Option<&LogB> {
        self.log_b.as_ref().filter(|log| log.finished)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use can_core::{id_key, FrameRef, FrameSink};

    const S: i64 = 1_000_000_000;

    /// A store from `(seconds, bus, id, payload)` frames.
    fn store(frames: &[(f64, &str, u32, Vec<u8>)]) -> FrameStore {
        let mut store = FrameStore::new();
        for (t, bus, id, data) in frames {
            let channel = store.channel_index(bus.as_bytes());
            store.push(FrameRef {
                ts_ns: 100 * S + (t * 1e9) as i64,
                channel,
                id: *id,
                flags: 0,
                data,
            });
        }
        store.sort_by_time();
        store
    }

    /// `hz` frames a second for `seconds` on can0, with the payload a function of frame number
    /// and time.
    fn periodic(
        id: u32,
        hz: f64,
        seconds: f64,
        payload: impl Fn(usize, f64) -> Vec<u8>,
    ) -> Vec<(f64, &'static str, u32, Vec<u8>)> {
        let n = (hz * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / hz;
                (t, "can0", id, payload(i, t))
            })
            .collect()
    }

    fn first_id(store: &FrameStore) -> Option<Side<'_>> {
        Some(Side {
            store,
            stats: &store.ids()[0],
        })
    }

    fn find(found: &[IdComparison], id: u32) -> &IdComparison {
        found
            .iter()
            .find(|c| c.id == id)
            .expect("the ID is compared")
    }

    fn quiet(_: usize, _: f64) -> Vec<u8> {
        vec![0x10, 0x20, 0, 0, 0, 0, 0, 0]
    }

    const NO_RULES: Options = Options {
        ignore_counters: false,
        ignore_changes_within_a: false,
    };

    #[test]
    fn a_byte_that_takes_new_values_in_b_is_found() {
        let a = store(&periodic(0x450, 10.0, 30.0, quiet));
        let b = store(&periodic(0x450, 10.0, 28.0, |i, t| {
            let mut p = quiet(i, t);
            p[3] = u8::from(t >= 12.0);
            p
        }));
        let found = compare_logs(&a, &b, NO_RULES);
        let body = find(&found, 0x450);
        assert_eq!(body.presence, Presence::Both);
        assert_eq!(body.reason, "Byte 3 takes new values");
        assert_eq!(body.bytes, vec![3]);
        assert!(body.score >= 90, "{}", body.score);
        let near_10 = |rate: Option<f64>| rate.is_some_and(|r| (r - 10.0).abs() < 0.1);
        assert!(near_10(body.rate_a) && near_10(body.rate_b));

        let detail = compare_bytes(first_id(&a), first_id(&b), NO_RULES);
        assert_eq!(detail.len, 8);
        assert_eq!(detail.new_values[3], vec![1]);
        assert_eq!(detail.flips_b[3 * 8], 1);
        assert_eq!(detail.flips_a[3 * 8], 0);
        assert!(detail.bit_scores[3 * 8] >= 0.5);
        assert_eq!(detail.bit_scores[3 * 8 + 1], 0.0);
        assert_eq!(detail.byte_reasons[3], "Byte 3 takes new values");
        assert_eq!(detail.byte_scores[0], 0);
    }

    #[test]
    fn a_short_event_in_b_still_counts() {
        let a = store(&periodic(0x450, 10.0, 30.0, quiet));
        let b = store(&periodic(0x450, 10.0, 30.0, |i, t| {
            let mut p = quiet(i, t);
            p[5] = if (12.0..12.5).contains(&t) { 0x80 } else { 0 };
            p
        }));
        let body = &compare_logs(&a, &b, NO_RULES)[0];
        assert_eq!(body.reason, "Byte 5 takes new values");
        assert!(body.score >= 75);
    }

    #[test]
    fn a_doubled_rate_is_normalised_by_duration() {
        let a = store(&periodic(0x0C9, 100.0, 30.0, quiet));
        let b = store(&periodic(0x0C9, 200.0, 28.0, quiet));
        let engine = &compare_logs(&a, &b, NO_RULES)[0];
        assert_eq!(engine.reason, "Rate doubled");
        assert_eq!(engine.score, 80);
        assert!(engine.bytes.is_empty());

        // Same rate, different durations: nothing to report.
        let c = store(&periodic(0x0C9, 100.0, 12.0, quiet));
        let same = &compare_logs(&a, &c, NO_RULES)[0];
        assert_eq!(same.reason, "No significant changes");
        assert!(same.score < 10);
    }

    #[test]
    fn ids_in_one_log_only_score_100() {
        let mut a_frames = periodic(0x100, 10.0, 10.0, quiet);
        a_frames.push((5.0, "can0", 0x456, vec![1]));
        let mut b_frames = periodic(0x100, 10.0, 10.0, quiet);
        b_frames.extend(periodic(0x123, 50.0, 10.0, quiet));
        let found = compare_logs(&store(&a_frames), &store(&b_frames), NO_RULES);
        let only_b = find(&found, 0x123);
        assert_eq!(
            (only_b.presence, only_b.score, only_b.reason.as_str()),
            (Presence::OnlyB, 100, "Appears only in B")
        );
        assert_eq!(only_b.key_a, None);
        assert_eq!(only_b.key_b, Some(id_key(0, 0x123)));
        assert_eq!(only_b.frames_a, 0);
        let only_a = find(&found, 0x456);
        assert_eq!(
            (only_a.presence, only_a.reason.as_str()),
            (Presence::OnlyA, "Appears only in A")
        );
        assert_eq!(find(&found, 0x100).score, 0);
        assert_eq!(found.last().unwrap().id, 0x100, "most different first");
    }

    #[test]
    fn a_changed_length_is_reported() {
        let a = store(&periodic(0x200, 10.0, 10.0, quiet));
        let b = store(&periodic(0x200, 10.0, 10.0, |i, t| {
            quiet(i, t)[..6].to_vec()
        }));
        let found = &compare_logs(&a, &b, NO_RULES)[0];
        assert_eq!(found.reason, "Length changes from 8 to 6 bytes");
        assert_eq!(found.score, 90);
    }

    /// A message with a 4-bit counter in byte 6's low nibble, an XOR checksum in byte 7 over
    /// it and a reading in byte 1, and a state in byte 2 that only B sets.
    fn counted(frames: usize, offset: usize, state_from: Option<usize>) -> FrameStore {
        let frames: Vec<_> = (0..frames)
            .map(|i| {
                let n = i + offset;
                let mut p = vec![
                    0x11,
                    0x20 + (n / 7 % 3) as u8,
                    0,
                    0,
                    0,
                    0,
                    (n % 16) as u8,
                    0,
                ];
                if state_from.is_some_and(|from| i >= from) {
                    p[2] = 4;
                }
                p[7] = p[..7].iter().fold(0x5A, |x, &v| x ^ v);
                (i as f64 / 10.0, "can0", 0x3E9, p)
            })
            .collect();
        store(&frames)
    }

    #[test]
    fn counters_and_checksums_are_ignored_when_asked() {
        let a = counted(200, 0, None);
        let b = counted(200, 5, Some(100));
        assert_eq!(compare_logs(&a, &b, NO_RULES)[0].bytes, vec![2]);

        let rules = Options {
            ignore_counters: true,
            ..NO_RULES
        };
        let found = &compare_logs(&a, &b, rules)[0];
        assert_eq!(found.bytes, vec![2], "{found:?}");
        assert_eq!(found.reason, "Byte 2 takes new values");

        let detail = compare_bytes(first_id(&a), first_id(&b), rules);
        let ignored: Vec<_> = detail
            .ignored
            .iter()
            .map(|i| (i.byte, i.mask, i.kind))
            .collect();
        assert_eq!(
            ignored,
            vec![
                (6, 0x0F, IgnoredKind::Counter),
                (7, 0xFF, IgnoredKind::Checksum)
            ]
        );
        assert_eq!(detail.bit_scores[7 * 8..64], [0.0; 8]);
    }

    #[test]
    fn counters_must_count_in_both_logs_to_be_ignored() {
        let a = counted(200, 0, None);
        // B's byte 6 holds still: the counter stopped, which is a real difference.
        let b = store(
            &(0..200)
                .map(|i| {
                    (
                        i as f64 / 10.0,
                        "can0",
                        0x3E9,
                        vec![0x11, 0x22, 0, 0, 0, 0, 3, 0],
                    )
                })
                .collect::<Vec<_>>(),
        );
        let rules = Options {
            ignore_counters: true,
            ..NO_RULES
        };
        let found = &compare_logs(&a, &b, rules)[0];
        assert!(found.bytes.contains(&6), "{found:?}");
    }

    #[test]
    fn changes_within_a_alone_can_be_ignored() {
        // Byte 1 drifts through A and has moved on again in B; byte 4 only changes in B.
        let drift =
            |offset: u8| move |_: usize, t: f64| vec![0, offset + (t / 10.0) as u8, 0, 0, 0];
        let a = store(&periodic(0x5A0, 10.0, 30.0, drift(10)));
        let b = store(&periodic(0x5A0, 10.0, 30.0, |i, t| {
            let mut p = drift(20)(i, t);
            p[4] = u8::from(t > 15.0);
            p
        }));
        let rules = Options {
            ignore_changes_within_a: true,
            ..NO_RULES
        };
        let raw = &compare_logs(&a, &b, NO_RULES)[0];
        assert!(raw.bytes.contains(&1) && raw.bytes.contains(&4), "{raw:?}");
        let found = &compare_logs(&a, &b, rules)[0];
        assert_eq!(found.bytes, vec![4], "{found:?}");

        let drifting = store(&periodic(0x5A0, 10.0, 30.0, drift(10)));
        let only_drift = store(&periodic(0x5A0, 10.0, 30.0, drift(20)));
        let ignored = &compare_logs(&drifting, &only_drift, rules)[0];
        assert_eq!(ignored.reason, "Also changes within A");
        assert!(ignored.score < 10);
    }

    #[test]
    fn single_bus_logs_match_whatever_their_bus_is_called() {
        let a = store(&periodic(0x100, 10.0, 5.0, quiet));
        let b = store(
            &periodic(0x100, 10.0, 5.0, quiet)
                .into_iter()
                .map(|(t, _, id, p)| (t, "vcan0", id, p))
                .collect::<Vec<_>>(),
        );
        let found = compare_logs(&a, &b, NO_RULES);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].bus, "can0");
        assert_eq!(found[0].presence, Presence::Both);
    }

    #[test]
    fn identical_logs_look_the_same() {
        let frames = periodic(0x123, 50.0, 20.0, |i, t| {
            vec![(i % 16) as u8, (t * 3.0) as u8, (i * 37 % 251) as u8, 0]
        });
        let (a, b) = (store(&frames), store(&frames));
        for options in [
            NO_RULES,
            Options {
                ignore_counters: true,
                ignore_changes_within_a: true,
            },
        ] {
            let found = &compare_logs(&a, &b, options)[0];
            assert_eq!(found.score, 0);
            assert!(
                found.reason == "No significant changes" || found.reason == "Also changes within A"
            );
        }
    }

    /// Ten frames of 450 a tenth of a second apart, byte 3 set from frame `set_from` on, then
    /// one frame of `last_id`.
    fn candump(t0: u32, set_from: usize, last_id: &str) -> String {
        let mut log: String = (0..10)
            .map(|i| {
                let byte3 = u8::from(i >= set_from);
                format!("({t0}.{i}00000) can0 450#000000{byte3:02X}00000000\n")
            })
            .collect();
        log.push_str(&format!("({t0}.950000) can0 {last_id}#00\n"));
        log
    }

    fn session() -> Session {
        let mut s = Session::new();
        s.set_file_name("idle.log");
        s.push_chunk(candump(100, 10, "0C9").as_bytes());
        s.finish();
        s
    }

    fn open_b(s: &mut Session) -> serde_json::Value {
        let log = candump(200, 1, "123");
        s.compare_begin("door-lock.log", log.len() as f64);
        s.compare_push_chunk(log.as_bytes()).unwrap();
        serde_json::from_str(&s.compare_finish().unwrap()).unwrap()
    }

    #[test]
    fn the_session_holds_log_b_beside_the_open_log() {
        let mut s = session();
        assert_eq!(s.compare_log_info(), None);
        assert_eq!(s.compare_logs("{}").unwrap(), "[]");
        let info = open_b(&mut s);
        assert_eq!(info["frames"], 11);
        let again: serde_json::Value =
            serde_json::from_str(&s.compare_log_info().unwrap()).unwrap();
        assert_eq!(again["frames"], 11);

        let found: serde_json::Value =
            serde_json::from_str(&s.compare_logs(r#"{"ignoreCounters":true}"#).unwrap()).unwrap();
        let body = found
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == 0x450)
            .unwrap();
        assert_eq!(body["reason"], "Byte 3 takes new values");
        assert_eq!(body["keyA"], id_key(0, 0x450));
        assert_eq!(body["bus"], "can0");

        let detail: serde_json::Value = serde_json::from_str(
            &s.compare_bytes(id_key(0, 0x450) as f64, id_key(0, 0x450) as f64, "{}")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(detail["newValues"][3], serde_json::json!([1]));

        let key_b = id_key(0, 0x450) as f64;
        assert_eq!(s.compare_frame_at(key_b, 0.0), vec![0; 8]);
        assert_eq!(
            s.compare_frame_at(key_b, 0.15),
            vec![0, 0, 0, 1, 0, 0, 0, 0]
        );
        assert_eq!(
            s.compare_frame_at(key_b, -5.0),
            vec![0; 8],
            "before the first frame"
        );
        let lanes = s.compare_byte_lanes(key_b, 3, 1, 0.0, 0.2, 10);
        assert_eq!(lanes, vec![4.0, 0.0, 0.1, 0.2, 0.3, 0.0, 1.0, 1.0, 1.0]);

        s.close_compare_log();
        assert_eq!(s.compare_log_info(), None);
        assert!(s.compare_frame_at(key_b, 0.0).is_empty());
    }

    #[test]
    fn swapping_makes_log_b_the_open_log() {
        let mut s = session();
        open_b(&mut s);
        s.decode_raw(
            id_key(0, 0x450) as f64,
            r#"{"startBit":0,"size":8,"byteOrder":"intel","signed":false,"factor":1,"offset":0}"#,
        )
        .unwrap();
        let every = r#"{"channels":null,"keys":null,"kinds":null,"rules":[],"combine":"all","t0":null,"t1":null}"#;
        assert!(s.set_trace_filter(every).unwrap() > 0);
        let info: serde_json::Value = serde_json::from_str(&s.swap_compare_log().unwrap()).unwrap();
        assert_eq!(
            s.row_count(-2.0),
            0,
            "the filtered rows were the old open log's"
        );
        assert_eq!(info["frames"], 11);
        assert!(s.store.id_stats(id_key(0, 0x123)).is_some());
        assert!(
            s.series.is_empty(),
            "series of the old open log are dropped"
        );
        let b: serde_json::Value = serde_json::from_str(&s.compare_log_info().unwrap()).unwrap();
        assert_eq!(b["frames"], 11);
        let found: serde_json::Value =
            serde_json::from_str(&s.compare_logs("{}").unwrap()).unwrap();
        let gone = found
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == 0x0C9)
            .unwrap();
        assert_eq!(gone["reason"], "Appears only in B");
    }

    #[test]
    fn a_capture_drops_log_b_and_cannot_be_swapped() {
        let mut s = session();
        open_b(&mut s);
        s.start_capture("can0", 0.0);
        assert_eq!(s.compare_log_info(), None);
        s.finish_capture().unwrap();
        open_b(&mut s);
        assert_eq!(
            s.swap_logs(),
            Err("a capture can't be swapped; save it and open the file instead")
        );
        assert_eq!(s.store.len(), 0, "the capture stays the open log");
        assert!(s.compare_log_info().is_some());
    }

    #[test]
    fn names_come_from_the_databases_for_the_bus() {
        let mut s = session();
        open_b(&mut s);
        let db = serde_json::json!([{ "channel": null, "db": {
            "name": "body.dbc",
            "messages": [{ "id": 0x123, "name": "LOCKS", "size": 1, "transmitter": null,
                           "comment": null, "signals": [] }]
        }}]);
        s.set_databases(&db.to_string()).unwrap();
        let found: serde_json::Value =
            serde_json::from_str(&s.compare_logs("{}").unwrap()).unwrap();
        let locks = found
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == 0x123)
            .unwrap();
        assert_eq!(locks["name"], "LOCKS");
        assert_eq!(locks["presence"], "onlyB");
    }

    const DEFAULTS: Options = Options {
        ignore_counters: true,
        ignore_changes_within_a: true,
    };

    const COUNTERS_ONLY: Options = Options {
        ignore_counters: true,
        ignore_changes_within_a: false,
    };

    /// Sensor noise around 100, the same distribution for every seed: a sum of four small
    /// pseudo-random steps.
    fn noise(i: usize, seed: u64) -> u8 {
        let mut x = (i as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ seed;
        let mut sum = 100i32;
        for _ in 0..4 {
            x ^= x >> 29;
            x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
            sum += (x >> 61) as i32 - 3;
        }
        sum as u8
    }

    #[test]
    fn sensor_noise_is_no_difference() {
        let a = store(&periodic(0x200, 100.0, 60.0, |i, _| {
            vec![0x10, noise(i, 1)]
        }));
        let b = store(&periodic(0x200, 100.0, 10.0, |i, _| {
            vec![0x10, noise(i, 2)]
        }));
        for options in [NO_RULES, COUNTERS_ONLY, DEFAULTS] {
            let found = &compare_logs(&a, &b, options)[0];
            assert!(found.score < 10, "{options:?}: {found:?}");
        }
    }

    /// A reading that rises one step every 6 s, from `start` seconds into the drive.
    fn rising(start: f64) -> impl Fn(usize, f64) -> Vec<u8> {
        move |_, t| vec![0, 0, 0x40 + ((start + t) / 6.0) as u8, 0]
    }

    #[test]
    fn a_reading_drifting_on_scores_low() {
        let a = store(&periodic(0x3E9, 20.0, 180.0, rising(0.0)));
        let b = store(&periodic(0x3E9, 20.0, 180.0, rising(180.0)));
        let raw = &compare_logs(&a, &b, NO_RULES)[0];
        assert!(raw.score <= 50, "{raw:?}");
        assert!(!raw.reason.contains("new values"), "{raw:?}");
        let found = &compare_logs(&a, &b, DEFAULTS)[0];
        assert!(found.score < 10, "{found:?}");
        assert_eq!(found.reason, "Also changes within A");
    }

    #[test]
    fn a_short_log_b_is_not_all_different() {
        let drive = |i: usize, t: f64| {
            vec![
                [1, 2, 3][(t / 20.0) as usize % 3],
                (60.0 + 40.0 * (t / 30.0).sin()) as u8,
                noise(i, 7),
            ]
        };
        let a = store(&periodic(0x1F5, 50.0, 180.0, drive));
        let b = store(&periodic(0x1F5, 50.0, 2.0, drive));
        for options in [NO_RULES, COUNTERS_ONLY, DEFAULTS] {
            let found = &compare_logs(&a, &b, options)[0];
            assert!(found.score < 10, "{options:?}: {found:?}");
        }
    }

    #[test]
    fn an_id_with_too_few_frames_is_not_scored() {
        let a = store(&periodic(0x300, 1.0, 60.0, |i, _| {
            vec![50 + (i % 10) as u8]
        }));
        let b = store(&periodic(0x300, 1.0, 3.0, |_, _| vec![99]));
        let found = &compare_logs(&a, &b, NO_RULES)[0];
        assert_eq!(
            (found.score, found.reason.as_str()),
            (0, "Too few frames to compare")
        );
        assert!(found.bytes.is_empty());
        let detail = compare_bytes(first_id(&a), first_id(&b), NO_RULES);
        assert_eq!(detail.byte_reasons, vec!["Too few frames to compare"]);
        assert_eq!(detail.byte_scores, vec![0]);
    }

    #[test]
    fn a_one_off_lock_ranks_first() {
        // Three minutes of driving each: an odometer and a coolant reading drift on, a sensor
        // is noisy, and in B the doors lock once, setting a bit for nine frames.
        let drive = |offset: f64, lock: Option<f64>| {
            let mut frames = periodic(0x3E9, 20.0, 180.0, rising(offset));
            frames.extend(periodic(0x0C9, 100.0, 180.0, move |_, t| {
                vec![0, 0, 0, 0x3C + ((offset + t) / 12.0) as u8]
            }));
            frames.extend(periodic(0x200, 100.0, 180.0, move |i, _| {
                vec![0x10, noise(i, offset as u64)]
            }));
            frames.extend(periodic(0x450, 10.0, 180.0, move |_, t| {
                let locked = lock.is_some_and(|at| (at..at + 0.9).contains(&t));
                vec![0, 0, 0, u8::from(locked), 0, 0, 0, 0]
            }));
            store(&frames)
        };
        let (a, b) = (drive(0.0, None), drive(180.0, Some(60.0)));
        for options in [COUNTERS_ONLY, DEFAULTS] {
            let found = compare_logs(&a, &b, options);
            assert_eq!(found[0].id, 0x450, "{options:?}: {found:?}");
            assert_eq!(found[0].reason, "Byte 3 takes new values");
            assert!(found[0].score >= 75, "{:?}", found[0]);
            assert!(
                found[1].score + 25 <= found[0].score,
                "{options:?}: {found:?}"
            );
        }
        let detail = compare_bytes(
            Some(Side {
                store: &a,
                stats: a.id_stats(id_key(0, 0x450)).unwrap(),
            }),
            Some(Side {
                store: &b,
                stats: b.id_stats(id_key(0, 0x450)).unwrap(),
            }),
            DEFAULTS,
        );
        let marked: Vec<usize> = (0..64).filter(|&i| detail.bit_scores[i] >= 0.1).collect();
        assert_eq!(marked, vec![3 * 8], "only the lock bit is called out");
    }

    /// A counter in byte 1's low nibble, with a state in bit 7 from `from` to `to` seconds.
    fn nibble_counter_and_state(from: f64, to: f64) -> FrameStore {
        store(&periodic(0x3E9, 50.0, 60.0, |i, t| {
            let state = if (from..to).contains(&t) { 0x80 } else { 0 };
            vec![0x11, (i % 16) as u8 | state, 0, 0]
        }))
    }

    #[test]
    fn a_state_bit_beside_a_nibble_counter_is_kept() {
        let a = nibble_counter_and_state(0.0, 0.0);
        let b = nibble_counter_and_state(30.0, 31.0);
        let found = &compare_logs(&a, &b, DEFAULTS)[0];
        assert_eq!(found.reason, "Byte 1 takes new values", "{found:?}");
        let detail = compare_bytes(first_id(&a), first_id(&b), DEFAULTS);
        assert_eq!(
            detail.ignored,
            vec![Ignored {
                byte: 1,
                mask: 0x0F,
                kind: IgnoredKind::Counter
            }]
        );
        assert!(detail.bit_scores[8 + 7] >= 0.5);

        // Held for longer in B than in A, it still shows.
        let a = nibble_counter_and_state(10.0, 12.0);
        let b = nibble_counter_and_state(10.0, 50.0);
        let found = &compare_logs(&a, &b, COUNTERS_ONLY)[0];
        assert_eq!(found.bytes, vec![1], "{found:?}");
    }

    #[test]
    fn a_byte_that_mirrors_another_is_no_checksum() {
        // Byte 7 repeats the state in byte 0; B shows a state A never does.
        let mirrored = |states: &'static [u8]| {
            store(&periodic(0x333, 10.0, 60.0, move |i, _| {
                let s = states[i / 20 % states.len()];
                vec![s, 0x40, 0, 0, 0, 0, 0, s]
            }))
        };
        let (a, b) = (mirrored(&[1, 2, 3, 4]), mirrored(&[1, 2, 3, 4, 9]));
        let detail = compare_bytes(first_id(&a), first_id(&b), DEFAULTS);
        assert!(detail.ignored.is_empty(), "{:?}", detail.ignored);
        let found = &compare_logs(&a, &b, DEFAULTS)[0];
        assert_eq!(found.bytes, vec![0, 7], "{found:?}");
        assert_eq!(detail.new_values[0], vec![9]);
    }

    #[test]
    fn buses_named_differently_match_by_order() {
        let on = |frames: Vec<(f64, &'static str, u32, Vec<u8>)>, buses: [&'static str; 2]| {
            frames
                .into_iter()
                .map(|(t, bus, id, p)| (t, if bus == "can0" { buses[0] } else { buses[1] }, id, p))
                .collect::<Vec<_>>()
        };
        let mut frames = periodic(0x100, 10.0, 5.0, quiet);
        frames.extend(
            periodic(0x200, 10.0, 5.0, quiet)
                .into_iter()
                .map(|(t, _, id, p)| (t, "can1", id, p)),
        );
        let a = store(&frames);
        let b = store(&on(frames.clone(), ["vcan0", "vcan1"]));
        let found = compare_logs(&a, &b, DEFAULTS);
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|c| c.presence == Presence::Both));
        let first = find(&found, 0x100);
        assert_eq!(
            (first.bus.as_str(), first.bus_b.as_deref()),
            ("can0", Some("vcan0"))
        );

        // One bus name in common: names are taken as they are.
        let c = store(&on(frames, ["can0", "vcan1"]));
        let found = compare_logs(&a, &c, DEFAULTS);
        assert_eq!(find(&found, 0x200).presence, Presence::OnlyA);
    }

    #[test]
    fn a_change_to_can_fd_is_reported() {
        let mut b = FrameStore::new();
        let channel = b.channel_index(b"can0");
        for i in 0..100 {
            b.push(FrameRef {
                ts_ns: 100 * S + i * S / 10,
                channel,
                id: 0x300,
                flags: flags::FD,
                data: &[0x10, 0x20, 0, 0, 0, 0, 0, 0],
            });
        }
        let a = store(&periodic(0x300, 10.0, 10.0, quiet));
        let found = &compare_logs(&a, &b, DEFAULTS)[0];
        assert_eq!(found.reason, "Changes from classic CAN to CAN FD");
        assert_eq!(found.score, 90);
    }

    #[test]
    fn a_log_of_no_duration_has_no_rate() {
        let a = store(&periodic(0x100, 10.0, 10.0, quiet));
        let b = store(
            &periodic(0x100, 10.0, 10.0, quiet)
                .into_iter()
                .map(|(_, bus, id, p)| (0.0, bus, id, p))
                .collect::<Vec<_>>(),
        );
        let found = &compare_logs(&a, &b, DEFAULTS)[0];
        assert_eq!(found.rate_b, None);
        assert!(found.rate_a.is_some());
        assert!(!found.reason.starts_with("Rate"), "{found:?}");
    }

    #[test]
    fn a_log_b_too_large_for_memory_is_refused() {
        let mut input = LogInput {
            file_name: "big.log".to_owned(),
            total_bytes: 1e9,
            limit: Some(1 << 20),
            ..LogInput::default()
        };
        let mut store = FrameStore::new();
        input.push(candump(100, 10, "0C9").repeat(20).as_bytes(), &mut store);
        assert!(input.refused);
        assert!(store.is_empty());

        // The same log fits when it is small.
        let mut session = session();
        let log = candump(200, 1, "123");
        session.compare_begin("small.log", log.len() as f64);
        assert!(session.compare_push_chunk(log.as_bytes()).is_ok());
        assert!(session.compare_finish().is_ok());
    }
}
