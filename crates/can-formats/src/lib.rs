//! Streaming parsers for CAN log file formats, and writers for the same formats.
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
pub mod writer;

pub use asc::AscParser;
pub use blf::BlfParser;
pub use candump::CandumpParser;
pub use csv::CsvParser;
pub use detect::Format;
pub use mf4::Mf4Parser;
pub use trc::TrcParser;

use can_core::{FrameRef, FrameSink};

/// Pushes `frame`, with the DLC a remote frame asked for when the log gives one.
fn push_frame<S: FrameSink>(sink: &mut S, frame: FrameRef<'_>, remote_dlc: Option<u8>) {
    match remote_dlc {
        Some(dlc) => sink.push_remote(frame, dlc),
        None => sink.push(frame),
    }
}

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

/// The local time zone, for the wall-clock times a file gives with no time zone: an ASC file's
/// `date` line, which CANoe writes and CANoe and python-can read as local time. It holds the
/// offset of local time from UTC, in seconds, at a Unix time in seconds; the host supplies it,
/// as the crate has no clock or time zone database.
#[derive(Debug, Clone, Copy)]
pub struct LocalTime(pub fn(i64) -> i64);

impl LocalTime {
    pub const UTC: LocalTime = LocalTime(no_offset);

    /// The local wall-clock time at `unix_s`, in seconds since 1970-01-01 00:00.
    pub(crate) fn to_local(self, unix_s: i64) -> i64 {
        unix_s.saturating_add((self.0)(unix_s))
    }

    /// The Unix time of a local wall-clock time. In the hour a clock is set back, which comes
    /// twice, it may give either.
    pub(crate) fn to_unix(self, local_s: i64) -> i64 {
        let guess = local_s.saturating_sub((self.0)(local_s));
        local_s.saturating_sub((self.0)(guess))
    }
}

impl Default for LocalTime {
    fn default() -> Self {
        Self::UTC
    }
}

fn no_offset(_unix_s: i64) -> i64 {
    0
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

    /// Set the time zone of wall-clock times in the file, UTC unless set. Only ASC uses it.
    pub fn set_local_time(&mut self, local_time: LocalTime) {
        if let AnyParser::Asc(parser) = self {
            parser.set_local_time(local_time);
        }
    }

    /// Tell the parser the file's size before its bytes are pushed. Only MF4, which buffers
    /// the whole file, uses it.
    pub fn expect_bytes(&mut self, total_bytes: u64) {
        if let AnyParser::Mf4(parser) = self {
            parser.expect_bytes(total_bytes);
        }
    }

    /// Whether the rest of the file can be read in parts, each from a line boundary by a parser
    /// of its own that read only the file's start (see [`AnyParser::prime`]), given what the
    /// file has set so far. A text format's lines depend only on its header, except for ASC
    /// with relative timestamps. The binary formats are read whole.
    #[must_use]
    pub fn splittable(&self) -> bool {
        match self {
            AnyParser::Candump(_) | AnyParser::Trc(_) | AnyParser::Csv(_) => true,
            AnyParser::Asc(parser) => !parser.relative(),
            AnyParser::Blf(_) | AnyParser::Mf4(_) => false,
        }
    }

    /// What the lines read so far set that the lines after them are read by: the header, and
    /// a CSV file's time unit once a row has decided it. A part read by a parser of its own
    /// reads as it would in the whole file when that parser's state at its start is the state
    /// the parts before it ended in.
    #[must_use]
    pub fn state(&self) -> String {
        match self {
            AnyParser::Candump(_) | AnyParser::Blf(_) | AnyParser::Mf4(_) => String::new(),
            AnyParser::Asc(parser) => parser.state(),
            AnyParser::Trc(parser) => parser.state(),
            AnyParser::Csv(parser) => parser.state(),
        }
    }

    /// Readies a parser of a [`AnyParser::splittable`] format to read a part of the file that
    /// starts at a line boundary further on: reads `head`, the start of the file, up to its
    /// last line break for what its header sets, dropping its frames, then counts lines,
    /// bytes and rejections from zero.
    pub fn prime(&mut self, head: &[u8]) {
        let head = &head[..memchr::memrchr(b'\n', head).map_or(0, |nl| nl + 1)];
        self.push(head, &mut Discard);
        match self {
            AnyParser::Candump(parser) => parser.start_part(),
            AnyParser::Asc(parser) => parser.start_part(),
            AnyParser::Trc(parser) => parser.start_part(),
            AnyParser::Csv(parser) => parser.start_part(),
            AnyParser::Blf(_) | AnyParser::Mf4(_) => {}
        }
    }
}

/// Drops every frame.
struct Discard;

impl FrameSink for Discard {
    fn channel_index(&mut self, _name: &[u8]) -> u8 {
        0
    }

    fn push(&mut self, _frame: FrameRef<'_>) {}
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
