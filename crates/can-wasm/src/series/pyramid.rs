//! A level-of-detail index over a series' values, so a decimated view costs about the same
//! whatever the number of points in range.

use std::ops::Range;

/// Points (or nodes of the level below) per node.
const FANOUT: usize = 8;
const NO_POINT: u32 = u32::MAX;

/// The first lowest and first highest value of a run of points, as point indices; `NO_POINT`
/// when every value of the run is NaN.
#[derive(Clone, Copy)]
pub struct Extremes {
    lo: u32,
    hi: u32,
}

impl Extremes {
    const NONE: Self = Self {
        lo: NO_POINT,
        hi: NO_POINT,
    };

    /// The lowest and highest points, or `None` when every value of the run is NaN.
    pub fn points(self) -> [Option<usize>; 2] {
        [self.lo, self.hi].map(|p| (p != NO_POINT).then_some(p as usize))
    }

    /// Ties go to the earlier point, so runs merge in any order to the result of one scan.
    fn merge(self, other: Self, v: &[f64]) -> Self {
        Self {
            lo: pick(self.lo, other.lo, v, |x, y| x < y),
            hi: pick(self.hi, other.hi, v, |x, y| x > y),
        }
    }
}

/// Point `a` or `b`, whichever has the better value (`better(x, y)`: x beats y) or, on a tie,
/// the earlier one.
fn pick(a: u32, b: u32, v: &[f64], better: impl Fn(f64, f64) -> bool) -> u32 {
    if a == NO_POINT {
        return b;
    }
    if b == NO_POINT {
        return a;
    }
    let (va, vb) = (v[a as usize], v[b as usize]);
    if better(vb, va) || (va == vb && b < a) {
        b
    } else {
        a
    }
}

/// The [`Extremes`] of `points`, found in one pass in order, so no tie needs settling.
fn scan(v: &[f64], points: Range<usize>) -> Extremes {
    let mut found = Extremes::NONE;
    for i in points {
        let x = v[i];
        if x.is_nan() {
            continue;
        }
        if found.lo == NO_POINT || x < v[found.lo as usize] {
            found.lo = i as u32;
        }
        if found.hi == NO_POINT || x > v[found.hi as usize] {
            found.hi = i as u32;
        }
    }
    found
}

/// `levels[k]` has a node per `FANOUT^(k + 1)` points: the [`Extremes`] of those points. The
/// last node of a level may cover fewer.
pub struct Pyramid {
    levels: Vec<Vec<Extremes>>,
    /// The first point of each run of NaN values, in order; the levels skip NaN. Empty for most
    /// series.
    nan_runs: Vec<u32>,
}

impl Pyramid {
    pub fn new(v: &[f64]) -> Self {
        let mut levels: Vec<Vec<Extremes>> = Vec::new();
        let mut below = (0..v.len())
            .step_by(FANOUT)
            .map(|first| scan(v, first..(first + FANOUT).min(v.len())))
            .collect::<Vec<_>>();
        while below.len() >= FANOUT {
            let above = below
                .chunks(FANOUT)
                .map(|nodes| nodes.iter().fold(Extremes::NONE, |acc, &e| acc.merge(e, v)))
                .collect();
            levels.push(below);
            below = above;
        }
        levels.push(below);
        let mut nan_runs: Vec<u32> = (0..v.len())
            .filter(|&i| v[i].is_nan() && (i == 0 || !v[i - 1].is_nan()))
            .map(|i| i as u32)
            .collect();
        nan_runs.shrink_to_fit();
        Self { levels, nan_runs }
    }

    #[cfg(test)]
    pub fn heap_bytes(&self) -> usize {
        self.levels
            .iter()
            .map(|level| level.capacity() * size_of::<Extremes>())
            .sum::<usize>()
            + self.nan_runs.capacity() * size_of::<u32>()
    }

    /// The first NaN point of `start..end`: `start` itself, or else the start of a run.
    pub fn first_nan(&self, v: &[f64], start: usize, end: usize) -> Option<usize> {
        if start < end && v[start].is_nan() {
            return Some(start);
        }
        let k = self.nan_runs.partition_point(|&i| (i as usize) < start);
        self.nan_runs
            .get(k)
            .map(|&i| i as usize)
            .filter(|&i| i < end)
    }

