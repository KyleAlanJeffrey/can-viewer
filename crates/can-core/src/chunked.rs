//! Columns that grow a chunk at a time, so a store never copies what it holds to grow and
//! never holds more than about one chunk of spare room per column. A `Vec` that doubles
//! holds up to twice its data while it grows, and both copies at once while it moves.

use std::collections::TryReserveError;
use std::mem::size_of;
use std::ops::Index;

use crate::{tp, MAX_PAYLOAD};

/// A full chunk is 4 MiB: little to waste at the end of a column, and few enough allocations
/// that a load stays within about 2% of the speed of `Vec` columns in wasm. Each allocation
/// that grows wasm memory costs the JavaScript side, so 64 KiB chunks loaded the 10M-frame
/// demo 15% slower and 1 MiB chunks 4% slower.
const CHUNK_BYTES_SHIFT: u32 = 22;

/// What the first chunk starts at. It doubles up to a full chunk, so a small log stays small.
const FIRST_CHUNK_LEN: usize = 64;

/// The capacity a chunk of `capacity` that ran out grows to, to hold `needed` entries.
fn grown(capacity: usize, needed: usize, full: usize) -> usize {
    (capacity * 2).max(needed).clamp(FIRST_CHUNK_LEN, full)
}

/// Allocates chunks of `len` into `spare` until it has `wanted`, keeping none of them if any
/// fails.
fn try_spare_chunks<T>(
    spare: &mut Vec<Vec<T>>,
    wanted: usize,
    len: usize,
) -> Result<(), TryReserveError> {
    let before = spare.len();
    let count = wanted.saturating_sub(before);
    let result = spare.try_reserve(count).and_then(|()| {
        for _ in 0..count {
            let mut chunk = Vec::new();
            chunk.try_reserve_exact(len)?;
            spare.push(chunk);
        }
        Ok(())
    });
    if result.is_err() {
        spare.truncate(before);
    }
    result
}

/// A sequence of values indexed like a slice. Every chunk but the last is full.
#[derive(Debug)]
pub struct Column<T> {
    chunks: Vec<Vec<T>>,
    /// Entries at the start of the first chunk dropped by [`Column::drop_front`].
    skipped: usize,
    len: usize,
    /// Empty full chunks reserved for what comes.
    spare: Vec<Vec<T>>,
}

impl<T> Default for Column<T> {
    fn default() -> Self {
        Self {
            chunks: Vec::new(),
            skipped: 0,
            len: 0,
            spare: Vec::new(),
        }
    }
}

impl<T> Column<T> {
    const SHIFT: u32 = {
        assert!(size_of::<T>().is_power_of_two());
        CHUNK_BYTES_SHIFT - size_of::<T>().trailing_zeros()
    };
    /// Entries in a full chunk.
    pub const CHUNK_LEN: usize = 1 << Self::SHIFT;
    const MASK: usize = Self::CHUNK_LEN - 1;
}

impl<T> Index<usize> for Column<T> {
    type Output = T;

    /// An index past the end lands past the last chunk's entries, or past the last chunk.
    #[inline]
    fn index(&self, index: usize) -> &T {
        let at = self.skipped + index;
        &self.chunks[at >> Self::SHIFT][at & Self::MASK]
    }
}

impl<T: Copy> Column<T> {
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn get(&self, index: usize) -> Option<T> {
        (index < self.len).then(|| self[index])
    }

    pub fn first(&self) -> Option<T> {
        self.get(0)
    }

    pub fn last(&self) -> Option<T> {
        self.len.checked_sub(1).map(|i| self[i])
    }

