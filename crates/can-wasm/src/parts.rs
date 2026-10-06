//! Reading a log in parts in several workers. The core worker reads the start of a text log
//! itself, then each part after it, from a line boundary, is read by [`parse_segment`] in a
//! worker of its own and joined onto the open log, in file order, by `Session::push_segment`.
//! The result is the log read whole: the frame store joins the parts' frames and statistics
//! (see `FrameStore::append_segment`), line numbers carry on from part to part, an ASC file's
//! relative times carry on from the sum the part before left (see `PartTimes`), and a part read
//! in another header state than the parts before it left is refused, so the log is read again
//! in one worker.
//!
//! A BLF file is cut where its objects end rather than at line breaks ([`ObjectCuts`]); the
//! objects in its log containers run on from part to part, so each part also carries the bytes
//! before the first object it read and those it left at its end (see `can_formats::blf`).

use can_core::FrameStore;
use can_formats::blf::{Early, ObjectEnds, PartEdges};
use can_formats::{AnyParser, Format, LogParser, ParseStats, PartTimes};
use wasm_bindgen::prelude::*;

use crate::{clock, js_err};

const MAGIC: &[u8; 4] = b"FCP3";

/// What reading a log counted, as `LogInfo` reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ReadStats {
    pub(crate) bytes: u64,
    pub(crate) lines: u64,
    pub(crate) rejected: u64,
    /// Line (or record) number and reason of the first rejected line.
    pub(crate) first_rejection: Option<(u64, String)>,
}

impl From<&ParseStats> for ReadStats {
    fn from(stats: &ParseStats) -> Self {
        Self {
            bytes: stats.bytes,
            lines: stats.lines,
            rejected: stats.rejected,
            first_rejection: stats
                .first_rejection
                .map(|(line, reason)| (line, reason.to_owned())),
        }
    }
}

impl ReadStats {
    /// Adds the counts of the part of the file that comes after the one these count.
    pub(crate) fn append(&mut self, later: &ReadStats) {
        if self.first_rejection.is_none() {
            self.first_rejection = later
                .first_rejection
                .as_ref()
                .map(|(line, reason)| (self.lines + line, reason.clone()));
        }
        self.bytes += later.bytes;
        self.lines += later.lines;
        self.rejected += later.rejected;
    }
}

/// Reads `part`, the lines of a log in `format` (a `LogInfo.format` name) from a line
/// boundary after the first, or the bytes of a BLF file between two places [`ObjectCuts`]
/// gave, with `head`, the start of the file, for its header. Returns the part for
/// `Session::push_segment`: its counts, the header state it was read in and the one it left,
/// how its times carry on from the part before, a BLF part's edges, and its frames.
///
/// # Errors
/// For a format that can't be read in parts.
#[wasm_bindgen]
pub fn parse_segment(format: &str, head: &[u8], part: &[u8]) -> Result<Vec<u8>, JsError> {
    Format::from_name(format)
        .and_then(|format| read_part(format, head, part))
        .ok_or_else(|| js_err("this log can't be read in parts"))
}

fn read_part(format: Format, head: &[u8], part: &[u8]) -> Option<Vec<u8>> {
    let mut parser = AnyParser::new(format);
    parser.set_local_time(clock::local_time());
    parser.prime(head);
    if !parser.splittable() {
        return None;
    }
    let entry = parser.state();
    let mut store = FrameStore::for_segment();
    parser.push(part, &mut store);
    parser.finish(&mut store);
    let edges = parser.part_edges();
    let frames = store.encode_segment();

    let stats = ReadStats::from(parser.stats());
    let mut out = Vec::with_capacity(frames.len() + 256);
    out.extend_from_slice(MAGIC);
    for count in [stats.bytes, stats.lines, stats.rejected] {
        out.extend_from_slice(&count.to_le_bytes());
    }
    match &stats.first_rejection {
        Some((line, reason)) => {
            out.push(1);
            out.extend_from_slice(&line.to_le_bytes());
            put_text(&mut out, reason);
        }
        None => out.push(0),
    }
    put_text(&mut out, &entry);
    put_text(&mut out, &parser.state());
    let times = parser.part_times();
    out.extend_from_slice(&times.frames.to_le_bytes());
    out.extend_from_slice(&times.from_base_ns.to_le_bytes());
    out.extend_from_slice(&times.last_ns.to_le_bytes());
    out.push(u8::from(times.open) | u8::from(times.scattered) << 1);
    match &edges {
        Some(edges) => {
            out.push(
                1 | u8::from(edges.synced) << 1
                    | u8::from(edges.early.frames) << 2
                    | u8::from(edges.early.rejections) << 3,
            );
            put_bytes(&mut out, &edges.prefix);
            put_bytes(&mut out, &edges.start);
            put_bytes(&mut out, &edges.carry);
            out.extend_from_slice(&edges.gap.to_le_bytes());
        }
        None => out.push(0),
    }
    out.extend_from_slice(&frames);
    Some(out)
}

fn put_text(out: &mut Vec<u8>, text: &str) {
    put_bytes(out, text.as_bytes());
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

/// A part from [`parse_segment`], read in place.
pub(crate) struct Part<'a> {
    pub(crate) stats: ReadStats,
    /// The header state the part was read in, and the one it left.
    pub(crate) entry: &'a str,
    pub(crate) exit: &'a str,
    pub(crate) times: PartTimes,
    /// A BLF part's edges.
    pub(crate) edges: Option<PartEdges>,
    /// For `FrameStore::append_shifted_segment`.
    pub(crate) frames: &'a [u8],
}

impl<'a> Part<'a> {
    pub(crate) fn read(bytes: &'a [u8]) -> Option<Self> {
        let mut r = Reader(bytes);
        if r.take(MAGIC.len())? != MAGIC {
            return None;
        }
        let mut stats = ReadStats {
            bytes: r.u64()?,
            lines: r.u64()?,
            rejected: r.u64()?,
            first_rejection: None,
        };
        match r.take(1)? {
            [0] => {}
            [1] => stats.first_rejection = Some((r.u64()?, r.text()?.to_owned())),
            _ => return None,
        }
        let entry = r.text()?;
        let exit = r.text()?;
        let frames = r.u64()?;
        let from_base_ns = r.u64()? as i64;
        let last_ns = r.u64()? as i64;
        let &[bits] = r.take(1)? else {
            return None;
        };
        if bits > 0b11 {
            return None;
        }
        let edges = match r.take(1)? {
            [0] => None,
            &[bits] if bits & !0b1111 == 0 && bits & 1 != 0 => Some(PartEdges {
                synced: bits & 2 != 0,
                early: Early {
                    frames: bits & 4 != 0,
                    rejections: bits & 8 != 0,
                },
                prefix: r.bytes()?.to_vec(),
                start: r.bytes()?.to_vec(),
                carry: r.bytes()?.to_vec(),
                gap: r.u64()?,
            }),
            _ => return None,
        };
        Some(Self {
            stats,
            entry,
            exit,
            times: PartTimes {
                frames,
                open: bits & 1 != 0,
                from_base_ns,
                last_ns,
                scattered: bits & 2 != 0,
            },
            edges,
            frames: r.0,
        })
    }
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn text(&mut self) -> Option<&'a str> {
        std::str::from_utf8(self.bytes()?).ok()
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = u32::from_le_bytes(self.take(4)?.try_into().ok()?);
        self.take(len as usize)
    }
}

/// Finds where a BLF file can be cut into parts: where an object of the file ends, as the
/// parser reads them, about `part_bytes` apart.
pub(crate) struct ObjectCuts {
    ends: ObjectEnds,
    part_bytes: u64,
    /// The bytes taken so far, and the last cut.
    taken: u64,
    last: u64,
    /// The last object end within `part_bytes` of the last cut.
    pending: Option<u64>,
}

impl ObjectCuts {
    pub(crate) fn new(part_bytes: u64) -> Self {
        Self {
            ends: ObjectEnds::new(),
            part_bytes: part_bytes.max(1),
            taken: 0,
            last: 0,
            pending: None,
        }
    }

