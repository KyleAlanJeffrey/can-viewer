//! Streaming parsers for CAN log file formats.
//!
//! Parsers take the file in arbitrary chunks, so the browser can stream a `File` through a
//! worker without ever holding the whole log in memory.

pub mod asc;
pub mod blf;
pub mod candump;
pub mod csv;
mod detect;
mod lines;
pub mod mf4;
#[cfg(test)]
mod testing;
mod text;
pub mod trc;

pub use asc::AscParser;
pub use blf::BlfParser;
pub use candump::CandumpParser;
pub use csv::CsvParser;
pub use detect::Format;
pub use mf4::Mf4Parser;
pub use trc::TrcParser;

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
    Trc(TrcParser),
    Csv(CsvParser),
    Blf(BlfParser),
    Mf4(Mf4Parser),
}

impl AnyParser {
    #[must_use]
    pub fn new(format: Format) -> Self {
        match format {
            Format::Candump => AnyParser::Candump(CandumpParser::new()),
            Format::Asc => AnyParser::Asc(AscParser::new()),
            Format::Trc => AnyParser::Trc(TrcParser::new()),
            Format::Csv => AnyParser::Csv(CsvParser::new()),
            Format::Blf => AnyParser::Blf(BlfParser::new()),
            Format::Mf4 => AnyParser::Mf4(Mf4Parser::new()),
        }
    }

    #[must_use]
    pub fn format(&self) -> Format {
        match self {
            AnyParser::Candump(_) => Format::Candump,
            AnyParser::Asc(_) => Format::Asc,
            AnyParser::Trc(_) => Format::Trc,
            AnyParser::Csv(_) => Format::Csv,
            AnyParser::Blf(_) => Format::Blf,
            AnyParser::Mf4(_) => Format::Mf4,
        }
    }
}

impl LogParser for AnyParser {
    fn push<S: FrameSink>(&mut self, chunk: &[u8], sink: &mut S) {
        match self {
            AnyParser::Candump(parser) => parser.push(chunk, sink),
            AnyParser::Asc(parser) => parser.push(chunk, sink),
            AnyParser::Trc(parser) => parser.push(chunk, sink),
            AnyParser::Csv(parser) => parser.push(chunk, sink),
            AnyParser::Blf(parser) => parser.push(chunk, sink),
            AnyParser::Mf4(parser) => parser.push(chunk, sink),
        }
    }

    fn finish<S: FrameSink>(&mut self, sink: &mut S) {
        match self {
            AnyParser::Candump(parser) => parser.finish(sink),
            AnyParser::Asc(parser) => parser.finish(sink),
            AnyParser::Trc(parser) => parser.finish(sink),
            AnyParser::Csv(parser) => parser.finish(sink),
            AnyParser::Blf(parser) => parser.finish(sink),
            AnyParser::Mf4(parser) => parser.finish(sink),
        }
    }

    fn stats(&self) -> &ParseStats {
        match self {
            AnyParser::Candump(parser) => parser.stats(),
            AnyParser::Asc(parser) => parser.stats(),
            AnyParser::Trc(parser) => parser.stats(),
            AnyParser::Csv(parser) => parser.stats(),
            AnyParser::Blf(parser) => parser.stats(),
            AnyParser::Mf4(parser) => parser.stats(),
        }
    }
}
