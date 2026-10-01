//! Find Signal: rank bit ranges of the log's IDs by how well their value follows a description
//! of the wanted signal's behaviour over time.

use can_core::{FrameStore, IdKey, IdStats, ERR_FLAG, MAX_PAYLOAD};
use can_dbc_model::ByteOrder;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Behaviour {
    Increases,
    Decreases,
    Constant,
    Changes,
}

/// The signal does `behaviour` between two absolute timestamps.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub behaviour: Behaviour,
    pub t0_ns: i64,
    pub t1_ns: i64,
}

/// An unsigned bit range of a payload, in DBC conventions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BitRange {
    pub start_bit: u16,
    pub size: u16,
    pub byte_order: ByteOrder,
    /// Where the range's word starts in a [`Payload`].
    at: usize,
    shift: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Found {
    pub key: IdKey,
    pub range: BitRange,
    pub score: f64,
}

const PADDED: usize = MAX_PAYLOAD + 8;

/// A payload laid out so any range reads as one little-endian word: the payload padded to
/// `PADDED` bytes, then the same bytes reversed, where big-endian words read little-endian.
/// This keeps byte swaps, which wasm lacks an instruction for, out of the hot loop.
struct Payload([u8; 2 * PADDED]);

impl Payload {
    fn new() -> Self {
        Self([0; 2 * PADDED])
    }

    /// Only the first [`MAX_PAYLOAD`] bytes of a reassembled frame are searched.
    fn set(&mut self, data: &[u8]) {
        let data = &data[..data.len().min(MAX_PAYLOAD)];
        let (forward, reversed) = self.0.split_at_mut(PADDED);
        forward[..data.len()].copy_from_slice(data);
        for (r, &f) in reversed.iter_mut().zip(forward.iter().rev()) {
            *r = f;
        }
    }

    fn forward(&self) -> &[u8] {
        &self.0[..PADDED]
    }

    fn word(&self, at: usize) -> u64 {
        u64::from_le_bytes(
            *self.0[at..]
                .first_chunk()
                .expect("ranges start a word early enough"),
        )
    }
}

impl BitRange {
    fn intel(start_bit: u16, size: u16) -> Self {
        Self {
            start_bit,
            size,
            byte_order: ByteOrder::Intel,
            at: usize::from(start_bit / 8),
            shift: u32::from(start_bit % 8),
        }
    }

    /// `msb` counts from the most significant bit of byte 0, where big-endian ranges are
    /// contiguous.
    fn motorola(msb: u16, size: u16) -> Self {
        let byte = usize::from(msb / 8);
        Self {
            start_bit: msb / 8 * 8 + 7 - msb % 8,
            size,
            byte_order: ByteOrder::Motorola,
            // The reversed copy holds bytes `byte..byte + 8` as a little-endian word here.
            at: PADDED + MAX_PAYLOAD - byte,
            shift: 64 - u32::from(msb % 8 + size),
        }
    }

    fn mask(&self) -> u64 {
        (1 << self.size) - 1
    }

    fn read(&self, payload: &Payload) -> u64 {
        (payload.word(self.at) >> self.shift) & self.mask()
    }
}

/// Every 8- and 16-bit range that fits in `len` bytes, in both byte orders. A byte-aligned
/// 8-bit range reads the same in both orders, so only its Intel form is kept.
fn candidates(len: usize) -> Vec<BitRange> {
    let bits = (len * 8) as u16;
    let mut out = Vec::new();
    for size in [8, 16] {
        if size > bits {
            continue;
        }
        out.extend((0..=bits - size).map(|start| BitRange::intel(start, size)));
        out.extend(
            (0..=bits - size)
                .filter(|msb| size != 8 || msb % 8 != 0)
                .map(|msb| BitRange::motorola(msb, size)),
        );
    }
    out
}

#[derive(Debug, Clone, Copy)]
struct Tally {
    steps: u32,
    up: u32,
    down: u32,
}