    /// Takes the next bytes of the file, from its start, and returns the cuts found: each the
    /// last object end within `part_bytes` of the cut before, or the first end past it when
    /// none is. A cut is known once the bytes taken reach `part_bytes` past the last.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<f64> {
        let mut cuts = Vec::new();
        let (part_bytes, last, pending) = (self.part_bytes, &mut self.last, &mut self.pending);
        let mut cut = |at: u64, last: &mut u64| {
            cuts.push(at as f64);
            *last = at;
        };
        self.ends.push(chunk, |end| {
            if end - *last > part_bytes {
                if let Some(at) = pending.take() {
                    cut(at, last);
                }
            }
            if end - *last > part_bytes {
                cut(end, last);
            } else {
                *pending = Some(end);
            }
        });
        self.taken += chunk.len() as u64;
        if self.taken >= self.last + part_bytes {
            if let Some(at) = self.pending.take() {
                cut(at, &mut self.last);
            }
        }
        cuts
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fmt::Write;

    use super::*;
    use crate::Session;

    /// Where the web app's worker starts reading a part that owns the lines starting in
    /// `[start, ..)`: at the first line start at or after `start`.
    fn line_start_at_or_after(log: &[u8], start: usize) -> usize {
        if start == 0 {
            return 0;
        }
        log[start - 1..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(log.len(), |nl| start + nl)
    }

    fn read_whole(name: &str, log: &[u8]) -> Session {
        let mut s = Session::new();
        s.set_file_name(name);
        s.push_chunk(log);
        s
    }

    /// Which of a session's logs a test reads: the open log, or Compare's log B beside it.
    #[derive(Debug, Clone, Copy)]
    enum Log {
        Open,
        B,
    }

    impl Log {
        /// A session reading a log of `total` bytes.
        fn begin(self, name: &str, total: usize) -> Session {
            let mut s = Session::new();
            match self {
                Log::Open => s.set_file_name(name),
                Log::B => s.compare_begin(name, total as f64),
            }
            s
        }

        fn push_chunk(self, s: &mut Session, chunk: &[u8]) {
            match self {
                Log::Open => s.push_chunk(chunk),
                Log::B => assert!(s.compare_push_chunk(chunk).is_ok()),
            }
        }

        fn object_cuts(self, s: &mut Session, chunk: &[u8], part_bytes: f64) -> Option<Vec<f64>> {
            match self {
                Log::Open => s.object_cuts(chunk, part_bytes),
                Log::B => s.compare_object_cuts(chunk, part_bytes),
            }
        }

        fn segment_format(self, s: &Session) -> Option<String> {
            match self {
                Log::Open => s.segment_format(),
                Log::B => s.compare_segment_format(),
            }
        }

        fn push_segment(self, s: &mut Session, part: &[u8]) -> bool {
            match self {
                Log::Open => s.push_segment(part),
                Log::B => s.compare_push_segment(part).unwrap(),
            }
        }

        /// Ends the read and returns the log's `LogInfo`, log B swapped in as the open log so
        /// the two are checked alike.
        fn finish(self, s: &mut Session) -> String {
            match self {
                Log::Open => s.finish(),
                Log::B => {
                    let info = s.compare_finish().unwrap();
                    assert!(s.swap_compare_log().is_ok());
                    info
                }
            }
        }
    }

    /// How a log read in parts went.
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Read {
        /// The start of the log showed it can't be read in parts.
        Whole,
        InParts,
        /// A part was refused, so the log would be read again whole.
        Refused,
    }

    /// The start of the file the web app gives each part worker for the header.
    const HEAD_BYTES: usize = 64 << 10;

    /// Reads `log` as the web app's workers do: the core reads its first `first` bytes up to the
    /// last line break, then each part starting at a byte of `starts` (anywhere, its lines
    /// running to the next) is read with up to `HEAD_BYTES` of the file's start as its head
    /// and joined on.
    fn read_in_parts(name: &str, log: &[u8], first: usize, starts: &[usize]) -> (Session, Read) {
        read_in_parts_as(Log::Open, name, log, first, starts)
    }

    fn read_in_parts_as(
        which: Log,
        name: &str,
        log: &[u8],
        first: usize,
        starts: &[usize],
    ) -> (Session, Read) {
        let first = &log[..first.min(log.len())];
        let cut = first
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |nl| nl + 1);
        let mut s = which.begin(name, log.len());
        which.push_chunk(&mut s, &log[..cut]);
        let Some(format) = which.segment_format(&s) else {
            which.push_chunk(&mut s, &log[cut..]);
            return (s, Read::Whole);
        };
        let mut bounds = vec![cut];
        bounds.extend(starts.iter().copied().filter(|&at| at > cut));
        bounds.push(log.len());
        for pair in bounds.windows(2) {
            let start = line_start_at_or_after(log, pair[0]);
            let end = line_start_at_or_after(log, pair[1]).max(start);
            let head = &log[..cut.min(HEAD_BYTES)];
            let part = parse_segment(&format, head, &log[start..end]).unwrap();
            if !which.push_segment(&mut s, &part) {
                return (s, Read::Refused);
            }
        }
        (s, Read::InParts)
    }

    /// Reads `log` whole and in parts from every start in `starts`, as the open log and as
    /// log B, and checks that the parts give the same log, with the same `LogInfo`, as each
    /// read whole. Returns how each read went, which is the same for both logs.
    fn assert_parts_read_as_whole(
        name: &str,
        log: &[u8],
        first: usize,
        starts: &[Vec<usize>],
    ) -> Vec<Read> {
        let mut reads = Vec::new();
        for starts in starts {
            let read_a = assert_parts_read_as_whole_as(Log::Open, name, log, first, starts);
            let read_b = assert_parts_read_as_whole_as(Log::B, name, log, first, starts);
            assert_eq!(read_a, read_b, "{name} from {first} in parts at {starts:?}");
            reads.push(read_a);
        }
        reads
    }

    fn assert_parts_read_as_whole_as(
        which: Log,
        name: &str,
        log: &[u8],
        first: usize,
        starts: &[usize],
    ) -> Read {
        let mut whole = which.begin(name, log.len());
        which.push_chunk(&mut whole, log);
        let info = which.finish(&mut whole);
        if let Log::B = which {
            // Only their frame stores' spare room differs: log B's is sized from the file.
            let without_heap = |info: &str| {
                let mut info: serde_json::Value = serde_json::from_str(info).unwrap();
                info.as_object_mut().unwrap().remove("heapBytes");
                info
            };
            let open = read_whole(name, log).finish();
            assert_eq!(without_heap(&info), without_heap(&open), "{name}: log B");
        }
        let (mut joined, read) = read_in_parts_as(which, name, log, first, starts);
        if read != Read::Refused {
            let what = format!("{which:?} {name} from {first} in parts at {starts:?}");
            assert_eq!(which.finish(&mut joined), info, "{what}");
            assert_eq!(joined.store.len(), whole.store.len(), "{what}");
            for i in 0..whole.store.len() {
                assert_eq!(
                    joined.store.frame(i),
                    whole.store.frame(i),
                    "{what}: frame {i}"
                );
                assert_eq!(
                    joined.store.remote_dlc(i),
                    whole.store.remote_dlc(i),
                    "{what}: frame {i}"
                );
            }
            assert_eq!(
                format!("{:?}", joined.store.ids()),
                format!("{:?}", whole.store.ids()),
                "{what}"
            );
            assert_eq!(joined.id_summary(), whole.id_summary(), "{what}");
        }
        read
    }

    /// Part starts every `step` bytes from `from`, offset by `phase`.
    fn every(step: usize, phase: usize, len: usize) -> Vec<usize> {
        (phase..len).step_by(step).collect()
    }

    /// Starts that land on each byte of `at` and its neighbours: mid-line, on the CR of a CRLF,
    /// just after the LF.
    fn around(at: &[usize]) -> Vec<Vec<usize>> {
        at.iter()
            .flat_map(|&at| (at.saturating_sub(2)..at + 3).map(|start| vec![start]))
            .collect()
    }

