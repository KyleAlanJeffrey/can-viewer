//! Compare two logs: log A, the open log, and log B, a second log opened to compare against it.
//! IDs are matched by bus name and ID, and each one is scored from 0 to 100 by how differently
//! it behaves in the two logs, with a short reason. API.md documents the scoring under
//! `compareLogs`; in short:
//!
//! - An ID in only one log scores 100.
//! - Rates are frames per second of each log's duration, so logs of different lengths compare.
//!   A rate ratio from 1.1 up to 2 scores 0 up to 80.
//! - A different payload length scores 90.
//! - A payload byte scores the largest of, per bit, the change in the share of frames with the
//!   bit set and in the share of frames where it toggles (0 to 1), 0.75 for a bit constant in
//!   one log only, and 0.75 to 1 when a byte that takes at most 16 values in one log takes
//!   values there that it never takes in the other.
//! - The ID scores its largest component.
//!
//! Ignore rules leave out bits that behave like a counter or checksum in both logs, and
//! subtract from each component what it scores between the first and second halves of log A.

use std::collections::BTreeMap;

use can_core::{FrameStore, IdKey, IdStats, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{byte_lanes_in, js_err, log_info_json, ns_in, to_json, LogInput, Session};

/// Below this score (0 to 1) an ID or byte shows no significant difference.
pub const SIGNIFICANT: f64 = 0.1;
/// A byte that takes at most this many values is a state, where any new value matters.
const STATE_VALUES: usize = 16;
/// Ratio of rates that scores nothing, and the share of the rate score a doubling reaches.
const RATE_TOLERANCE: f64 = 1.1;
const RATE_WEIGHT: f64 = 0.8;
const LENGTH_SCORE: f64 = 0.9;
/// What a bit constant in one log only, or a state byte's new value, scores at least.
const QUALITATIVE: f64 = 0.75;
/// A reason that names a byte reads "Small value changes" below this score.
const SMALL: f64 = 0.35;

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
    /// Without the extended flag; error frames are left out.
    pub id: u32,
    pub extended: bool,
    pub key_a: Option<IdKey>,
    pub key_b: Option<IdKey>,
    pub presence: Presence,
    pub name: Option<String>,
    pub frames_a: u32,
    pub frames_b: u32,
    /// Frames per second of the log's duration.
    pub rate_a: f64,
    pub rate_b: f64,
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
    /// Up to 16 values of each byte that log B shows and log A never does, ignored bits cleared.
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
        bytes: vec![ByteProfile::new(); len],
        full_frames: 0,
        sum_first: [0; 256],
        sum_last: [0; 256],
        xor_all: [0; 256],
    };
    let mut prev: &[u8] = &[];
    for &index in frames {
        let data = store.frame(index as usize).data;
        let data = &data[..data.len().min(len)];
        p.frames += 1;
        p.max_len = p.max_len.max(data.len());
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
/// first or last byte when it is the sum or XOR of the others plus a constant, or looks like a
/// CRC.
fn counters_and_checksums(p: &Profile) -> (Vec<u8>, Vec<u8>) {
    let len = p.bytes.len();
    let mut counter = vec![0u8; len];
    let mut checksum = vec![0u8; len];
    for (k, b) in p.bytes.iter().enumerate() {
        let pairs = b.pairs();
        let mut low_steps = [0u32; 16];
        for (step, &n) in b.steps.iter().enumerate() {
            low_steps[step & 15] += n;
        }
        // More values than a nibble holds, so not a nibble counter with a constant beside it.
        if counts_up(&b.steps, pairs) && distinct(&b.values, 0xFF) > 16 {
            counter[k] = 0xFF;
            continue;
        }
        if counts_up(&low_steps, pairs) && distinct(&b.values, 0x0F) >= 4 {
            counter[k] |= 0x0F;
        }
        if counts_up(&b.high_steps, pairs) && distinct(&b.values, 0xF0) >= 4 {
            counter[k] |= 0xF0;
        }
    }
    if len >= 2 {
        let ends = [(0, &p.sum_first), (len - 1, &p.sum_last)];
        let varies = |k: usize| distinct(&p.bytes[k].values, 0xFF) >= 4;
        for (k, hist) in ends {
            if (mostly_constant(hist, p.full_frames) && varies(k)) || crc_like(&p.bytes[k]) {
                checksum[k] = 0xFF;
            }
        }
        if mostly_constant(&p.xor_all, p.full_frames) {
            if let Some(k) = [len - 1, 0].into_iter().find(|&k| varies(k)) {
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

struct ByteDiff {
    score: f64,
    reason: ByteReason,
    bits: [f64; 8],
    new_values: Vec<u8>,
}

fn masked(values: &[u32; 256], keep: u8) -> [u32; 256] {
    let mut out = [0; 256];
    for (v, &n) in values.iter().enumerate() {
        out[v & usize::from(keep)] += n;
    }
    out
}

/// How differently one byte behaves in `a` and `b`, over the bits in `keep`. None when either
/// log has no frame carrying it, or every bit is ignored.
fn byte_diff(a: &ByteProfile, b: &ByteProfile, keep: u8) -> Option<ByteDiff> {
    let (va, vb) = (masked(&a.values, keep), masked(&b.values, keep));
    let (na, nb) = (va.iter().sum::<u32>(), vb.iter().sum::<u32>());
    if keep == 0 || na == 0 || nb == 0 {
        return None;
    }
    let (na, nb) = (f64::from(na), f64::from(nb));
    let (pairs_a, pairs_b) = (f64::from(a.pairs()), f64::from(b.pairs()));
    let share = |n: u32, of: f64| if of > 0.0 { f64::from(n) / of } else { 0.0 };

    let mut best = (0.0, ByteReason::Shift);
    let mut consider = |score: f64, reason| {
        if score > best.0 {
            best = (score, reason);
        }
    };
    let mut bits = [0.0; 8];
    for (bit, out) in bits.iter_mut().enumerate() {
        if keep >> bit & 1 == 0 {
            continue;
        }
        let set = |v: &[u32; 256]| sum_where(v, |x| x >> bit & 1 == 1);
        let (ones_a, ones_b) = (set(&va), set(&vb));
        let set_change = (share(ones_a, na) - share(ones_b, nb)).abs();
        let (toggle_a, toggle_b) = (share(a.flips(bit), pairs_a), share(b.flips(bit), pairs_b));
        let constant = |ones: u32, n: f64| ones == 0 || f64::from(ones) == n;
        let (const_a, const_b) = (constant(ones_a, na), constant(ones_b, nb));
        let qualitative = if const_a == const_b { 0.0 } else { QUALITATIVE };
        *out = set_change.max((toggle_a - toggle_b).abs()).max(qualitative);
        consider(set_change, ByteReason::Shift);
        consider(
            (toggle_a - toggle_b).abs(),
            if toggle_b > toggle_a {
                ByteReason::ChangesMore
            } else {
                ByteReason::ChangesLess
            },
        );
        consider(
            qualitative,
            if const_a {
                ByteReason::NewValues
            } else {
                ByteReason::ValuesOnlyInA
            },
        );
    }

    let unseen_in = |seen: &[u32; 256], other: &[u32; 256]| {
        sum_where(other, |v| seen[v] == 0) // frames of `other` with a value `seen` lacks
    };
    let (novel_b, novel_a) = (unseen_in(&va, &vb), unseen_in(&vb, &va));
    let (distinct_a, distinct_b) = (distinct(&va, 0xFF), distinct(&vb, 0xFF));
    let novelty = |novel: u32, n: f64| QUALITATIVE + 0.25 * (4.0 * f64::from(novel) / n).min(1.0);
    if distinct_a <= STATE_VALUES && novel_b > 0 {
        consider(novelty(novel_b, nb), ByteReason::NewValues);
    }
    if distinct_b <= STATE_VALUES && novel_a > 0 {
        consider(novelty(novel_a, na), ByteReason::ValuesOnlyInA);
    }
    if distinct_a == 1 && distinct_b == 1 && va != vb {
        best.1 = ByteReason::DifferentValue;
    }

    let new_values = (0..=255u8)
        .filter(|&v| vb[usize::from(v)] > 0 && va[usize::from(v)] == 0)
        .take(16)
        .collect();
    Some(ByteDiff {
        score: best.0,
        reason: best.1,
        bits,
        new_values,
    })
}

/// Everything that differs between two profiles of one ID, before any baseline is subtracted.
struct Components {
    rate: f64,
    ratio: f64,
    length: f64,
    bytes: Vec<Option<ByteDiff>>,
}

fn rate_of(p: &Profile) -> f64 {
    if p.span_s > 0.0 {
        f64::from(p.frames) / p.span_s
    } else {
        f64::from(p.frames)
    }
}

fn rate_score(ratio: f64) -> f64 {
    let up = if ratio < 1.0 { 1.0 / ratio } else { ratio };
    if up.is_nan() {
        return 0.0;
    }
    RATE_WEIGHT * ((up - RATE_TOLERANCE) / (2.0 - RATE_TOLERANCE)).clamp(0.0, 1.0)
}

fn components(a: &Profile, b: &Profile, keep: &[u8]) -> Components {
    let (ra, rb) = (rate_of(a), rate_of(b));
    let ratio = if ra == rb { 1.0 } else { rb / ra };
    let common = a.bytes.len().min(b.bytes.len());
    Components {
        rate: rate_score(ratio),
        ratio,
        length: if a.max_len == b.max_len {
            0.0
        } else {
            LENGTH_SCORE
        },
        bytes: (0..common)
            .map(|k| {
                byte_diff(
                    &a.bytes[k],
                    &b.bytes[k],
                    keep.get(k).copied().unwrap_or(0xFF),
                )
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Finding {
    Rate(f64),
    Length(usize, usize),
    Byte(usize, ByteReason),
}

/// One ID judged: its score and reason after the baseline, and each byte's adjusted score.
struct Verdict {
    score: f64,
    reason: String,
    byte_scores: Vec<f64>,
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
    let less = |score: f64, baseline: Option<f64>| (score - baseline.unwrap_or(0.0)).max(0.0);
    let byte_scores: Vec<f64> = ab
        .bytes
        .iter()
        .enumerate()
        .map(|(k, d)| {
            let baseline = noise.and_then(|n| n.bytes.get(k)?.as_ref().map(|d| d.score));
            d.as_ref().map_or(0.0, |d| less(d.score, baseline))
        })
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
        if let Some(d) = d {
            consider(d.score, byte_scores[k], Finding::Byte(k, d.reason));
        }
    }
    consider(
        ab.length,
        less(ab.length, noise.map(|n| n.length)),
        Finding::Length(a.max_len, b.max_len),
    );
    consider(
        ab.rate,
        less(ab.rate, noise.map(|n| n.rate)),
        Finding::Rate(ab.ratio),
    );

    let (score, reason) = match best {
        Some((score, finding)) if score >= SIGNIFICANT => (
            score,
            match finding {
                Finding::Byte(k, reason) => byte_reason_text(k, reason, score),
                Finding::Length(from, to) => format!("Length changes from {from} to {to} bytes"),
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

/// What each of B's channels is called for matching: its own name, except that the buses of
/// two single-bus logs always match, whatever each log calls its bus.
fn b_bus_names(a: &FrameStore, b: &FrameStore) -> Vec<String> {
    match (a.channels(), b.channels()) {
        ([only_a], [_]) => vec![only_a.clone()],
        (_, names) => names.to_vec(),
    }
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
    let rate = |frames: usize, dur: f64| {
        if dur > 0.0 {
            frames as f64 / dur
        } else {
            frames as f64
        }
    };

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
            bit_scores[k * 8..k * 8 + 8].copy_from_slice(&d.bits);
            let score = verdict.byte_scores[k];
            byte_scores[k] = percent(score);
            byte_reasons[k] = if score >= SIGNIFICANT {
                byte_reason_text(k, d.reason, score)
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
    /// [`Session::compare_finish`].
    pub fn compare_begin(&mut self, name: &str, total_bytes: f64) {
        self.log_b = None;
        let mut log = LogB::default();
        log.input.file_name = name.to_owned();
        log.input.total_bytes = total_bytes;
        self.log_b = Some(log);
    }

    pub fn compare_push_chunk(&mut self, chunk: &[u8]) {
        if let Some(log) = &mut self.log_b {
            log.input.push(chunk, &mut log.store);
        }
    }

    /// Flush log B's parser and return its JSON `LogInfo`.
    pub fn compare_finish(&mut self) -> Result<String, JsError> {
        let log = self
            .log_b
            .as_mut()
            .ok_or_else(|| js_err("no second log is being read"))?;
        log.input.finish(&mut log.store);
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
        let log = match &mut self.log_b {
            Some(log) if log.finished => log,
            _ => return Err(js_err("there is no second log to swap with")),
        };
        std::mem::swap(&mut self.store, &mut log.store);
        std::mem::swap(&mut self.input, &mut log.input);
        self.series.clear();
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

fn side_of(store: &FrameStore, key: f64) -> Option<Side<'_>> {
    let stats = store.id_stats(key as IdKey).filter(|_| key >= 0.0)?;
    Some(Side { store, stats })
}

impl Session {
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
        assert!((body.rate_a - 10.0).abs() < 0.1 && (body.rate_b - 10.0).abs() < 0.1);

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

    /// A message with a 4-bit counter in byte 6's low nibble, an XOR checksum in byte 7, and a
    /// state in byte 2 that only B sets. Log A is short, so its counter never wraps.
    fn counted(frames: usize, offset: usize, state_from: Option<usize>) -> FrameStore {
        let frames: Vec<_> = (0..frames)
            .map(|i| {
                let n = i + offset;
                let mut p = vec![0x11, 0x22, 0, 0, 0, 0, (n % 16) as u8, 0];
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
        let a = counted(12, 0, None);
        let b = counted(200, 5, Some(100));
        let raw = &compare_logs(&a, &b, NO_RULES)[0];
        assert!(
            raw.bytes.contains(&6),
            "the counter takes values A never saw: {raw:?}"
        );
        assert!(raw.bytes.contains(&7), "and so does the checksum: {raw:?}");

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

    const LOG_A: &str = "\
(100.000000) can0 450#0000000000000000
(100.100000) can0 450#0000000000000000
(100.200000) can0 450#0000000000000000
(100.300000) can0 0C9#00
";
    const LOG_B: &str = "\
(200.000000) can0 450#0000000000000000
(200.100000) can0 450#0000000100000000
(200.200000) can0 450#0000000100000000
(200.300000) can0 123#00
";

    fn session() -> Session {
        let mut s = Session::new();
        s.set_file_name("idle.log");
        s.push_chunk(LOG_A.as_bytes());
        s.finish();
        s
    }

    fn open_b(s: &mut Session) -> serde_json::Value {
        s.compare_begin("door-lock.log", LOG_B.len() as f64);
        s.compare_push_chunk(LOG_B.as_bytes());
        serde_json::from_str(&s.compare_finish().unwrap()).unwrap()
    }

    #[test]
    fn the_session_holds_log_b_beside_the_open_log() {
        let mut s = session();
        assert_eq!(s.compare_log_info(), None);
        assert_eq!(s.compare_logs("{}").unwrap(), "[]");
        let info = open_b(&mut s);
        assert_eq!(info["frames"], 4);
        let again: serde_json::Value =
            serde_json::from_str(&s.compare_log_info().unwrap()).unwrap();
        assert_eq!(again["frames"], 4);

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
        assert_eq!(lanes, vec![3.0, 0.0, 0.1, 0.2, 0.0, 1.0, 1.0]);

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
        let info: serde_json::Value = serde_json::from_str(&s.swap_compare_log().unwrap()).unwrap();
        assert_eq!(info["frames"], 4);
        assert!(s.store.id_stats(id_key(0, 0x123)).is_some());
        assert!(
            s.series.is_empty(),
            "series of the old open log are dropped"
        );
        let b: serde_json::Value = serde_json::from_str(&s.compare_log_info().unwrap()).unwrap();
        assert_eq!(b["frames"], 4);
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
}