impl Tally {
    /// See [`find_signal`].
    fn score(self, behaviour: Behaviour) -> f64 {
        let (up, down) = (f64::from(self.up), f64::from(self.down));
        let moves = up + down;
        match behaviour {
            Behaviour::Increases => (up - down).max(0.0) / (moves + 1.0),
            Behaviour::Decreases => (down - up).max(0.0) / (moves + 1.0),
            Behaviour::Changes => moves / f64::from(self.steps),
            Behaviour::Constant => 1.0 - moves / f64::from(self.steps),
        }
    }
}

/// Rises and falls of each range between consecutive `frames` (at least two).
fn tally(store: &FrameStore, frames: &[u32], ranges: &[BitRange]) -> Vec<Tally> {
    let steps = (frames.len() - 1) as u32;
    let mut tallies = vec![
        Tally {
            steps,
            up: 0,
            down: 0
        };
        ranges.len()
    ];
    let data = |f: u32| store.frame(f as usize).data;

    // A cheap first pass finds which bits ever change, so ranges that never do skip the
    // per-frame pass.
    let mut payload = Payload::new();
    payload.set(data(frames[0]));
    let mut changed = [0u8; PADDED];
    let mut prev = [0u8; PADDED];
    prev.copy_from_slice(payload.forward());
    for &f in &frames[1..] {
        payload.set(data(f));
        for ((c, p), &b) in changed.iter_mut().zip(&mut prev).zip(payload.forward()) {
            *c |= *p ^ b;
            *p = b;
        }
    }
    let mut changed_bits = Payload::new();
    changed_bits.set(&changed);
    let moving: Vec<usize> = (0..ranges.len())
        .filter(|&i| ranges[i].read(&changed_bits) != 0)
        .collect();
    if moving.is_empty() {
        return tallies;
    }

    struct Track {
        at: usize,
        shift: u32,
        mask: u64,
        last: u64,
        up: u32,
        down: u32,
    }
    payload.set(data(frames[0]));
    let mut tracks: Vec<Track> = moving
        .iter()
        .map(|&i| {
            let range = ranges[i];
            Track {
                at: range.at,
                shift: range.shift,
                mask: range.mask(),
                last: range.read(&payload),
                up: 0,
                down: 0,
            }
        })
        .collect();
    for &f in &frames[1..] {
        payload.set(data(f));
        for t in &mut tracks {
            let v = (payload.word(t.at) >> t.shift) & t.mask;
            t.up += u32::from(v > t.last);
            t.down += u32::from(v < t.last);
            t.last = v;
        }
    }
    for (&i, t) in moving.iter().zip(tracks) {
        tallies[i].up = t.up;
        tallies[i].down = t.down;
    }
    tallies
}

fn score_id(store: &FrameStore, stats: &IdStats, rules: &[Rule], out: &mut Vec<Found>) {
    let mut windows: Vec<(Behaviour, &[u32])> = rules
        .iter()
        .map(|r| {
            let range = store.id_frames_between(stats, r.t0_ns, r.t1_ns);
            (r.behaviour, &stats.frames[range])
        })
        .collect();
    if windows.iter().any(|(_, frames)| frames.len() < 2) {
        return;
    }
    // Smallest windows first, so ranges that score 0 there skip the bigger ones.
    windows.sort_by_key(|(_, frames)| frames.len());

    // Ranges must fit every frame of the ID.
    let mut ranked: Vec<(BitRange, f64)> = candidates(usize::from(stats.min_len).min(MAX_PAYLOAD))
        .into_iter()
        .map(|range| (range, 1.0))
        .collect();
    for (behaviour, frames) in windows {
        if ranked.is_empty() {
            return;
        }
        let ranges: Vec<BitRange> = ranked.iter().map(|&(range, _)| range).collect();
        for ((_, score), t) in ranked.iter_mut().zip(tally(store, frames, &ranges)) {
            *score *= t.score(behaviour);
        }
        ranked.retain(|&(_, score)| score > 0.0);
    }
    out.extend(ranked.into_iter().map(|(range, score)| Found {
        key: stats.key(),
        range,
        score,
    }));
}