    fn candump_log() -> Vec<u8> {
        let mut log = String::from("\u{feff}");
        let mut ts = 0;
        let mut line = |log: &mut String, text: &str| {
            ts += 1;
            write!(log, "(1.{ts:06}) {text}\r\n").unwrap();
        };
        for i in 0..120 {
            line(
                &mut log,
                &format!("can0 123#{:02X}00{:02X}", i % 7, i * 3 % 256),
            );
            line(&mut log, &format!("can0 18FEF100#{:02X}FF", i % 3));
            if i == 100 {
                log.push_str("not a frame\r\n");
            }
        }
        for i in 0..60 {
            line(&mut log, &format!("can1 123#{:02X}", i % 5));
            line(&mut log, "can0 456#R");
            line(
                &mut log,
                &format!("can2 7FF##1{:02X}{}", i, "AB".repeat(31)),
            );
            line(&mut log, "can0 18ECFF21#200A0002FFCAFE00");
            line(&mut log, &format!("can0 18EBFF21#01{:02X}020304050607", i));
            if i == 30 {
                log.push_str(&"x".repeat(5000));
                log.push_str("\r\n\u{feff}(9.0) can0 123#00\r\n");
                log.push_str("(0.5) can0 123#FF\r\n");
            }
            line(&mut log, "can0 18EBFF21#0208090AFFFFFFFF");
            line(&mut log, "can0 20000004#0004000000000000");
        }
        log.push_str("(3.0) can3 123#01");
        log.into_bytes()
    }

    #[test]
    fn a_candump_log_reads_the_same_in_parts_wherever_they_start() {
        let log = candump_log();
        let len = log.len();
        let crlf: Vec<usize> = log
            .windows(2)
            .enumerate()
            .filter(|(_, pair)| pair == b"\r\n")
            .map(|(at, _)| at)
            .step_by(37)
            .collect();
        let mut starts = around(&crlf);
        for step in [41, 300, 997, 4096] {
            for phase in [0, 7, 19] {
                starts.push(every(step, 4500 + phase, len));
            }
        }
        for first in [4200, 4500, 9000] {
            let reads = assert_parts_read_as_whole("drive.log", &log, first, &starts);
            assert!(reads.iter().all(|read| *read == Read::InParts), "{reads:?}");
        }
    }

    #[test]
    fn bad_lines_and_transfers_in_later_parts_count_as_in_the_whole_log() {
        let log = candump_log();
        let mut whole = read_whole("drive.log", &log);
        let info: serde_json::Value = serde_json::from_str(&whole.finish()).unwrap();
        // The first bad line is past the first part, and transfers span parts.
        assert_eq!(
            info["firstRejection"],
            serde_json::json!([203, "expected '(' before timestamp"])
        );
        assert_eq!(info["rejected"], 3);
        assert_eq!(info["reassembledFrames"], 60);
        assert_eq!(
            info["channels"],
            serde_json::json!(["can0", "can1", "can2", "can3"])
        );
        let (mut joined, read) =
            read_in_parts("drive.log", &log, 4200, &every(1000, 4500, log.len()));
        assert_eq!(read, Read::InParts);
        assert_eq!(joined.finish(), whole.finish());
    }

    #[test]
    fn a_bus_name_that_is_not_utf8_is_one_bus_in_parts_as_in_the_whole_log() {
        let mut log = Vec::new();
        for i in 0..600 {
            let bus: &[u8] = if i % 3 == 0 { b"c\xff0" } else { b"can1" };
            log.extend_from_slice(format!("(1.{i:06}) ").as_bytes());
            log.extend_from_slice(bus);
            log.extend_from_slice(format!(" 123#{:02X}\n", i % 256).as_bytes());
        }
        let mut whole = read_whole("drive.log", &log);
        let info: serde_json::Value = serde_json::from_str(&whole.finish()).unwrap();
        assert_eq!(info["channels"], serde_json::json!(["c\u{fffd}0", "can1"]));
        let reads = assert_parts_read_as_whole(
            "drive.log",
            &log,
            4200,
            &[every(500, 4300, log.len()), every(4096, 4300, log.len())],
        );
        assert!(reads.iter().all(|read| *read == Read::InParts), "{reads:?}");
    }

    fn asc_log(timestamps: &str) -> Vec<u8> {
        let mut log = format!(
            "date Tue Sep 30 10:00:00.000 am 2025\n\
             base hex  timestamps {timestamps}\n\
             internal events logged\n\
             // version 9.0.0\n\
             Begin TriggerBlock Tue Sep 30 10:00:00.000 am 2025\n   \
             0.000000 Start of measurement\n"
        );
        for i in 0..400 {
            let t = f64::from(i) * 0.001;
            writeln!(
                log,
                "   {t:.6} 1  123             Rx   d 8 {:02X} 11 22 33 44 55 66 77",
                i % 9
            )
            .unwrap();
            writeln!(log, "   {t:.6} 2  18FEF100x       Tx   r").unwrap();
            if i % 50 == 7 {
                writeln!(log, "   {t:.6} CANFD 1 Rx  300  EngineData  1 0 d 32 {}  200000  400 3000 1234abcd 460800 2000000 460800 2000000", "0F ".repeat(32).trim_end()).unwrap();
                writeln!(log, "   {t:.6} 1  ErrorFrame").unwrap();
                // Events that hold no frame still move relative times on.
                writeln!(
                    log,
                    "   0.000123456 1  Statistic: D 1 R 0 XD 0 XR 0 E 0 O 0 B 0.00%"
                )
                .unwrap();
                writeln!(log, "   1.2.3 1  123             Rx   d 1 00").unwrap();
            }
            if i == 300 {
                log.push_str(
                    "End TriggerBlock\nBegin TriggerBlock Tue Sep 30 10:00:00.000 am 2025\n",
                );
                log.push_str("   0.3 1  XYZ             Rx   d 8 00\n");
            }
        }
        log.push_str("End TriggerBlock\n");
        log.into_bytes()
    }

    #[test]
    fn an_asc_log_reads_the_same_in_parts_with_absolute_or_relative_times() {
        for timestamps in ["absolute", "relative"] {
            let log = asc_log(timestamps);
            let header_end = log.windows(6).position(|w| w == b"0.0000").unwrap();
            let begin = log
                .windows(19)
                .rposition(|w| w == b"\nBegin TriggerBlock")
                .unwrap();
            let mut starts = around(&[header_end, 4200, 9000, begin, begin + 60]);
            for step in [53, 777, 5000] {
                starts.push(every(step, 4300, log.len()));
            }
            for first in [4200, begin + 60] {
                let reads = assert_parts_read_as_whole("drive.asc", &log, first, &starts);
                assert!(
                    reads.iter().all(|read| *read == Read::InParts),
                    "{timestamps} from {first}: {reads:?}"
                );
            }
        }
    }

    /// A relative ASC log that switches to absolute times for `between`, then back.
    fn asc_log_switching_to_absolute_times(between: &str) -> Vec<u8> {
        let mut log = String::from("base hex  timestamps relative\n");
        for i in 0..900 {
            if i == 500 {
                log.push_str("base hex  timestamps absolute\n");
                log.push_str(between);
                log.push_str("base hex  timestamps relative\n");
            }
            writeln!(log, "   0.001 1  123  Rx   d 1 {:02X}", i % 256).unwrap();
        }
        log.into_bytes()
    }

    #[test]
    fn a_relative_asc_part_with_a_frame_at_an_absolute_time_between_its_frames_is_refused() {
        let log = asc_log_switching_to_absolute_times("   9.5 1  100  Rx   d 0\n");
        // The part read from 4300 counts its first frames from the sum before it, then one
        // that isn't, then more that are.
        let reads = assert_parts_read_as_whole("drive.asc", &log, 4200, &[vec![4300]]);
        assert_eq!(reads, [Read::Refused]);
        // Parts that split the frames that are from those that aren't join.
        let switch = log.windows(8).position(|w| w == b"absolute").unwrap();
        let reads = assert_parts_read_as_whole(
            "drive.asc",
            &log,
            4200,
            &[vec![switch - 300, switch + 60], vec![switch + 60]],
        );
        assert!(reads.iter().all(|read| *read == Read::InParts), "{reads:?}");
    }

