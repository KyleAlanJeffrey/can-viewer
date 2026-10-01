//! Helpers shared by the parsers' tests.

use can_core::{FrameRef, FrameSink};

use crate::{LogParser, ParseStats};

/// `(ts_ns, channel, id, flags, data)`.
pub(crate) type Frame = (i64, u8, u32, u8, Vec<u8>);

#[derive(Default)]
pub(crate) struct VecSink {
    pub(crate) channels: Vec<Vec<u8>>,
    pub(crate) frames: Vec<Frame>,
}

impl FrameSink for VecSink {
    fn channel_index(&mut self, name: &[u8]) -> u8 {
        if let Some(i) = self.channels.iter().position(|c| c == name) {
            return i as u8;
        }
        self.channels.push(name.to_vec());
        (self.channels.len() - 1) as u8
    }

    fn push(&mut self, f: FrameRef<'_>) {
        self.frames
            .push((f.ts_ns, f.channel, f.id, f.flags, f.data.to_vec()));
    }
}

/// Parses `input` in chunks of `chunk` bytes.
pub(crate) fn parse_chunked<P: LogParser>(
    mut parser: P,
    input: &[u8],
    chunk: usize,
) -> (VecSink, ParseStats) {
    let mut sink = VecSink::default();
    for part in input.chunks(chunk.max(1)) {
        parser.push(part, &mut sink);
    }
    parser.finish(&mut sink);
    (sink, parser.stats().clone())
}

/// Asserts that `input` gives the same frames, channels and stats whatever the chunk size,
/// and returns the result of parsing it whole.
pub(crate) fn assert_chunking_does_not_matter<P: LogParser>(
    new_parser: impl Fn() -> P,
    input: &[u8],
) -> (VecSink, ParseStats) {
    let (whole, stats) = parse_chunked(new_parser(), input, usize::MAX);
    let sizes = (1..=input.len().min(96)).chain([128, 1000, 4097, 1 << 16]);
    for chunk in sizes {
        let (split, split_stats) = parse_chunked(new_parser(), input, chunk);
        assert_eq!(split.frames, whole.frames, "chunk size {chunk}");
        assert_eq!(split.channels, whole.channels, "chunk size {chunk}");
        assert_eq!(split_stats, stats, "chunk size {chunk}");
    }
    (whole, stats)
}