    pub fn iter(&self) -> impl Iterator<Item = T> + '_ {
        let (first, rest) = match self.chunks.split_first() {
            Some((first, rest)) => (&first[self.skipped..], rest),
            None => (&[][..], &[][..]),
        };
        first.iter().chain(rest.iter().flatten()).copied()
    }

    /// Like [`slice::partition_point`].
    pub fn partition_point(&self, mut pred: impl FnMut(T) -> bool) -> usize {
        let (mut low, mut high) = (0, self.len);
        while low < high {
            let mid = low + (high - low) / 2;
            if pred(self[mid]) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low
    }

    #[inline]
    pub fn push(&mut self, value: T) {
        match self.chunks.last_mut() {
            Some(chunk) if chunk.len() < chunk.capacity().min(Self::CHUNK_LEN) => chunk.push(value),
            _ => self.push_into_new_room(value),
        }
        self.len += 1;
    }

    #[cold]
    fn push_into_new_room(&mut self, value: T) {
        match self.chunks.last_mut() {
            Some(chunk) if chunk.len() < Self::CHUNK_LEN => {
                let grown = grown(chunk.capacity(), chunk.len() + 1, Self::CHUNK_LEN);
                chunk.reserve_exact(grown - chunk.len());
            }
            _ => {
                let chunk = match self.spare.pop() {
                    Some(chunk) => chunk,
                    None if self.chunks.is_empty() => Vec::with_capacity(FIRST_CHUNK_LEN),
                    None => Vec::with_capacity(Self::CHUNK_LEN),
                };
                self.chunks.push(chunk);
            }
        }
        self.chunks.last_mut().unwrap().push(value);
    }

    /// Makes room for `additional` more entries, failing rather than aborting when memory runs
    /// out. The entries held are untouched either way.
    pub fn try_reserve(&mut self, additional: usize) -> Result<(), TryReserveError> {
        let end = (self.skipped + self.len).saturating_add(additional);
        if self.chunks.is_empty() {
            self.chunks.try_reserve(1)?;
            self.chunks.push(Vec::new());
        }
        let last = self.chunks.len() - 1;
        let chunk = &mut self.chunks[last];
        let wanted = (end - (last << Self::SHIFT)).min(Self::CHUNK_LEN);
        if chunk.capacity() < wanted {
            let grown = grown(chunk.capacity(), wanted, Self::CHUNK_LEN);
            chunk.try_reserve_exact(grown - chunk.len())?;
        }
        let new_chunks = end
            .div_ceil(Self::CHUNK_LEN)
            .saturating_sub(self.chunks.len());
        try_spare_chunks(&mut self.spare, new_chunks, Self::CHUNK_LEN)?;
        self.chunks.try_reserve(new_chunks)
    }

    /// Drops the spare chunks.
    pub fn release_spare(&mut self) {
        self.spare = Vec::new();
    }

    /// Drops the first `count` entries; whole chunks are freed and the rest stay in place.
    ///
    /// # Panics
    /// If `count` is more than the length.
    pub fn drop_front(&mut self, count: usize) {
        assert!(count <= self.len);
        self.len -= count;
        let skipped = self.skipped + count;
        self.chunks
            .drain(..(skipped >> Self::SHIFT).min(self.chunks.len()));
        self.skipped = skipped & Self::MASK;
    }

    /// Calls `f` on each entry, in order.
    pub fn for_each_mut(&mut self, mut f: impl FnMut(&mut T)) {
        let skipped = self.skipped;
        for (i, chunk) in self.chunks.iter_mut().enumerate() {
            let start = if i == 0 { skipped } else { 0 };
            chunk[start..].iter_mut().for_each(&mut f);
        }
    }

    pub fn heap_bytes(&self) -> usize {
        let chunks: usize = self
            .chunks
            .iter()
            .chain(&self.spare)
            .map(Vec::capacity)
            .sum();
        chunks * size_of::<T>()
            + (self.chunks.capacity() + self.spare.capacity()) * size_of::<Vec<T>>()
    }
}

/// The longest payload the store holds: a reassembled J1939 transfer.
const LONGEST_PAYLOAD: usize = if tp::MAX_TRANSFER > MAX_PAYLOAD {
    tp::MAX_TRANSFER
} else {
    MAX_PAYLOAD
};

/// The payload bytes of every frame, one after the other, each payload whole within one
/// chunk. A payload that does not fit at the end of a chunk starts the next, so a chunk can end
/// in up to [`LONGEST_PAYLOAD`] unused bytes.
///
/// A payload is found by its position: `chunk << 22 | offset`.
#[derive(Debug, Default)]
pub struct Payloads {
    /// The last one is being filled.
    chunks: Vec<Vec<u8>>,
    spare: Vec<Vec<u8>>,
}

const PAYLOAD_SHIFT: u32 = CHUNK_BYTES_SHIFT;
const PAYLOAD_CHUNK: usize = 1 << PAYLOAD_SHIFT;
const PAYLOAD_MASK: usize = PAYLOAD_CHUNK - 1;