    #[test]
    fn a_relative_asc_part_that_switches_to_absolute_times_and_back_between_frames_joins() {
        // An event that holds no frame doesn't move the sum in absolute times.
        let log = asc_log_switching_to_absolute_times("   9.5 Start of measurement\n");
        let reads = assert_parts_read_as_whole("drive.asc", &log, 4200, &[vec![4300]]);
        assert_eq!(reads, [Read::InParts]);
    }

    #[test]
    fn relative_asc_times_that_overflow_are_refused_in_parts() {
        let mut log = String::from("base hex  timestamps relative\n");
        for i in 0..900 {
            // The sum passes the largest time an i64 holds in nanoseconds, which the whole file
            // saturates.
            let t = if i < 600 { "0.001" } else { "4000000000" };
            writeln!(log, "   {t} 1  123  Rx   d 1 {:02X}", i % 256).unwrap();
        }
        let log = log.into_bytes();
        let near_end = log.len() - 200;
        let reads = assert_parts_read_as_whole(
            "drive.asc",
            &log,
            4200,
            &[every(1000, 4300, log.len()), vec![near_end]],
        );
        assert_eq!(reads, [Read::Refused, Read::Refused]);
        // The parts before the sum overflows join.
        let before = log.windows(10).position(|w| w == b"4000000000").unwrap();
        let reads = assert_parts_read_as_whole(
            "drive.asc",
            &log[..before],
            4200,
            &[every(1000, 4300, before)],
        );
        assert_eq!(reads, [Read::InParts]);
    }

    #[test]
    fn a_trc_log_reads_the_same_in_parts() {
        let mut log = String::from(
            ";$FILEVERSION=2.1\r\n\
             ;$STARTTIME=45930.5\r\n\
             ;$COLUMNS=N,O,T,B,I,d,R,L,D\r\n\
             ;\r\n\
             ;---+-- ------+------ +- +- --+----- +- +- +--- +- -- -- -- -- -- -- --\r\n",
        );
        for i in 0..300 {
            let bus = 1 + i / 100;
            writeln!(
                log,
                "{:>7} {:>13.3} DT {bus}  0123 Rx -  8  {:02X} 11 22 33 44 55 66 77\r",
                i + 1,
                f64::from(i) * 1.5,
                i % 11
            )
            .unwrap();
            if i == 200 {
                log.push_str("    999      9999.000 DT 1  0123 Rx -  8  00 11 ZZ\r\n");
            }
        }
        let log = log.into_bytes();
        let starts = vec![every(61, 4200, log.len()), every(2000, 4321, log.len())];
        let reads = assert_parts_read_as_whole("drive.trc", &log, 4200, &starts);
        assert!(reads.iter().all(|read| *read == Read::InParts), "{reads:?}");
    }

    #[test]
    fn a_csv_part_read_before_its_time_unit_was_known_is_refused() {
        let header = "Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8\r\n";
        let mut log = String::from(header);
        for i in 0..400 {
            // Whole zeros don't tell the unit; the first other time does, in microseconds.
            let t = if i < 150 { 0 } else { 1_000_000 + i * 500 };
            writeln!(
                log,
                "{t},{:08X},false,Rx,{},8,00,11,22,33,44,55,66,{:02X}\r",
                0x100 + i % 4,
                i / 200,
                i % 256
            )
            .unwrap();
        }
        let log = log.into_bytes();
        let reads =
            assert_parts_read_as_whole("drive.csv", &log, 4200, &[every(3000, 4300, log.len())]);
        assert_eq!(reads, [Read::Refused]);
        // Once the first part has decided the unit, the parts read as the whole.
        let reads = assert_parts_read_as_whole(
            "drive.csv",
            &log,
            9000,
            &[every(3000, 9100, log.len()), every(97, 9100, log.len())],
        );
        assert!(reads.iter().all(|read| *read == Read::InParts), "{reads:?}");
    }

    #[test]
    fn only_text_logs_read_up_to_a_line_break_and_blf_logs_cut_where_objects_end_are_read_in_parts()
    {
        let mut s = Session::new();
        s.set_file_name("drive.mf4");
        assert_eq!(s.object_cuts(b"MDF     4.10", 1000.0), None);
        s.push_chunk(b"MDF     4.10");
        s.push_chunk(&[0; 5000]);
        assert_eq!(s.segment_format(), None);

        let mut s = Session::new();
        s.set_file_name("drive.blf");
        let log = [b"LOGG".as_slice(), &[0; 5000]].concat();
        assert_eq!(s.object_cuts(&log, 1000.0), Some(Vec::new()));
        s.push_chunk(&log);
        assert_eq!(s.segment_format(), None);
        let part = read_part(Format::Candump, b"", b"(1.0) can0 123#00\n").unwrap();
        assert!(!s.push_segment(&part));
        assert_eq!(s.compare_segment_format(), None, "no log B");
        assert!(!s.compare_push_segment(&part).unwrap());

        // A BLF file cut where the web app didn't ask where its objects end.
        let log = blf::file(&blf::containers(&blf::frames(40), &[300], 0));
        let mut s = Session::new();
        s.set_file_name("drive.blf");
        let end = blf::object_ends(&log)[0] as usize;
        s.push_chunk(&log[..end]);
        assert_eq!(s.segment_format(), None);

        let log = candump_log();
        let mut s = Session::new();
        s.set_file_name("drive.log");
        assert_eq!(s.segment_format(), None, "the format is not known yet");
        let line_end = log[..5000].iter().rposition(|&b| b == b'\n').unwrap() + 1;
        s.push_chunk(&log[..line_end - 3]);
        assert_eq!(s.segment_format(), None, "mid-line");
        s.push_chunk(&log[line_end - 3..line_end]);
        assert_eq!(s.segment_format().as_deref(), Some("candump"));
        let part = read_part(Format::Candump, b"", b"(1.0) can0 123#00\n").unwrap();
        // A part in the format from before relative ASC times were carried, and one cut short.
        let mut old = part.clone();
        old[..4].copy_from_slice(b"FCP1");
        assert!(!s.push_segment(&old));
        assert!(!s.push_segment(&part[..part.len() - 1]));
        assert!(s.push_segment(&part));
        assert!(read_part(Format::Blf, b"", b"").is_none());
        // A BLF part joined onto a candump log, and the other way round.
        let log = blf::file(&blf::containers(&blf::frames(40), &[300], 0));
        let blf_part = read_part(Format::Blf, &log, &log[144..]).unwrap();
        assert!(!s.push_segment(&blf_part));
        let end = blf::object_ends(&log)[1] as usize;
        let (mut s, read) = read_blf_in_parts("drive.blf", &log, &[end]);
        assert_eq!(read, Read::InParts);
        assert!(!s.push_segment(&part));
    }

    /// The web app's read when no object ends in the start it reads: nothing is pushed for
    /// the core's own part, then the whole file in chunks.
    #[test]
    fn a_blf_file_with_no_object_end_in_its_first_part_is_read_whole_by_its_content() {
        let one_container = blf::file(&blf::containers(&blf::frames(300), &[1 << 20], 0));
        let mut bad_header_size = one_container.clone();
        bad_header_size[4..8].copy_from_slice(&7u32.to_le_bytes());
        for log in [one_container, bad_header_size] {
            for which in [Log::Open, Log::B] {
                let mut whole = which.begin("drive.bin", log.len());
                which.push_chunk(&mut whole, &log);
                let info = which.finish(&mut whole);

                let mut s = which.begin("drive.bin", log.len());
                let first = &log[..1000];
                assert_eq!(which.object_cuts(&mut s, first, 1000.0), Some(Vec::new()));
                which.push_chunk(&mut s, &first[..0]);
                which.push_chunk(&mut s, first);
                which.push_chunk(&mut s, &log[first.len()..]);
                assert_eq!(which.finish(&mut s), info, "{which:?}");
                assert_eq!(
                    format!("{:?}", s.store.ids()),
                    format!("{:?}", whole.store.ids())
                );
            }
        }
    }

    /// BLF files for the tests: objects as CANoe writes them, packed into log containers that
    /// split objects anywhere.
    mod blf {
        use super::Rng;

