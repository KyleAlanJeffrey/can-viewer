//! Streaming parsers for CAN log file formats.
//!
//! Parsers take the file in arbitrary chunks, so the browser can stream a `File` through a
//! worker without ever holding the whole log in memory.

pub mod asc;
pub mod candump;
mod detect;
mod lines;
#[cfg(test)]
mod testing;
mod text;

pub use asc::AscParser;
pub use candump::CandumpParser;
pub use detect::Format;

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
    /// Lines read, or records read for a binary format.
    pub lines: u64,
    pub frames: u64,
    pub rejected: u64,
    /// Line (or record) number and reason of the first rejected line.
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

/// The parser for whichever [`Format`] a file turned out to be.
#[derive(Debug)]
pub enum AnyParser {
    Candump(CandumpParser),
    Asc(AscParser),
}

impl AnyParser {
    #[must_use]
    pub fn new(format: Format) -> Self {
        match format {
            Format::Candump => AnyParser::Candump(CandumpParser::new()),
            Format::Asc => AnyParser::Asc(AscParser::new()),
        }
    }

    #[must_use]
    pub fn format(&self) -> Format {
        match self {
            AnyParser::Candump(_) => Format::Candump,
            AnyParser::Asc(_) => Format::Asc,
        }
    }
}

impl LogParser for AnyParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        match self {
            AnyParser::Candump(parser) => parser.push(chunk, sink),
            AnyParser::Asc(parser) => parser.push(chunk, sink),
        }
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        match self {
            AnyParser::Candump(parser) => parser.finish(sink),
            AnyParser::Asc(parser) => parser.finish(sink),
        }
    }

    fn stats(&self) -> &ParseStats {
        match self {
            AnyParser::Candump(parser) => parser.stats(),
            AnyParser::Asc(parser) => parser.stats(),
        }
    }
}
