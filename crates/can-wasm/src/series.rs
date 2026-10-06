use std::cell::OnceCell;

use can_core::FrameStore;

use pyramid::Pyramid;

mod pyramid;

/// Below this many points a bucket on average, scanning them is quicker than finding each
/// bucket's end and walking the pyramid (measured on the 10M-frame demo).
const PYRAMID_MIN_BUCKET_POINTS: usize = 32;

/// A decoded signal: timestamps in seconds from the start of the log, and physical values.
pub struct Series {
    t: Vec<f64>,
    v: Vec<f64>,
    /// Built by the first view that decimates; holds `None` when the times are out of order,
    /// as a capture's may be, or when the series was made [`Series::without_pyramid`].
    pyramid: OnceCell<Option<Pyramid>>,
}

impl Series {
    pub fn decode(
        store: &FrameStore,
        frames: &[u32],
        origin_ns: i64,
        mut value: impl FnMut(&[u8]) -> Option<f64>,
    ) -> Self {
        let mut t = Vec::with_capacity(frames.len());
        let mut v = Vec::with_capacity(frames.len());
        for &index in frames {
            let frame = store.frame(index as usize);
            if let Some(x) = value(frame.data) {
                t.push((frame.ts_ns - origin_ns) as f64 / 1e9);
                v.push(x);
            }
        }
        Self {
            t,
            v,
            pyramid: OnceCell::new(),
        }
    }

    /// For a series viewed once or soon replaced, where building the pyramid would cost more
    /// than it saves. Its views scan every point in range.
    pub fn without_pyramid(self) -> Self {
        Self {
            pyramid: OnceCell::from(None),
            ..self
        }
    }

    /// Undo [`Series::without_pyramid`], for a series that will be viewed again and again.
    pub fn allow_pyramid(&mut self) {
        self.pyramid = OnceCell::new();
    }

    #[cfg(test)]
    pub fn has_pyramid(&self) -> bool {
        matches!(self.pyramid.get(), Some(Some(_)))
    }

    pub fn len(&self) -> usize {
        self.t.len()
    }

    pub fn min(&self) -> Option<f64> {
        self.v.iter().copied().reduce(f64::min)
    }

    pub fn max(&self) -> Option<f64> {
        self.v.iter().copied().reduce(f64::max)
    }

    /// Points in `[t0, t1]` plus one neighbour on each side so lines reach the plot edges.
    /// Above `2 * buckets` points, each time bucket keeps only its min and max (in time order),
    /// which preserves spikes that averaging or striding would hide. A bucket whose first value
    /// is NaN keeps only that point.
    ///
    /// Returns x values followed by y values.
    pub fn view(&self, t0: f64, t1: f64, buckets: usize) -> Vec<f64> {
        if !t0.is_finite() || !t1.is_finite() {
            return Vec::new();
        }
        let lo = self.t.partition_point(|&x| x < t0).saturating_sub(1);
        let hi = (self.t.partition_point(|&x| x <= t1) + 1).min(self.t.len());
        if lo >= hi {
            return Vec::new();
        }
        if hi - lo <= buckets.saturating_mul(2) || t1 <= t0 || buckets == 0 {
            return [&self.t[lo..hi], &self.v[lo..hi]].concat();
        }

        let pyramid = if hi - lo >= buckets.saturating_mul(PYRAMID_MIN_BUCKET_POINTS) {
            self.pyramid
                .get_or_init(|| self.t.is_sorted().then(|| Pyramid::new(&self.v)))
                .as_ref()
        } else {
            None
        };
        let (t, v) = (&self.t, &self.v);
        let width = (t1 - t0) / buckets as f64;
        let mut xs = Vec::with_capacity(buckets * 2 + 2);
        let mut ys = Vec::with_capacity(buckets * 2 + 2);
        let mut i = lo;
        while i < hi {
            let bucket_end = t0 + (((t[i] - t0) / width).floor() + 1.0) * width;
            // Starting past `i` keeps going when rounding puts `bucket_end` at or before `t[i]`.
            let (next, lo_i, hi_i) = match pyramid {
                Some(pyramid) => {
                    let next = i + 1 + first_at_or_after(&t[i + 1..hi], bucket_end);
                    if v[i].is_nan() {
                        (next, i, i)
                    } else {
                        let found = pyramid.extremes(v, i, next);
                        (next, found.lo as usize, found.hi as usize)
                    }
                }
                None => scan_bucket(t, v, i, hi, bucket_end),
            };
            let (a, b) = (lo_i.min(hi_i), lo_i.max(hi_i));
            xs.push(t[a]);
            ys.push(v[a]);
            if b != a {
                xs.push(t[b]);
                ys.push(v[b]);
            }
            i = next;
        }
        xs.extend_from_slice(&ys);
        xs
    }
}