        pub(super) const ZLIB: u16 = 2;
        const CAN_MESSAGE: u32 = 1;
        const CAN_ERROR: u32 = 2;
        const CAN_ERROR_EXT: u32 = 73;
        const CAN_MESSAGE2: u32 = 86;
        const CAN_FD_MESSAGE: u32 = 100;
        const CAN_FD_MESSAGE_64: u32 = 101;
        const CAN_FD_ERROR_64: u32 = 104;
        const LOG_CONTAINER: u32 = 10;
        const APP_TEXT: u32 = 65;
        const NS: u32 = 2;
        const TEN_US: u32 = 1;

        pub(super) fn header() -> Vec<u8> {
            let mut header = vec![0u8; 144];
            header[..4].copy_from_slice(b"LOGG");
            header[4..8].copy_from_slice(&144u32.to_le_bytes());
            for (i, field) in [2025u16, 9, 2, 30, 12, 0, 0, 500].iter().enumerate() {
                header[40 + i * 2..42 + i * 2].copy_from_slice(&field.to_le_bytes());
            }
            header
        }

        pub(super) fn file(objects: &[u8]) -> Vec<u8> {
            [header(), objects.to_vec()].concat()
        }

        /// An object with a version 1 header, followed by `padding` zero bytes.
        pub(super) fn object(
            kind: u32,
            flags: u32,
            timestamp: u64,
            body: &[u8],
            padding: usize,
        ) -> Vec<u8> {
            let size = 32 + body.len();
            let mut out = Vec::with_capacity(size + padding);
            out.extend_from_slice(b"LOBJ");
            out.extend_from_slice(&32u16.to_le_bytes());
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&(size as u32).to_le_bytes());
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(&flags.to_le_bytes());
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&timestamp.to_le_bytes());
            out.extend_from_slice(body);
            out.resize(out.len() + padding, 0);
            out
        }

        /// A log container holding `payload`, zlib-compressed or not, or with an unknown
        /// compression (which the parser rejects).
        pub(super) fn container(compression: u16, payload: &[u8]) -> Vec<u8> {
            let data = match compression {
                ZLIB => miniz_oxide::deflate::compress_to_vec_zlib(payload, 1),
                _ => payload.to_vec(),
            };
            let mut body = Vec::new();
            body.extend_from_slice(&compression.to_le_bytes());
            body.extend_from_slice(&[0; 6]);
            body.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            body.extend_from_slice(&[0; 4]);
            body.extend_from_slice(&data);
            let mut out = Vec::new();
            out.extend_from_slice(b"LOBJ");
            out.extend_from_slice(&16u16.to_le_bytes());
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&((16 + body.len()) as u32).to_le_bytes());
            out.extend_from_slice(&LOG_CONTAINER.to_le_bytes());
            out.extend_from_slice(&body);
            let padding = out.len() % 4;
            out.resize(out.len() + padding, 0);
            out
        }

        /// `objects` packed into containers of the sizes in `sizes`, over and over, compressed
        /// every other container from `phase`.
        pub(super) fn containers(objects: &[u8], sizes: &[usize], phase: usize) -> Vec<u8> {
            let mut out = Vec::new();
            let mut at = 0;
            for n in phase.. {
                if at >= objects.len() {
                    break;
                }
                let end = (at + sizes[n % sizes.len()]).min(objects.len());
                out.extend(container(
                    if n % 2 == 0 { ZLIB } else { 0 },
                    &objects[at..end],
                ));
                at = end;
            }
            out
        }

        fn message(channel: u16, flags: u8, dlc: u8, id: u32, data: &[u8]) -> Vec<u8> {
            let mut body = Vec::new();
            body.extend_from_slice(&channel.to_le_bytes());
            body.push(flags);
            body.push(dlc);
            body.extend_from_slice(&id.to_le_bytes());
            body.extend_from_slice(data);
            body.resize(16, 0);
            body
        }

        fn fd_message_64(channel: u8, flags: u32, dlc: u8, id: u32, data: &[u8]) -> Vec<u8> {
            let mut body = vec![channel, dlc, data.len() as u8, 0];
            body.extend_from_slice(&id.to_le_bytes());
            body.extend_from_slice(&0u32.to_le_bytes());
            body.extend_from_slice(&flags.to_le_bytes());
            body.extend_from_slice(&[0; 18]);
            body.push(u8::from(flags & 1 != 0));
            body.push(0);
            body.extend_from_slice(&0u32.to_le_bytes());
            body.extend_from_slice(data);
            body
        }

        /// `count` classic frames on two buses, J1939 transfers among them.
        pub(super) fn frames(count: u64) -> Vec<u8> {
            frames_from(0, count)
        }

        /// [`frames`] numbered, and timed, from `first`.
        pub(super) fn frames_from(first: u64, count: u64) -> Vec<u8> {
            let mut out = Vec::new();
            for i in first..first + count {
                let body = match i % 10 {
                    3 => message(1, 0, 8, 0x98EC_FF21, &[0x20, 10, 0, 2, 0xFF, 0xCA, 0xFE, 0]),
                    4 => message(1, 0, 8, 0x98EB_FF21, &[1, 1, 2, 3, 4, 5, 6, 7]),
                    5 => message(1, 0, 8, 0x98EB_FF21, &[2, 8, 9, 10, 0xFF, 0xFF, 0xFF, 0xFF]),
                    _ => message(
                        1 + (i % 2) as u16,
                        0,
                        8,
                        0x100 + (i % 7) as u32,
                        &[i as u8; 8],
                    ),
                };
                out.extend(object(CAN_MESSAGE, NS, 1000 * i, &body, 0));
            }
            out
        }

        /// One random frame object, or now and then an object that holds none or is broken.
        pub(super) fn random_object(rng: &mut Rng, t: u64) -> Vec<u8> {
            let channel = 1 + rng.below(3);
            let ext = rng.chance(30);
            let id = if ext {
                rng.below(0x2000_0000) as u32 | 0x8000_0000
            } else {
                rng.below(0x800) as u32
            };
            let data: Vec<u8> = (0..64).map(|_| rng.below(256) as u8).collect();
            let (units, timestamp) = if rng.chance(10) {
                (TEN_US, t / 10_000)
            } else {
                (NS, t)
            };
            let padding = if rng.chance(70) { rng.below(4) } else { 0 };
            let (kind, body) = match rng.below(100) {
                0..=49 => {
                    let flags = if rng.chance(10) { 0x80 } else { 0 } | u8::from(rng.chance(20));
                    let kind = if rng.chance(20) {
                        CAN_MESSAGE2
                    } else {
                        CAN_MESSAGE
                    };
                    (
                        kind,
                        message(channel as u16, flags, rng.below(9) as u8, id, &data[..8]),
                    )
                }
                50..=69 => {
                    let flags = [0x1000, 0x1000 | 0x2000, 0x1000 | 0x4000, 0, 0x10][rng.below(5)];
                    let dlc = rng.below(16) as u8;
                    let len = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64][dlc as usize];
                    let kind = CAN_FD_MESSAGE_64;
                    (
                        kind,
                        fd_message_64(channel as u8, flags, dlc, id, &data[..len]),
                    )
                }
                70..=74 => {
                    let mut body = message(channel as u16, 0, rng.below(16) as u8, id, &[]);
                    body.truncate(8);
                    body.extend_from_slice(&[0; 5]);
                    body.push([0, 1, 3, 5, 7][rng.below(5)]);
                    body.extend_from_slice(&[0; 6]);
                    body.extend_from_slice(&data);
                    (CAN_FD_MESSAGE, body)
                }
                75..=79 => {
                    let mut body = vec![0u8; 32];
                    body[..2].copy_from_slice(&(channel as u16).to_le_bytes());
                    body[10] = rng.below(9) as u8;
                    body[24..].copy_from_slice(&data[..8]);
                    (CAN_ERROR_EXT, body)
                }
                80..=82 => (CAN_ERROR, vec![channel as u8, 0, 0, 0]),
                83..=86 => {
                    let mut body = vec![channel as u8, 15, rng.below(20) as u8, 0];
                    body.resize(44, 0);
                    body[8..10].copy_from_slice(&[0x80 | 0x40, 0]);
                    body.extend_from_slice(&data[..20]);
                    (CAN_FD_ERROR_64, body)
                }
                87..=90 => (APP_TEXT, data[..rng.below(40)].to_vec()),
                // Too short for its kind.
                91 => (CAN_MESSAGE, data[..rng.below(16)].to_vec()),
                92 => {
                    // Stray bytes, then an object whose header is bad.
                    let mut out = data[..1 + rng.below(9)].to_vec();
                    out.extend_from_slice(b"LOBJ\x08\x00\x01\x00");
                    return out;
                }
                _ => {
                    // A J1939 BAM of 10 bytes in two packets.
                    let source = 0x21 + rng.below(2) as u32;
                    let mut out = Vec::new();
                    let packets: [&[u8]; 3] = [
                        &[0x20, 10, 0, 2, 0xFF, 0xCA, 0xFE, 0],
                        &[1, 1, 2, 3, 4, 5, 6, 7],
                        &[2, 8, 9, 10, 0xFF, 0xFF, 0xFF, 0xFF],
                    ];
                    for (n, packet) in packets.iter().enumerate() {
                        if n > 0 && rng.chance(10) {
                            continue;
                        }
                        let pgn = if n == 0 { 0x98EC_FF00 } else { 0x98EB_FF00 };
                        let body = message(1, 0, 8, pgn | source, packet);
                        out.extend(object(CAN_MESSAGE, NS, t + n as u64, &body, 0));
                    }
                    return out;
                }
            };
            object(kind, units, timestamp, &body, padding)
        }

        /// A random file: frame objects in containers of random sizes, compressed or not, now
        /// and then a container that doesn't inflate, stray bytes between containers and,
        /// in some files, frame objects between the containers or none in containers at all.
        pub(super) fn random(rng: &mut Rng) -> Vec<u8> {
            let mut objects = Vec::new();
            let mut t = 5_000_000_000u64;
            for _ in 0..200 + rng.below(3000) {
                t += 1 + rng.below(3_000_000) as u64;
                let back = if rng.chance(2) {
                    rng.below(50_000_000) as u64
                } else {
                    0
                };
                objects.extend(random_object(rng, t - back));
            }
            let loose = rng.chance(10);
            let mixed = !loose && rng.chance(20);
            let mut out = header();
            if loose {
                out.extend(objects);
            } else {
                let big = rng.chance(50);
                let mut at = 0;
                while at < objects.len() {
                    let size = if big {
                        200 + rng.below(4000)
                    } else {
                        1 + rng.below(400)
                    };
                    let end = (at + size).min(objects.len());
                    let compression = match rng.below(100) {
                        0 => 7,
                        1..=50 => ZLIB,
                        _ => 0,
                    };
                    out.extend(container(compression, &objects[at..end]));
                    at = end;
                    if rng.chance(2) {
                        out.extend((0..rng.below(8)).map(|_| rng.below(256) as u8));
                    }
                    if mixed && rng.chance(10) {
                        out.extend(random_object(rng, t));
                    }
                }
            }
            if rng.chance(10) {
                // The file ends inside an object.
                out.truncate(out.len() - 1 - rng.below(30.min(out.len() - 145)));
            }
            out
        }

        /// Where each object of the file ends, as the parser reads them.
        pub(super) fn object_ends(log: &[u8]) -> Vec<f64> {
            let mut s = crate::Session::new();
            s.set_file_name("drive.blf");
            s.object_cuts(log, 1.0).unwrap()
        }
    }

    /// Reads a BLF file as the web app's workers do: the core reads it up to the first of
    /// `cuts` (places where objects end), then each part between two cuts, and the last to the
    /// end of the file, is read with up to `HEAD_BYTES` of the file's start as its head and
    /// joined on.
    fn read_blf_in_parts(name: &str, log: &[u8], cuts: &[usize]) -> (Session, Read) {
        read_blf_in_parts_as(Log::Open, name, log, cuts)
    }

    fn read_blf_in_parts_as(which: Log, name: &str, log: &[u8], cuts: &[usize]) -> (Session, Read) {
        let mut s = which.begin(name, log.len());
        which.object_cuts(&mut s, log, 1.0).unwrap();
        let Some(&first) = cuts.first() else {
            which.push_chunk(&mut s, log);
            return (s, Read::Whole);
        };
        which.push_chunk(&mut s, &log[..first]);
        let format = which.segment_format(&s).expect("cut where an object ends");
        let head = &log[..first.min(HEAD_BYTES)];
        let mut bounds = cuts.to_vec();
        bounds.push(log.len());
        for pair in bounds.windows(2) {
            let part = parse_segment(&format, head, &log[pair[0]..pair[1]]).unwrap();
            if !which.push_segment(&mut s, &part) {
                return (s, Read::Refused);
            }
        }
        (s, Read::InParts)
    }

    /// The cuts the web app reads a file with: from `ObjectCuts`, in chunks of `chunk` bytes.
    fn cuts_by_size(log: &[u8], part_bytes: usize, chunk: usize) -> Vec<usize> {
        let mut s = Session::new();
        s.set_file_name("drive.blf");
        let mut cuts = Vec::new();
        for bytes in log.chunks(chunk) {
            cuts.extend(s.object_cuts(bytes, part_bytes as f64).unwrap());
        }
        cuts.into_iter().map(|cut| cut as usize).collect()
    }

    /// Reads `log` whole and in parts at each of `cuts`, as the open log and as log B, and
    /// checks that the parts give the same log, with the same `LogInfo`. Returns how each read
    /// went, which is the same for both logs.
    fn assert_blf_parts_read_as_whole(log: &[u8], cuts: &[Vec<usize>]) -> Vec<Read> {
        let mut wholes = [Log::Open, Log::B].map(|which| {
            let mut whole = which.begin("drive.blf", log.len());
            which.push_chunk(&mut whole, log);
            let info = which.finish(&mut whole);
            (which, whole, info)
        });
        let mut reads = Vec::new();
        for cuts in cuts {
            let mut read_as = Vec::new();
            for (which, whole, info) in &mut wholes {
                let (mut joined, read) = read_blf_in_parts_as(*which, "drive.blf", log, cuts);
                if read != Read::Refused {
                    let what = format!("{which:?} cut at {cuts:?}");
                    assert_eq!(which.finish(&mut joined), *info, "{what}");
                    assert_same_store(&joined, whole, &what);
                }
                read_as.push(read);
            }
            assert_eq!(read_as[0], read_as[1], "cut at {cuts:?}");
            reads.push(read_as[0]);
        }
        reads
    }

    fn assert_same_store(joined: &Session, whole: &Session, what: &str) {
        assert_eq!(joined.store.len(), whole.store.len(), "{what}");
        for i in 0..whole.store.len() {
            assert_eq!(
                joined.store.frame(i),
                whole.store.frame(i),
                "{what}: frame {i}"
            );
            assert_eq!(
                joined.store.remote_dlc(i),
                whole.store.remote_dlc(i),
                "{what}: frame {i}"
            );
        }
        assert_eq!(
            format!("{:?}", joined.store.ids()),
            format!("{:?}", whole.store.ids()),
            "{what}"
        );
        assert_eq!(joined.id_summary(), whole.id_summary(), "{what}");
    }

    #[test]
    fn a_blf_file_reads_the_same_in_parts_wherever_its_objects_end() {
        let objects = blf::frames(300);
        for sizes in [vec![57, 300, 1000], vec![5000], vec![13]] {
            let log = blf::file(&blf::containers(&objects, &sizes, 1));
            let ends = blf::object_ends(&log);
            let ends: Vec<usize> = ends.iter().map(|&end| end as usize).collect();
            let mut cuts: Vec<Vec<usize>> = ends.iter().step_by(3).map(|&end| vec![end]).collect();
            cuts.push(ends.clone());
            for step in [2, 3, 7] {
                cuts.push(ends.iter().copied().step_by(step).collect());
            }
            for (part_bytes, chunk) in [(200, 100), (1000, 333), (3000, 4096), (1, 7)] {
                cuts.push(cuts_by_size(&log, part_bytes, chunk));
            }
            let reads = assert_blf_parts_read_as_whole(&log, &cuts);
            assert!(
                reads.iter().all(|read| *read == Read::InParts),
                "{sizes:?}: {reads:?}"
            );
        }
    }

    #[test]
    fn blf_objects_spanning_parts_count_as_in_the_whole_file() {
        // A container that doesn't inflate, stray bytes between objects in containers, an
        // object cut short at the end of the file.
        let mut objects = blf::frames(100);
        objects.extend_from_slice(b"stray");
        objects.extend(blf::frames_from(100, 100));
        let mut log = blf::file(&blf::containers(&objects, &[700], 0));
        log.extend(blf::container(7, b"whatever"));
        let mut tail = blf::container(0, &blf::frames(3));
        tail.truncate(tail.len() - 10);
        log.extend(tail);
        let mut whole = read_whole("drive.blf", &log);
        let info: serde_json::Value = serde_json::from_str(&whole.finish()).unwrap();
        assert_eq!(info["rejected"], 3, "{info}");
        assert_eq!(
            info["firstRejection"],
            serde_json::json!([101, "stray bytes between objects"])
        );
        assert_eq!(info["reassembledFrames"], 20);
        assert_eq!(info["channels"], serde_json::json!(["can1", "can2"]));
        let ends: Vec<usize> = blf::object_ends(&log)
            .iter()
            .map(|&end| end as usize)
            .collect();
        let reads = assert_blf_parts_read_as_whole(
            &log,
            &[
                ends.clone(),
                ends[1..].to_vec(),
                vec![ends[3], ends[ends.len() - 1]],
            ],
        );
        assert!(reads.iter().all(|read| *read == Read::InParts), "{reads:?}");
    }

    #[test]
    fn a_blf_part_that_takes_bytes_inside_an_object_for_one_is_refused() {
        // An object whose data looks like two objects, split across containers before them.
        let mut fake = b"LOBJ\x10\x00\x01\x00\x18\x00\x00\x00\x01\x00\x00\x00".to_vec();
        fake.resize(24, 0);
        fake.extend_from_slice(b"LOBJ");
        let mut data = vec![0u8; 8];
        data.extend(&fake);
        data.resize(64, 0);
        let mut body = vec![1, 15, 64, 0];
        body.extend_from_slice(&0x123u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&0x1000u32.to_le_bytes());
        body.resize(40, 0);
        body.extend(&data);
        let odd = blf::object(101, 2, 5, &body, 0);
        let mut objects = blf::frames(50);
        let split = objects.len() + 40;
        objects.extend(odd);
        objects.extend(blf::frames_from(50, 50));
        let first = blf::container(0, &objects[..split]);
        let log = blf::file(&[first.clone(), blf::container(0, &objects[split..])].concat());
        let ends: Vec<usize> = blf::object_ends(&log).iter().map(|&e| e as usize).collect();
        assert_eq!(ends, [144 + first.len(), log.len()]);
        let reads = assert_blf_parts_read_as_whole(&log, &[vec![ends[0]]]);
        assert_eq!(reads, [Read::Refused]);
        // Read whole, the data is the frame's.
        let mut whole = read_whole("drive.blf", &log);
        let info: serde_json::Value = serde_json::from_str(&whole.finish()).unwrap();
        assert_eq!(
            (info["frames"].clone(), info["rejected"].clone()),
            (111.into(), 0.into())
        );
    }

    #[test]
    fn random_blf_files_read_the_same_in_parts_as_whole() {
        let iterations = if cfg!(debug_assertions) { 6 } else { 150 };
        let mut in_parts = 0;
        for seed in 1..=iterations {
            let mut rng = Rng(0x2545_F491_4F6C_DD1D ^ seed);
            let log = blf::random(&mut rng);
            let ends: Vec<usize> = blf::object_ends(&log).iter().map(|&e| e as usize).collect();
            let mut cuts = Vec::new();
            for _ in 0..3 {
                let part_bytes = 1 + rng.below(log.len() / 4);
                let chunk = 1 + rng.below(log.len());
                cuts.push(cuts_by_size(&log, part_bytes, chunk));
            }
            for _ in 0..3 {
                if ends.is_empty() {
                    break;
                }
                let mut at: Vec<usize> = (0..1 + rng.below(30))
                    .map(|_| ends[rng.below(ends.len())])
                    .collect();
                at.sort_unstable();
                at.dedup();
                cuts.push(at);
            }
            let reads = assert_blf_parts_read_as_whole(&log, &cuts);
            in_parts += reads.iter().filter(|read| **read == Read::InParts).count();
        }
        // Refusing every part would pass the checks above.
        assert!(in_parts > iterations as usize * 4, "{in_parts}");
    }

    /// A seeded xorshift generator, so a failing case can be read again from its seed.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }

        fn chance(&mut self, percent: usize) -> bool {
            self.below(100) < percent
        }

        fn hex(&mut self, bytes: usize, sep: &str) -> String {
            (0..bytes)
                .map(|_| format!("{:02X}", self.below(256)))
                .collect::<Vec<_>>()
                .join(sep)
        }
    }

    /// A log in `format` of random frames (error and CAN FD frames among them), buses, J1939
    /// transfers with packets sometimes lost, bad lines, CRLFs, times that sometimes go back,
    /// and sometimes a byte order mark.
    fn random_log(rng: &mut Rng, format: &str) -> Vec<u8> {
        let bom: &[u8] = if rng.chance(30) {
            "\u{feff}".as_bytes()
        } else {
            b""
        };
        let relative = format == "asc" && rng.chance(50);
        let mut log: Vec<u8> = match format {
            "asc" => format!(
                "date Tue Sep 30 10:00:00.000 am 2025\nbase hex  timestamps {}\n\
                 internal events logged\nBegin TriggerBlock Tue Sep 30 10:00:00.000 am 2025\n",
                if relative { "relative" } else { "absolute" }
            )
            .into_bytes(),
            "trc" => b";$FILEVERSION=2.1\r\n;$STARTTIME=45930.5\r\n;$COLUMNS=N,O,T,B,I,d,R,L,D\r\n"
                .to_vec(),
            "csv" => b"Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8\r\n".to_vec(),
            _ => Vec::new(),
        };
        log.splice(0..0, bom.iter().copied());
        let mut t = 1_000_000u64;
        // Some logs run past the 64 KiB head.
        let lines = 400 + rng.below(4000);
        let mut transfer = 0;
        for n in 0..lines {
            t += 1 + rng.below(3000) as u64;
            let back = if rng.chance(2) {
                rng.below(500_000) as u64
            } else {
                0
            };
            let us = t - back.min(t - 1);
            let bus = rng.below(3);
            let ext = rng.chance(30);
            let mut id = if ext {
                rng.below(0x2000_0000) as u32
            } else {
                rng.below(0x800) as u32
            };
            let len = rng.below(9);
            let mut data = rng.hex(len, " ");
            // A J1939 BAM of 10 bytes in two packets, from one of two sources.
            if matches!(format, "candump" | "asc") && transfer == 0 && rng.chance(5) {
                transfer = 3;
            }
            let j1939 = transfer > 0;
            if j1939 {
                let source = if n % 2 == 0 { 0x21 } else { 0x22 };
                id = match transfer {
                    3 => 0x18EC_FF00 | source,
                    _ => 0x18EB_FF00 | source,
                };
                data = match transfer {
                    3 => "20 0A 00 02 FF CA FE 00".to_owned(),
                    2 => format!("01 {}", rng.hex(7, " ")),
                    _ => format!("02 {}", rng.hex(7, " ")),
                };
                transfer -= 1;
                if transfer < 2 && rng.chance(15) {
                    continue;
                }
            }
            let eol: &[u8] = if rng.chance(20) { b"\r\n" } else { b"\n" };
            if rng.chance(3) {
                log.extend_from_slice(b"not a frame at all");
                log.extend_from_slice(eol);
                continue;
            }
            if rng.chance(2) {
                log.extend_from_slice(eol);
            }
            let compact = data.replace(' ', "");
            let line = match format {
                "candump" => {
                    let bus = ["can0", "vcan1", "c\u{fffd}2"][bus];
                    let plain = !j1939;
                    let (id, frame) = if plain && rng.chance(3) {
                        (0x2000_0000 | id & 0x1FF, format!("#{}", rng.hex(8, "")))
                    } else if plain && rng.chance(8) {
                        let len = [0, 1, 8, 12, 16, 32, 64][rng.below(7)];
                        (id, format!("##{}{}", rng.below(4), rng.hex(len, "")))
                    } else if plain && rng.chance(5) {
                        (id, "#R".to_owned())
                    } else {
                        (id, format!("#{compact}"))
                    };
                    let id = if !plain || id > 0x7FF || ext {
                        format!("{id:08X}")
                    } else {
                        format!("{id:03X}")
                    };
                    format!(
                        "({}.{:06}) {bus} {id}{frame}",
                        us / 1_000_000,
                        us % 1_000_000
                    )
                }
                "asc" => {
                    let id = if ext {
                        format!("{id:X}x")
                    } else {
                        format!("{id:X}")
                    };
                    let t = if relative {
                        rng.below(3000) as f64 / 1e6
                    } else {
                        us as f64 / 1e6
                    };
                    if relative && rng.chance(1) {
                        log.extend_from_slice(
                            b"End TriggerBlock\nBegin TriggerBlock Tue Sep 30 10:00:00.000 am 2025\n",
                        );
                    }
                    let bus = bus + 1;
                    if j1939 {
                        format!("   {t:.6} {bus}  {id:<15} Rx   d 8 {data}")
                    } else if rng.chance(3) {
                        format!("   {t:.6} {bus}  ErrorFrame")
                    } else if rng.chance(5) {
                        format!("   {t:.6} {bus}  {id:<15} Tx   r")
                    } else {
                        format!("   {t:.6} {bus}  {id:<15} Rx   d {len} {data}")
                    }
                }
                "trc" => format!(
                    "{:>7} {:>13.3} DT {}  {} Rx -  {len}  {data}",
                    n + 1,
                    us as f64 / 1000.0,
                    bus + 1,
                    if ext {
                        format!("{id:08X}")
                    } else {
                        format!("{id:04X}")
                    }
                ),
                _ => {
                    let mut fields: Vec<String> = data.split(' ').map(str::to_owned).collect();
                    fields.retain(|f| !f.is_empty());
                    fields.resize(8, String::new());
                    format!("{us},{id:08X},{ext},Rx,{bus},{len},{}", fields.join(","))
                }
            };
            // Some candump lines get a bus name that is not UTF-8.
            let line = line.into_bytes();
            if let Some(at) = line.windows(3).position(|w| w == "\u{fffd}".as_bytes()) {
                log.extend_from_slice(&line[..at]);
                log.push(0xFF);
                log.extend_from_slice(&line[at + 3..]);
            } else {
                log.extend_from_slice(&line);
            }
            log.extend_from_slice(eol);
        }
        if format == "asc" {
            log.extend_from_slice(b"End TriggerBlock\n");
        }
        if rng.chance(50) {
            // No line break at the end.
            log.pop();
        }
        log
    }

    #[test]
    fn random_logs_read_the_same_in_parts_as_whole() {
        let iterations = if cfg!(debug_assertions) { 2 } else { 30 };
        let mut in_parts = BTreeMap::new();
        for seed in 1..=iterations {
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
            for (format, name) in [
                ("candump", "drive.log"),
                ("asc", "drive.asc"),
                ("trc", "drive.trc"),
                ("csv", "drive.csv"),
            ] {
                let log = random_log(&mut rng, format);
                let first = 4200 + rng.below(log.len() / 2);
                let mut starts = Vec::new();
                for _ in 0..4 {
                    let mut at: Vec<usize> = (0..1 + rng.below(40))
                        .map(|_| rng.below(log.len()))
                        .collect();
                    at.sort_unstable();
                    starts.push(at);
                }
                let reads = assert_parts_read_as_whole(name, &log, first, &starts);
                assert!(
                    !reads.contains(&Read::Whole) || format == "csv",
                    "seed {seed} {format}: {reads:?}"
                );
                *in_parts.entry(format).or_insert(0) +=
                    reads.iter().filter(|read| **read == Read::InParts).count();
            }
        }
        // Refusing every part would pass the checks above.
        assert!(
            in_parts.values().all(|&count| count > 0) && in_parts.len() == 4,
            "{in_parts:?}"
        );
    }
}