    /// The [`Extremes`] of points `start..end`: whole nodes where they fit, single points only
    /// at the ends.
    pub fn extremes(&self, v: &[f64], mut start: usize, mut end: usize) -> Extremes {
        let mut acc = Extremes::NONE;
        let mut level = 0;
        loop {
            let (up_start, up_end) = (start.div_ceil(FANOUT), end / FANOUT);
            let top = level == self.levels.len();
            let edges = if top || up_start >= up_end {
                [start..end, end..end]
            } else {
                [start..up_start * FANOUT, up_end * FANOUT..end]
            };
            for range in edges {
                acc = match level {
                    0 => acc.merge(scan(v, range), v),
                    _ => self.levels[level - 1][range]
                        .iter()
                        .fold(acc, |acc, &e| acc.merge(e, v)),
                };
            }
            if top || up_start >= up_end {
                return acc;
            }
            (start, end) = (up_start, up_end);
            level += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn costs_about_a_seventh_of_a_node_per_point() {
        for n in [0, 1, 7, 8, 64, 1000, 1 << 20] {
            let v: Vec<f64> = (0..n).map(f64::from).collect();
            let nodes = Pyramid::new(&v).heap_bytes() / size_of::<Extremes>();
            assert!(nodes <= n as usize / 7 + 8, "{n} points, {nodes} nodes");
        }
    }

    #[test]
    fn extremes_skip_nan_and_prefer_the_earlier_tie() {
        let v = [
            f64::NAN,
            2.0,
            -0.0,
            5.0,
            0.0,
            5.0,
            f64::NAN,
            -1.0,
            -1.0,
            f64::NAN,
        ];
        let pyramid = Pyramid::new(&v);
        let found = pyramid.extremes(&v, 0, v.len());
        assert_eq!((found.lo, found.hi), (7, 3));
        let found = pyramid.extremes(&v, 2, 5);
        assert_eq!((found.lo, found.hi), (2, 3));
        let found = pyramid.extremes(&v, 9, 10);
        assert_eq!((found.lo, found.hi), (NO_POINT, NO_POINT));
    }

    #[test]
    fn first_nan_is_the_earliest_in_range() {
        let mut v = vec![1.0; 100];
        for i in [3, 40, 41, 99] {
            v[i] = f64::NAN;
        }
        let pyramid = Pyramid::new(&v);
        assert_eq!(pyramid.first_nan(&v, 0, 100), Some(3));
        assert_eq!(pyramid.first_nan(&v, 3, 4), Some(3));
        assert_eq!(pyramid.first_nan(&v, 4, 40), None);
        assert_eq!(pyramid.first_nan(&v, 4, 41), Some(40));
        assert_eq!(pyramid.first_nan(&v, 41, 100), Some(41));
        assert_eq!(pyramid.first_nan(&v, 41, 41), None);
        assert_eq!(pyramid.first_nan(&v, 42, 99), None);
        assert_eq!(pyramid.first_nan(&v, 42, 100), Some(99));
        let finite = [1.0, 2.0];
        assert_eq!(Pyramid::new(&finite).first_nan(&finite, 0, 2), None);
    }

    #[test]
    fn keeps_one_entry_per_run_of_nan() {
        let n = 1 << 20;
        let mut v: Vec<f64> = (0..n).map(f64::from).collect();
        for run in [
            0..1000,
            5000..5001,
            300_000..700_000,
            n as usize - 10..n as usize,
        ] {
            v[run].fill(f64::NAN);
        }
        let pyramid = Pyramid::new(&v);
        assert_eq!(pyramid.nan_runs, [0, 5000, 300_000, n - 10]);
        assert_eq!(pyramid.nan_runs.capacity(), 4);
        let bytes = Pyramid::new(&vec![f64::NAN; n as usize]).heap_bytes();
        assert!(
            bytes <= (n as usize / 7 + 8) * size_of::<Extremes>() + 4,
            "{bytes} bytes"
        );
    }
}