/// Ranks the 8- and 16-bit unsigned ranges of `keys` (every ID but error frames when empty) by
/// how well their value follows every rule, best first, and keeps the top `limit` that score
/// above 0.
///
/// A rule looks at the `n` steps between consecutive frames of the ID inside its window: `up`
/// of them raise the value, `down` lower it, and `moves = up + down`. It scores
///
/// - increases: `(up - down) / (moves + 1)`, or 0 if negative. A clean ramp or counter scores
///   near 1 and noise near 0; the `+ 1` makes a value that moved only once (a status bit)
///   score 1/2.
/// - decreases: `(down - up) / (moves + 1)`, or 0 if negative.
/// - changes: `moves / n`, the fraction of frames that differ from the one before.
/// - constant: `1 - moves / n`, so 1 when the value never changes.
///
/// A window holding fewer than two frames of the ID scores 0. A range's score is the product of
/// its rule scores. Ties go to the narrower range: a counter byte ties with the 16-bit ranges
/// pairing it with a constant byte.
#[must_use]
pub fn find_signal(store: &FrameStore, rules: &[Rule], keys: &[IdKey], limit: usize) -> Vec<Found> {
    if rules.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut found = Vec::new();
    if keys.is_empty() {
        for stats in store.ids().iter().filter(|s| s.id & ERR_FLAG == 0) {
            score_id(store, stats, rules, &mut found);
        }
    } else {
        for stats in keys.iter().filter_map(|&key| store.id_stats(key)) {
            score_id(store, stats, rules, &mut found);
        }
    }
    // Stable: ties of the same size stay in ID order, then candidate order.
    found.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.range.size.cmp(&b.range.size))
    });
    found.truncate(limit);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use can_core::{id_key, FrameRef, FrameSink};
    use can_dbc_model::bits;

    #[test]
    fn ranges_read_like_the_dbc_decoder() {
        let mut rng = 0x2545_F491_4F6C_DD1Du64;
        let mut data = [0u8; MAX_PAYLOAD];
        for b in &mut data {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            *b = rng as u8;
        }
        let mut payload = Payload::new();
        payload.set(&data);
        let ranges = candidates(MAX_PAYLOAD);
        assert_eq!(ranges.len(), (505 + 497) * 2 - 64);
        for range in ranges {
            assert_eq!(
                Some(range.read(&payload)),
                bits::extract(&data, range.start_bit, range.size, range.byte_order),
                "{range:?}"
            );
        }
        assert_eq!(candidates(32).len(), (249 + 241) * 2 - 32);
        assert_eq!(candidates(1).len(), 1);
        assert_eq!(candidates(2).len(), 9 + 7 + 1 + 1);
        assert!(candidates(0).is_empty());
    }

    const MS: i64 = 1_000_000;

    /// 100 Hz for 20 s. 0x100: byte 0 a wrapping counter, byte 1 noise, bytes 2-3 a big-endian
    /// value that holds for 10 s then ramps up, the rest constant. 0x200: a status bit (byte 1
    /// bit 0) that switches on at 5 s.
    fn store() -> FrameStore {
        let mut store = FrameStore::new();
        let mut rng = 0x9E37_79B9_7F4A_7C15u64;
        for i in 0..2000u32 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let ramp = (5000 + i.saturating_sub(1000) * 50) as u16;
            let mut data = [i as u8, rng as u8, 0, 0, 0xAA, 0, 0, 0x55];
            data[2..4].copy_from_slice(&ramp.to_be_bytes());
            store.push(FrameRef {
                ts_ns: i64::from(i) * 10 * MS,
                channel: 0,
                id: 0x100,
                flags: 0,
                data: &data,
            });
            let status = [0, u8::from(i >= 500), 0, 0];
            store.push(FrameRef {
                ts_ns: i64::from(i) * 10 * MS + 5 * MS,
                channel: 0,
                id: 0x200,
                flags: 0,
                data: &status,
            });
        }
        store
    }

    fn rule(behaviour: Behaviour, t0_s: i64, t1_s: i64) -> Rule {
        Rule {
            behaviour,
            t0_ns: t0_s * 1000 * MS,
            t1_ns: t1_s * 1000 * MS,
        }
    }

    fn describe(found: &Found) -> (IdKey, u16, u16, ByteOrder) {
        (
            found.key,
            found.range.start_bit,
            found.range.size,
            found.range.byte_order,
        )
    }

    #[test]
    fn a_counter_ranks_first_for_increases() {
        let store = store();
        // 9 s spans three wraps of the counter.
        let found = find_signal(&store, &[rule(Behaviour::Increases, 0, 9)], &[], 5);
        let key = id_key(0, 0x100);
        assert_eq!(describe(&found[0]), (key, 0, 8, ByteOrder::Intel));
        assert!(found[0].score > 0.99, "{:?}", found[0]);
        // The counter with the noise byte below it rises and wraps the same way.
        assert_eq!(describe(&found[1]), (key, 7, 16, ByteOrder::Motorola));
        assert_eq!(found[1].score, found[0].score);
        assert!(found[2].score < found[1].score);
        assert!(found.iter().all(|f| f.score > 0.0));
    }

    #[test]
    fn rules_combine_and_rank_the_ramp_and_the_status_bit() {
        let store = store();
        let hold_then_rise = [
            rule(Behaviour::Constant, 0, 9),
            rule(Behaviour::Increases, 11, 19),
        ];
        let found = find_signal(&store, &hold_then_rise, &[], 1000);
        assert_eq!(
            describe(&found[0]),
            (id_key(0, 0x100), 23, 16, ByteOrder::Motorola)
        );
        // The counter never holds still.
        assert!(!found
            .iter()
            .any(|f| f.range.start_bit == 0 && f.range.size == 8));

        let switched_on = [
            rule(Behaviour::Constant, 0, 4),
            rule(Behaviour::Increases, 4, 6),
            rule(Behaviour::Constant, 6, 20),
        ];
        let found = find_signal(&store, &switched_on, &[id_key(0, 0x200)], 100);
        assert_eq!(found[0].range.size, 8);
        assert!(found
            .iter()
            .all(|f| f.score == 0.5 && f.key == id_key(0, 0x200)));
        // Exactly the ranges holding bit 8: Intel and Motorola, 8 and 16 bits.
        assert_eq!(found.len(), 8 + 7 + 9 + 16);
    }

    #[test]
    fn error_frames_are_searched_only_when_asked_for() {
        let mut store = FrameStore::new();
        for i in 0..10u8 {
            store.push(FrameRef {
                ts_ns: i64::from(i) * 1000 * MS,
                channel: 0,
                id: 0x80 | ERR_FLAG,
                flags: can_core::flags::ERROR,
                data: &[i, 0, 0, 0, 0, 0, 0, 0],
            });
        }
        let rules = [rule(Behaviour::Increases, 0, 10)];
        assert!(find_signal(&store, &rules, &[], 10).is_empty());
        let key = id_key(0, 0x80 | ERR_FLAG);
        assert_eq!(find_signal(&store, &rules, &[key], 10)[0].key, key);
    }

    #[test]
    fn empty_windows_rules_and_limits_find_nothing() {
        let store = store();
        assert!(find_signal(&store, &[rule(Behaviour::Changes, 30, 40)], &[], 10).is_empty());
        assert!(find_signal(&store, &[], &[], 10).is_empty());
        assert!(find_signal(&store, &[rule(Behaviour::Changes, 0, 20)], &[], 0).is_empty());
        assert!(find_signal(&store, &[rule(Behaviour::Changes, 0, 20)], &[7], 10).is_empty());
    }
}