#[cfg(test)]
mod demo {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    use super::*;
    use crate::Session;

    const CHUNK: usize = 8 << 20;

    /// The demo log, or the log `DEMO_LOG` names (a BLF file too), read whole and then in parts
    /// on threads as the web app's workers read it, natively. Needs the demo log: `pnpm --dir
    /// web demo`, then `cargo test -p can-wasm --release -- --ignored --nocapture demo_in_parts`.
    #[test]
    #[ignore = "needs the generated demo log"]
    fn demo_in_parts() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let path =
            std::env::var("DEMO_LOG").unwrap_or_else(|_| format!("{root}/target/demo/demo.log"));
        let log = std::fs::read(&path).expect("demo log");
        let name = path.rsplit('/').next().unwrap();

        let started = Instant::now();
        let mut whole = Session::new();
        whole.set_file_name(name);
        log.chunks(CHUNK).for_each(|chunk| whole.push_chunk(chunk));
        let info = whole.finish();
        let whole_s = started.elapsed().as_secs_f64();
        println!("{name}: whole in {whole_s:.3} s");

        for workers in [2, 4, 8] {
            let started = Instant::now();
            let Some(mut s) = read_on_threads(name, &log, workers) else {
                println!("{name}: read whole, not in parts");
                return;
            };
            let joined = s.finish();
            let secs = started.elapsed().as_secs_f64();
            println!("{workers} workers: {secs:.3} s, {:.2}x", whole_s / secs);
            assert_eq!(joined, info);
            assert_eq!(
                format!("{:?}", s.store.ids()),
                format!("{:?}", whole.store.ids())
            );
        }
    }

    /// Parts of a BLF file, cut where its objects end, as the web app cuts them.
    const BLF_PART: usize = 2 << 20;

    /// None for a log that isn't read in parts.
    fn read_on_threads(name: &str, log: &[u8], workers: usize) -> Option<Session> {
        let mut s = Session::new();
        s.set_file_name(name);
        let first = &log[..CHUNK.min(log.len())];
        let cuts = s.object_cuts(first, BLF_PART as f64);
        let exact = cuts.is_some();
        let (cut, parts): (usize, Vec<(usize, usize)>) = match cuts {
            Some(mut cuts) => {
                for chunk in log[first.len()..].chunks(CHUNK) {
                    cuts.extend(s.object_cuts(chunk, BLF_PART as f64).unwrap());
                }
                let mut bounds: Vec<usize> = cuts.into_iter().map(|cut| cut as usize).collect();
                bounds.push(log.len());
                let parts = bounds.windows(2).map(|pair| (pair[0], pair[1])).collect();
                (bounds[0], parts)
            }
            None => {
                let cut = first
                    .iter()
                    .rposition(|&b| b == b'\n')
                    .map_or(0, |nl| nl + 1);
                let parts = (cut..log.len())
                    .step_by(CHUNK)
                    .map(|start| (start, (start + CHUNK).min(log.len())))
                    .collect();
                (cut, parts)
            }
        };
        s.push_chunk(&log[..cut]);
        let format = Format::from_name(&s.segment_format()?).unwrap();
        let head = &log[..cut.min(64 << 10)];
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let (sender, results) = mpsc::channel();
            for _ in 0..workers {
                let (sender, next, parts) = (sender.clone(), &next, &parts);
                scope.spawn(move || loop {
                    let k = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&(start, end)) = parts.get(k) else {
                        return;
                    };
                    let (start, end) = if exact {
                        (start, end)
                    } else {
                        let start = line_start(log, start);
                        (start, line_start(log, end).max(start))
                    };
                    let part = read_part(format, head, &log[start..end]).unwrap();
                    sender.send((k, part)).unwrap();
                });
            }
            drop(sender);
            let mut waiting = BTreeMap::new();
            let mut merged = 0;
            for (k, part) in results {
                waiting.insert(k, part);
                while let Some(part) = waiting.remove(&merged) {
                    assert!(s.push_segment(&part));
                    merged += 1;
                }
            }
        });
        Some(s)
    }

    fn line_start(log: &[u8], at: usize) -> usize {
        log[at - 1..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(log.len(), |nl| at + nl)
    }
}
