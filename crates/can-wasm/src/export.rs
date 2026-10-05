//! An exported log, built in memory and handed to JavaScript a chunk at a time.

use std::collections::VecDeque;
use std::io::{self, Seek, SeekFrom, Write};

use can_formats::writer;

/// Bytes per chunk.
pub const CHUNK_BYTES: usize = 8 << 20;

/// A file built in fixed-size chunks, so that a large export never needs one huge allocation
/// or the spare capacity of a growing `Vec`. Each chunk is allocated fallibly, as the writers
/// allocate their own buffers, so running out of memory is an error rather than a trap that
/// would lose the open log. Seeking past the end is not supported; the writers only seek back
/// to fill in headers.
#[derive(Debug, Default)]
pub struct ChunkedFile {
    chunks: VecDeque<Vec<u8>>,
    len: u64,
    position: u64,
}

impl ChunkedFile {
    pub fn into_chunks(self) -> VecDeque<Vec<u8>> {
        self.chunks
    }
}

impl Write for ChunkedFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let index = (self.position / CHUNK_BYTES as u64) as usize;
        let offset = (self.position % CHUNK_BYTES as u64) as usize;
        if index == self.chunks.len() {
            let mut chunk = Vec::new();
            chunk
                .try_reserve_exact(CHUNK_BYTES)
                .map_err(|_| writer::out_of_memory())?;
            self.chunks
                .try_reserve(1)
                .map_err(|_| writer::out_of_memory())?;
            self.chunks.push_back(chunk);
        }
        let chunk = &mut self.chunks[index];
        let n = buf.len().min(CHUNK_BYTES - offset);
        let overwrite = (chunk.len() - offset).min(n);
        chunk[offset..offset + overwrite].copy_from_slice(&buf[..overwrite]);
        chunk.extend_from_slice(&buf[overwrite..n]);
        self.position += n as u64;
        self.len = self.len.max(self.position);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for ChunkedFile {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let position = match to {
            SeekFrom::Start(at) => Some(at),
            SeekFrom::End(delta) => self.len.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        };
        match position {
            Some(at) if at <= self.len => {
                self.position = at;
                Ok(at)
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek outside the exported file",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_across_chunks_and_overwrites_after_seeking_back() {
        let mut file = ChunkedFile::default();
        file.write_all(&vec![1; CHUNK_BYTES - 2]).unwrap();
        file.write_all(&[2; 5]).unwrap();
        file.seek(SeekFrom::Start(1)).unwrap();
        file.write_all(&[3, 3]).unwrap();
        file.seek(SeekFrom::Start(CHUNK_BYTES as u64 - 1)).unwrap();
        file.write_all(&[4; 6]).unwrap();
        assert_eq!(file.seek(SeekFrom::End(0)).unwrap(), CHUNK_BYTES as u64 + 5);
        assert!(file.seek(SeekFrom::Current(1)).is_err());

        let chunks = file.into_chunks();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), CHUNK_BYTES);
        assert_eq!(&chunks[0][..4], &[1, 3, 3, 1]);
        assert_eq!(&chunks[0][CHUNK_BYTES - 3..], &[1, 2, 4]);
        assert_eq!(chunks[1], [4; 5]);
    }
}
