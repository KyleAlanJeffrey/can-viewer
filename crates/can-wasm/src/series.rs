use can_core::FrameStore;

/// A decoded signal: timestamps in seconds from the start of the log, and physical values.
pub struct Series {
    t: Vec<f64>,
    v: Vec<f64>,
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
        Self { t, v }
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
    /// which preserves spikes that averaging or striding would hide.
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
        let (t, v) = (&self.t[lo..hi], &self.v[lo..hi]);
        if t.len() <= buckets * 2 || t1 <= t0 || buckets == 0 {
            return [t, v].concat();
        }

        let width = (t1 - t0) / buckets as f64;
        let mut xs = Vec::with_capacity(buckets * 2 + 2);
        let mut ys = Vec::with_capacity(buckets * 2 + 2);
        let mut i = 0;
        while i < t.len() {
            let bucket_end = t0 + (((t[i] - t0) / width).floor() + 1.0) * width;
            let (mut lo_i, mut hi_i) = (i, i);
            // Starting past `i` keeps going when rounding puts `bucket_end` at or before `t[i]`.
            let mut j = i + 1;
            while j < t.len() && t[j] < bucket_end {
                if v[j] < v[lo_i] {
                    lo_i = j;
                }
                if v[j] > v[hi_i] {
                    hi_i = j;
                }
                j += 1;
            }
            let (a, b) = (lo_i.min(hi_i), lo_i.max(hi_i));
            xs.push(t[a]);
            ys.push(v[a]);
            if b != a {
                xs.push(t[b]);
                ys.push(v[b]);
            }
            i = j;
        }
        xs.extend_from_slice(&ys);
        xs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(n: usize) -> Series {
        let t = (0..n).map(|i| i as f64).collect();
        let v = (0..n)
            .map(|i| if i == 500 { 1000.0 } else { (i % 7) as f64 })
            .collect();
        Series { t, v }
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
}