/// The partition point of `x < end` in the sorted `t`, found by doubling a step from the
/// start, as a bucket's end is usually near its start in a long series.
fn first_at_or_after(t: &[f64], end: f64) -> usize {
    let mut bound = 1;
    while bound < t.len() && t[bound] < end {
        bound *= 2;
    }
    let from = bound / 2;
    from + t[from..(bound + 1).min(t.len())].partition_point(|&x| x < end)
}

/// The end of the bucket that starts at point `i`, and its first lowest and first highest
/// points, found by comparing each point before `hi` and `bucket_end` with the lowest and
/// highest so far.
fn scan_bucket(
    t: &[f64],
    v: &[f64],
    i: usize,
    hi: usize,
    bucket_end: f64,
) -> (usize, usize, usize) {
    let (mut lo_i, mut hi_i) = (i, i);
    let mut j = i + 1;
    while j < hi && t[j] < bucket_end {
        if v[j] < v[lo_i] {
            lo_i = j;
        }
        if v[j] > v[hi_i] {
            hi_i = j;
        }
        j += 1;
    }
    (j, lo_i, hi_i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(n: usize) -> Series {
        let t = (0..n).map(|i| i as f64).collect();
        let v = (0..n)
            .map(|i| if i == 500 { 1000.0 } else { (i % 7) as f64 })
            .collect();
        Series {
            t,
            v,
            pyramid: OnceCell::new(),
        }
    }

    fn split(out: &[f64]) -> (&[f64], &[f64]) {
        out.split_at(out.len() / 2)
    }

    #[test]
    fn small_ranges_return_raw_points_with_neighbours() {
        let s = series(100);
        let out = s.view(10.0, 20.0, 50);
        let (x, _) = split(&out);
        assert_eq!(x.first(), Some(&9.0));
        assert_eq!(x.last(), Some(&21.0));
        assert_eq!(x.len(), 13);
    }

    #[test]
    fn decimation_bounds_points_and_keeps_spikes() {
        let s = series(1_000_000);
        let out = s.view(0.0, 999_999.0, 100);
        let (x, y) = split(&out);
        assert!(x.len() <= 202, "{} points", x.len());
        assert!(y.contains(&1000.0), "spike lost");
        assert!(x.windows(2).all(|w| w[0] <= w[1]), "x not sorted");
    }

    #[test]
    fn non_finite_bounds_return_nothing() {
        let s = series(1000);
        for (t0, t1) in [
            (f64::NAN, 500.0),
            (0.0, f64::NAN),
            (f64::NEG_INFINITY, 500.0),
            (0.0, f64::INFINITY),
            (f64::NEG_INFINITY, f64::INFINITY),
        ] {
            assert!(s.view(t0, t1, 2).is_empty(), "{t0}..{t1}");
        }
    }

    #[test]
    fn buckets_narrower_than_float_precision_still_advance() {
        // One ulp of 5.0 split into 100 buckets: every bucket end rounds back to 5.0.
        let s = Series {
            t: vec![5.0; 1000],
            v: (0..1000).map(f64::from).collect(),
            pyramid: OnceCell::new(),
        };
        let out = s.view(5.0, 5.0 + 1e-15, 100);
        let (x, y) = split(&out);
        assert!(!x.is_empty() && x.iter().all(|&t| t == 5.0));
        assert!(y.contains(&999.0));
    }

    #[test]
    fn empty_and_out_of_range_views() {
        assert!(series(0).view(0.0, 1.0, 10).is_empty());
        let s = series(10);
        let out = s.view(100.0, 200.0, 10);
        assert_eq!(split(&out).0, [9.0]);
    }

    /// xorshift64*, so the property test needs no dependency.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }

        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// Times with repeats and long gaps (a multiplexed signal switched out), and values with
    /// many ties, signed zeros, infinities and, in some series, NaN.
    fn random_series(rng: &mut Rng, n: usize) -> Series {
        let mut t = Vec::with_capacity(n);
        let mut now = rng.unit() * 100.0 - 50.0;
        for _ in 0..n {
            now += match rng.below(10) {
                0 => 0.0,
                1 => rng.unit() * 50.0,
                _ => rng.unit() * 0.01,
            };
            t.push(now);
        }
        let nan_share = [0, 0, 5, 50, 100][rng.below(5) as usize];
        let ints = rng.below(2) == 0;
        let v = (0..n)
            .map(|_| match rng.below(100) {
                x if x < nan_share => f64::NAN,
                _ if rng.below(50) == 0 => {
                    [0.0, -0.0, f64::INFINITY, f64::NEG_INFINITY][rng.below(4) as usize]
                }
                _ if ints => rng.below(5) as f64,
                _ => rng.unit() * 2.0 - 1.0,
            })
            .collect();
        Series {
            t,
            v,
            pyramid: OnceCell::new(),
        }
    }

    fn bits(out: &[f64]) -> Vec<u64> {
        out.iter().map(|x| x.to_bits()).collect()
    }

    #[test]
    fn pyramid_views_equal_scanned_views() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut sizes = vec![0, 1, 2, 7, 8, 9, 63, 64, 65, 513, 4097, 40_000, 300_000];
        sizes.extend((0..300).map(|_| rng.below(5000) as usize));
        for n in sizes {
            let scanned = random_series(&mut rng, n);
            let indexed = Series {
                t: scanned.t.clone(),
                v: scanned.v.clone(),
                pyramid: OnceCell::new(),
            };
            let scanned = scanned.without_pyramid();
            let (first, last) = match (indexed.t.first(), indexed.t.last()) {
                (Some(&a), Some(&b)) => (a, b),
                _ => (0.0, 1.0),
            };
            let span = (last - first).max(1e-9);
            let queries = if n > 10_000 { 20 } else { 40 };
            for _ in 0..queries {
                let mut t0 = first - span * 0.1 + rng.unit() * span * 1.2;
                let mut t1 = match rng.below(6) {
                    0 => t0,
                    1 => t0 + 1e-15,
                    2 => t0 + rng.unit() * span * 0.001,
                    _ => first - span * 0.1 + rng.unit() * span * 1.2,
                };
                if rng.below(4) == 0 {
                    (t0, t1) = (first - 1.0, last + 1.0);
                }
                let buckets = match rng.below(4) {
                    0 => rng.below(4),
                    1 => rng.below(n as u64 / 2 + 1),
                    2 => 1 + rng.below(n as u64 / 32 + 1),
                    _ => 1 + rng.below(3000),
                } as usize;
                assert_eq!(
                    bits(&indexed.view(t0, t1, buckets)),
                    bits(&scanned.view(t0, t1, buckets)),
                    "{n} points, {t0}..{t1}, {buckets} buckets"
                );
            }
            assert!(!scanned.has_pyramid());
        }
    }

    #[test]
    fn out_of_order_times_get_no_pyramid() {
        let mut s = series(10_000);
        s.t.swap(10, 20);
        s.view(0.0, 9_999.0, 100);
        assert!(!s.has_pyramid());
        let s = series(10_000);
        s.view(0.0, 9_999.0, 100);
        assert!(s.has_pyramid());
    }
}