impl Payloads {
    /// Appends `payload` and returns its position.
    #[inline]
    pub fn push(&mut self, payload: &[u8]) -> usize {
        // A longer one could overrun its chunk and corrupt every position after it.
        assert!(payload.len() <= LONGEST_PAYLOAD);
        let fits = self.chunks.last().is_some_and(|chunk| {
            chunk.len() < PAYLOAD_CHUNK
                && chunk.len() + payload.len() <= chunk.capacity().min(PAYLOAD_CHUNK)
        });
        if !fits {
            self.make_room(payload.len());
        }
        let last = self.chunks.len() - 1;
        let chunk = &mut self.chunks[last];
        let at = last << PAYLOAD_SHIFT | chunk.len();
        chunk.extend_from_slice(payload);
        at
    }

    #[cold]
    fn make_room(&mut self, len: usize) {
        if let Some(chunk) = self.chunks.last_mut() {
            if chunk.len() < PAYLOAD_CHUNK && chunk.len() + len <= PAYLOAD_CHUNK {
                chunk.reserve_exact(
                    grown(chunk.capacity(), chunk.len() + len, PAYLOAD_CHUNK) - chunk.len(),
                );
                return;
            }
        }
        let chunk = match self.spare.pop() {
            Some(chunk) => chunk,
            None if self.chunks.is_empty() => Vec::with_capacity(FIRST_CHUNK_LEN.max(len)),
            None => Vec::with_capacity(PAYLOAD_CHUNK),
        };
        self.chunks.push(chunk);
    }

    /// The payload at `start`, which ends at `end` if the next payload is in the same chunk,
    /// or else where its chunk's bytes do.
    #[inline]
    pub fn get(&self, start: usize, next: Option<usize>) -> &[u8] {
        let chunk = &self.chunks[start >> PAYLOAD_SHIFT];
        let end = match next {
            Some(next) if next >> PAYLOAD_SHIFT == start >> PAYLOAD_SHIFT => next & PAYLOAD_MASK,
            _ => chunk.len(),
        };
        &chunk[start & PAYLOAD_MASK..end]
    }

    /// Where the next payload would go if it fit.
    pub fn end(&self) -> usize {
        self.chunks.last().map_or(0, |chunk| {
            (self.chunks.len() - 1) << PAYLOAD_SHIFT | chunk.len()
        })
    }

    /// Makes room for at least `bytes` more payload bytes, failing rather than aborting when
    /// memory runs out. The payloads held are untouched either way.
    pub fn try_reserve(&mut self, bytes: usize) -> Result<(), TryReserveError> {
        if self.chunks.is_empty() {
            self.chunks.try_reserve(1)?;
            self.chunks.push(Vec::new());
        }
        let chunk = self.chunks.last_mut().unwrap();
        let wanted = chunk.len().saturating_add(bytes).min(PAYLOAD_CHUNK);
        if chunk.capacity() < wanted {
            let grown = grown(chunk.capacity(), wanted, PAYLOAD_CHUNK);
            chunk.try_reserve_exact(grown - chunk.len())?;
        }
        // Each chunk may end in unused bytes, so count on fewer than a chunk's worth in each.
        let room = PAYLOAD_CHUNK.saturating_sub(chunk.len() + LONGEST_PAYLOAD);
        let new_chunks = bytes
            .saturating_sub(room)
            .div_ceil(PAYLOAD_CHUNK - LONGEST_PAYLOAD);
        try_spare_chunks(&mut self.spare, new_chunks, PAYLOAD_CHUNK)?;
        self.chunks.try_reserve(new_chunks)
    }

    pub fn release_spare(&mut self) {
        self.spare = Vec::new();
    }

    /// Drops the chunks before the one holding position `keep_from`, and returns how much
    /// every later position moves down by.
    pub fn drop_chunks_before(&mut self, keep_from: usize) -> usize {
        let chunks = (keep_from >> PAYLOAD_SHIFT).min(self.chunks.len());
        self.chunks.drain(..chunks);
        chunks << PAYLOAD_SHIFT
    }

