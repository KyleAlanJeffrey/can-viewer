//! Streaming parsers for CAN log file formats.
//!
//! Parsers take the file in arbitrary chunks, so the browser can stream a `File` through a
//! worker without ever holding the whole log in memory.

pub mod candump;

pub use candump::CandumpParser;

use can_core::FrameSink;

pub trait LogParser {
    /// Feed the next chunk of the file. Chunks may split lines or records anywhere.
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S);
    /// Flush any buffered partial record at end of file.
    fn finish<S: FrameSink>(&mut self, sink: &mut S);
    fn stats(&self) -> &ParseStats;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseStats {
    pub bytes: u64,
    pub lines: u64,
    pub frames: u64,
    pub rejected: u64,
    /// Line number and reason of the first rejected line.
    pub first_rejection: Option<(u64, &'static str)>,
}

impl ParseStats {
    fn reject(&mut self, reason: &'static str) {
        self.rejected += 1;
        if self.first_rejection.is_none() {
            self.first_rejection = Some((self.lines, reason));
        }
    }
}