    pub fn heap_bytes(&self) -> usize {
        let bytes: usize = self
            .chunks
            .iter()
            .chain(&self.spare)
            .map(Vec::capacity)
            .sum();
        bytes + (self.chunks.capacity() + self.spare.capacity()) * size_of::<Vec<u8>>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_column_reads_back_across_chunks_and_after_dropping_its_front() {
        const CHUNK_LEN: usize = Column::<u32>::CHUNK_LEN;
        let mut c = Column::default();
        let n = 3 * CHUNK_LEN + 5;
        for i in 0..n {
            c.push(i as u32);
        }
        assert_eq!(c.len(), n);
        assert_eq!((c.first(), c.last()), (Some(0), Some(n as u32 - 1)));
        assert_eq!(c[CHUNK_LEN], CHUNK_LEN as u32);
        assert_eq!(c.get(n), None);
        assert!(c.iter().eq(0..n as u32));
        assert_eq!(c.partition_point(|v| v < 300_000), 300_000);

        c.drop_front(CHUNK_LEN + 7);
        assert_eq!(c.len(), n - CHUNK_LEN - 7);
        assert_eq!(c[0], CHUNK_LEN as u32 + 7);
        assert!(c.iter().eq(CHUNK_LEN as u32 + 7..n as u32));
        c.for_each_mut(|v| *v -= 7);
        assert_eq!(c[0], CHUNK_LEN as u32);
        c.push(1);
        assert_eq!(c.last(), Some(1));

        c.drop_front(c.len());
        assert_eq!(c.iter().count(), 0);
        c.push(9);
        assert_eq!(c[0], 9);
    }

    #[test]
    fn a_column_grows_its_first_chunk_and_then_a_full_chunk_at_a_time() {
        let mut c = Column::default();
        c.push(0u64);
        assert!(c.heap_bytes() < 1024, "{}", c.heap_bytes());
        for i in 1..Column::<u64>::CHUNK_LEN + 1 {
            c.push(i as u64);
        }
        let chunk_bytes = Column::<u64>::CHUNK_LEN * size_of::<u64>();
        assert!(c.heap_bytes() < 2 * chunk_bytes + 1024);

        const CHUNK_LEN: usize = Column::<u8>::CHUNK_LEN;
        let mut c = Column::<u8>::default();
        c.try_reserve(2 * CHUNK_LEN + 1).unwrap();
        let reserved = c.heap_bytes();
        assert!(reserved >= 3 * CHUNK_LEN);
        for i in 0..2 * CHUNK_LEN + 1 {
            c.push(i as u8);
        }
        assert_eq!(c.heap_bytes(), reserved, "pushes used the reserved chunks");
        c.try_reserve(CHUNK_LEN).unwrap();
        c.release_spare();
        assert!(c.heap_bytes() < reserved + CHUNK_LEN);
        assert!(c.try_reserve(usize::MAX).is_err());
        assert_eq!(c.len(), 2 * CHUNK_LEN + 1);
    }

    #[test]
    fn payloads_stay_whole_within_a_chunk() {
        let mut p = Payloads::default();
        let mut at = Vec::new();
        let mut i = 0usize;
        while p.end() < 3 * PAYLOAD_CHUNK {
            let len = [0, 8, 64, LONGEST_PAYLOAD][i % 4];
            at.push(p.push(&vec![i as u8; len]));
            i += 1;
        }
        for (i, &start) in at.iter().enumerate() {
            let payload = p.get(start, at.get(i + 1).copied());
            assert_eq!(
                payload.len(),
                [0, 8, 64, LONGEST_PAYLOAD][i % 4],
                "payload {i}"
            );
            assert!(payload.iter().all(|&b| b == i as u8));
        }

        let first_kept = at.len() / 2;
        let moved = p.drop_chunks_before(at[first_kept]);
        assert_eq!(moved, at[first_kept] >> PAYLOAD_SHIFT << PAYLOAD_SHIFT);
        let at: Vec<usize> = at[first_kept..].iter().map(|a| a - moved).collect();
        for (i, &start) in at.iter().enumerate() {
            let len = p.get(start, at.get(i + 1).copied()).len();
            assert_eq!(len, [0, 8, 64, LONGEST_PAYLOAD][(first_kept + i) % 4]);
        }
    }

    #[test]
    fn reserved_payload_room_is_enough_for_the_bytes() {
        let mut p = Payloads::default();
        p.push(&[1; 100]);
        p.try_reserve(5 * PAYLOAD_CHUNK).unwrap();
        let reserved = p.heap_bytes();
        let mut written = 0;
        while written + LONGEST_PAYLOAD <= 5 * PAYLOAD_CHUNK {
            p.push(&[2; LONGEST_PAYLOAD]);
            written += LONGEST_PAYLOAD;
        }
        assert_eq!(p.heap_bytes(), reserved);
    }
}
