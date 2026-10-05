//! WebAssembly bindings for the web app. One [`Session`] lives in the core Web Worker and owns
//! the parsed log, the loaded databases and decoded signal series.
//!
//! Bulk data crosses the boundary as typed arrays; small structured results as JSON strings.

mod compare;
mod find;
mod series;

use can_core::{tp::MAX_TRANSFER, FrameStore, IdKey, ERR_FLAG, EXT_FLAG, MAX_PAYLOAD};
use can_dbc_model::{bits, ByteOrder, Database, MessageDef};
use can_formats::{mf4, AnyParser, Format, LogParser, ParseStats};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use find::Behaviour;
use series::Series;

/// Bytes per row returned by [`Session::rows`]; see `web/src/core/rows.ts` for the layout.
pub const ROW_STRIDE: usize = 96;

/// Rough bytes per frame of a log in each format, to pre-size the store from the file size.
/// Binary formats are taken as compressed, as `sample-gen convert` writes them (an MF4 or
/// BLF file of 10M classic frames is 112 MB or 149 MB): an uncompressed file then reserves
/// up to about four times what it needs, rather than a compressed one growing the store at
/// the end. [`MAX_RESERVED_FRAMES`] bounds what that costs.
fn bytes_per_frame(format: Format) -> f64 {
    match format {
        Format::Candump => 40.0,
        Format::Asc => 80.0,
        Format::Trc => 85.0,
        Format::Csv => 65.0,
        Format::Blf => 15.0,
        Format::Mf4 => 11.0,
    }
}

/// The store is pre-sized for at most this many frames, about 520 MB on wasm32; a log with
/// more grows it as it is read.
const MAX_RESERVED_FRAMES: usize = 20_000_000;

/// Frames to pre-size the store for, from the file's size.
fn reserved_frames(format: Format, total_bytes: f64) -> usize {
    ((total_bytes / bytes_per_frame(format)) as usize).min(MAX_RESERVED_FRAMES)
}

/// Bytes of a log held back until there are enough to tell its format from its content.
const SNIFF_BYTES: usize = 4096;

/// What [`Session::row_bytes`] gives for a byte past the end of a frame.
pub const NO_BYTE: u16 = 0xFFFF;

#[wasm_bindgen]
#[derive(Default)]
pub struct Session {
    store: FrameStore,
    input: LogInput,
    databases: Vec<ScopedDatabase>,
    series: Vec<Option<Series>>,
    /// A second log, to compare the open log with.
    log_b: Option<compare::LogB>,
}

/// The log being read: its parser once the format is known, and the first bytes until then.
#[derive(Default)]
struct LogInput {
    file_name: String,
    /// The file's size, if given, to size the store by once the format is known.
    total_bytes: f64,
    head: Vec<u8>,
    parser: Option<AnyParser>,
}

impl LogInput {
    fn push(&mut self, chunk: &[u8], store: &mut FrameStore) {
        match &mut self.parser {
            Some(parser) => parser.push(chunk, store),
            None => {
                self.head.extend_from_slice(chunk);
                if self.head.len() >= SNIFF_BYTES {
                    self.choose_parser(store);
                }
            }
        }
    }

    fn choose_parser(&mut self, store: &mut FrameStore) {
        let format = self.format();
        // An MF4 file is buffered whole before its frames are read, so its store is sized
        // in `finish`, once the buffer has stopped growing.
        if format != Format::Mf4 {
            self.reserve(format, store);
        }
        let mut parser = AnyParser::new(format);
        parser.expect_bytes(self.total_bytes as u64);
        parser.push(&self.head, store);
        self.head = Vec::new();
        self.parser = Some(parser);
    }

    fn finish(&mut self, store: &mut FrameStore) {
        if self.parser.is_none() {
            self.choose_parser(store);
        }
        if self.format() == Format::Mf4 && self.total_bytes <= mf4::MAX_FILE as f64 {
            self.reserve(Format::Mf4, store);
        }
        if let Some(parser) = &mut self.parser {
            parser.finish(store);
        }
        store.sort_by_time();
    }

    fn reserve(&self, format: Format, store: &mut FrameStore) {
        let frames = reserved_frames(format, self.total_bytes);
        store.reserve(frames, frames * 8);
    }

    fn format(&self) -> Format {
        match &self.parser {
            Some(parser) => parser.format(),
            None => Format::detect(&self.file_name, &self.head),
        }
    }

    fn stats(&self) -> ParseStats {
        self.parser
            .as_ref()
            .map_or_else(ParseStats::default, |parser| parser.stats().clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopedDatabase {
    /// Bus name this database applies to, or `None` for every bus.
    channel: Option<String>,
    db: Database,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogInfo<'a> {
    format: &'static str,
    frames: usize,
    bytes: u64,
    lines: u64,
    rejected: u64,
    first_rejection: Option<(u64, &'a str)>,
    duration_s: f64,
    channels: &'a [String],
    heap_bytes: usize,
    error_frames: usize,
    reassembled_frames: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdSummary<'a> {
    key: IdKey,
    channel: u8,
    id: u32,
    extended: bool,
    count: usize,
    period_ms: Option<f64>,
    jitter_ms: Option<f64>,
    min_len: u16,
    max_len: u16,
    flags: u8,
    name: Option<&'a str>,
    /// Index in the `set_databases` array of the database that decodes this ID.
    dbc: Option<usize>,
    /// That database's message ID, which differs from `id` for a J1939 match.
    message_id: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeriesInfo<'a> {
    handle: usize,
    name: &'a str,
    unit: &'a str,
    count: usize,
    /// `None` when no frame had a value.
    min: Option<f64>,
    max: Option<f64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSignalSpec {
    start_bit: u16,
    size: u16,
    byte_order: ByteOrder,
    signed: bool,
    factor: f64,
    offset: f64,
}

#[derive(Deserialize)]
struct FindRule {
    behaviour: Behaviour,
    t0: f64,
    t1: f64,
}

#[derive(Serialize)]
struct Candidate {
    key: IdKey,
    spec: RawSignalSpec,
    score: f64,
}

fn js_err(msg: impl std::fmt::Display) -> JsError {
    JsError::new(&msg.to_string())
}

fn to_json(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("summary types always serialize")
}

/// Parse DBC file contents and return a JSON `Database`. No session state changes.
#[wasm_bindgen]
pub fn parse_dbc(bytes: &[u8]) -> Result<String, JsError> {
    let db = Database::from_dbc_bytes(bytes).map_err(js_err)?;
    Ok(to_json(&db))
}

/// A JSON `Database` as DBC text.
#[wasm_bindgen]
pub fn export_dbc(json_db: &str) -> Result<String, JsError> {
    let db: Database = serde_json::from_str(json_db).map_err(js_err)?;
    Ok(db.to_dbc())
}

/// The JSON `LogInfo` of a log read into `store` through `input`.
fn log_info_json(store: &FrameStore, input: &LogInput) -> String {
    let stats = input.stats();
    let duration_s = match (store.first_ts_ns(), store.last_ts_ns()) {
        (Some(a), Some(b)) => (b - a) as f64 / 1e9,
        _ => 0.0,
    };
    to_json(&LogInfo {
        format: input.format().name(),
        frames: store.len(),
        bytes: stats.bytes,
        lines: stats.lines,
        rejected: stats.rejected,
        first_rejection: stats.first_rejection,
        duration_s,
        channels: store.channels(),
        heap_bytes: store.heap_bytes(),
        error_frames: store.error_frames(),
        reassembled_frames: store.reassembled_frames(),
    })
}

/// Times cross the boundary as seconds from the first frame of the log, as in [`Session::rows`].
fn origin_in(store: &FrameStore) -> i64 {
    store.first_ts_ns().unwrap_or(0)
}

fn ns_in(store: &FrameStore, t: f64) -> i64 {
    // About 30 years either way, so differences of these times can't overflow an i64.
    const LIMIT_S: f64 = 1e9;
    origin_in(store).saturating_add((t.clamp(-LIMIT_S, LIMIT_S) * 1e9).round() as i64)
}

/// [`Session::byte_lanes`] of a log read into `store`.
fn byte_lanes_in(
    store: &FrameStore,
    key: f64,
    first: u32,
    count: u32,
    t0: f64,
    t1: f64,
    buckets: u32,
) -> Vec<f64> {
    let Some(stats) = (key >= 0.0).then(|| store.id_stats(key as IdKey)).flatten() else {
        return Vec::new();
    };
    if !t0.is_finite() || !t1.is_finite() {
        return Vec::new();
    }
    // The frames in the window plus one neighbour each side, so lines reach the plot edges.
    let inside = store.id_frames_between(stats, ns_in(store, t0), ns_in(store, t1));
    let frames =
        &stats.frames[inside.start.saturating_sub(1)..(inside.end + 1).min(stats.frames.len())];
    let origin = origin_in(store);
    let mut out = Vec::new();
    for byte in first..first.saturating_add(count) {
        let byte = byte as usize;
        let series = Series::decode(store, frames, origin, |data| {
            data.get(byte).map(|&b| f64::from(b))
        });
        let view = series.view(t0, t1, buckets as usize);
        out.push((view.len() / 2) as f64);
        out.extend_from_slice(&view);
    }
    out
}

/// Stores `series` and returns its JSON `SeriesInfo`.
fn add_series(slots: &mut Vec<Option<Series>>, series: Series, name: &str, unit: &str) -> String {
    let info = to_json(&SeriesInfo {
        handle: slots.len(),
        name,
        unit,
        count: series.len(),
        min: series.min(),
        max: series.max(),
    });
    slots.push(Some(series));
    info
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Name the log file before pushing its bytes. Its extension suggests the format; the
    /// first bytes confirm or correct that (see `Format::detect`).
    pub fn set_file_name(&mut self, name: &str) {
        self.input.file_name = name.to_owned();
    }

    /// Size the frame store for a log of `total_bytes`, avoiding repeated regrowth. Call it
    /// before pushing the first chunk: the store is sized once the format is known.
    pub fn reserve_for_bytes(&mut self, total_bytes: f64) {
        self.input.total_bytes = total_bytes;
    }

    pub fn push_chunk(&mut self, chunk: &[u8]) {
        self.input.push(chunk, &mut self.store);
    }

    /// Flush the parser and return a JSON `LogInfo`.
    pub fn finish(&mut self) -> String {
        self.input.finish(&mut self.store);
        self.log_info()
    }

    pub fn log_info(&self) -> String {
        log_info_json(&self.store, &self.input)
    }

    /// JSON array of `IdSummary`, one per channel/ID pair.
    pub fn id_summary(&self) -> String {
        let summaries: Vec<_> = self
            .store
            .ids()
            .iter()
            .map(|s| {
                let found = self.resolve(s.channel, s.id);
                IdSummary {
                    key: s.key(),
                    channel: s.channel,
                    id: s.id & !EXT_FLAG,
                    extended: s.id & EXT_FLAG != 0,
                    count: s.frames.len(),
                    period_ms: s.mean_period_ns().map(|ns| ns / 1e6),
                    jitter_ms: s.jitter_ns().map(|ns| ns / 1e6),
                    min_len: s.min_len,
                    max_len: s.max_len,
                    flags: s.flags,
                    name: found.map(|(_, m)| m.name.as_str()),
                    dbc: found.map(|(i, _)| i),
                    message_id: found.map(|(_, m)| m.id),
                }
            })
            .collect();
        to_json(&summaries)
    }

    /// Number of rows in the trace, either all frames or only those of `key` (pass -1 for all).
    pub fn row_count(&self, key: f64) -> u32 {
        match self.filter(key) {
            Ok(Some(stats)) => stats.frames.len() as u32,
            Ok(None) => self.store.len() as u32,
            Err(()) => 0,
        }
    }

    /// Rows `start..start + count` of the trace, packed [`ROW_STRIDE`] bytes each. A row holds
    /// at most [`MAX_PAYLOAD`] bytes of payload: a reassembled frame is cut there, and its full
    /// length is at offset 20 as a `u16`.
    pub fn rows(&self, key: f64, start: u32, count: u32) -> Vec<u8> {
        let Ok(filter) = self.filter(key) else {
            return Vec::new();
        };
        let origin = self.origin_ns();
        let total = self.row_count(key) as usize;
        let start = (start as usize).min(total);
        let end = start.saturating_add(count as usize).min(total);
        let mut out = Vec::with_capacity((end - start) * ROW_STRIDE);
        for row in start..end {
            let (index, prev) = match filter {
                Some(stats) => (
                    stats.frames[row] as usize,
                    row.checked_sub(1).map(|p| stats.frames[p] as usize),
                ),
                None => (row, self.store.previous_of_same_id(row)),
            };
            let frame = self.store.frame(index);
            let changed = prev.map_or(0u64, |p| {
                let before = self.store.frame(p).data;
                frame
                    .data
                    .iter()
                    .zip(before)
                    .take(MAX_PAYLOAD)
                    .enumerate()
                    .fold(
                        0u64,
                        |mask, (i, (a, b))| {
                            if a == b {
                                mask
                            } else {
                                mask | 1 << i
                            }
                        },
                    )
            });
            let mut rec = [0u8; ROW_STRIDE];
            rec[0..8].copy_from_slice(&(((frame.ts_ns - origin) as f64) / 1e9).to_le_bytes());
            rec[8..12].copy_from_slice(&frame.id.to_le_bytes());
            rec[12..16].copy_from_slice(&(index as u32).to_le_bytes());
            let shown = frame.data.len().min(MAX_PAYLOAD);
            rec[16] = frame.channel;
            rec[17] = frame.flags;
            rec[18] = shown as u8;
            rec[20..22].copy_from_slice(&(frame.data.len() as u16).to_le_bytes());
            rec[24..32].copy_from_slice(&changed.to_le_bytes());
            rec[32..32 + shown].copy_from_slice(&frame.data[..shown]);
            out.extend_from_slice(&rec);
        }
        out
    }

    /// The whole payload of row `row` of the trace of `key` (pass -1 for all), which [`Self::rows`]
    /// cuts at [`MAX_PAYLOAD`] bytes. Empty for an unknown key or a row past the end.
    pub fn frame_data(&self, key: f64, row: u32) -> Vec<u8> {
        let row = row as usize;
        let index = match self.filter(key) {
            Ok(Some(stats)) => stats.frames.get(row).map(|&f| f as usize),
            Ok(None) => (row < self.store.len()).then_some(row),
            Err(()) => None,
        };
        index.map_or_else(Vec::new, |i| self.store.frame(i).data.to_vec())
    }

    /// Payload bytes `first..first + byte_count` of rows `start..start + count` of the trace of
    /// `key` (pass -1 for all), which [`Self::rows`] would cut at [`MAX_PAYLOAD`]: `byte_count`
    /// values per row, row after row, with [`NO_BYTE`] for a byte past the end of the frame. Rows
    /// are clamped to those that exist, as in [`Self::rows`]. Empty when `byte_count` is above
    /// [`MAX_TRANSFER`], the longest payload, or `first + byte_count` overflows a `u32`.
    pub fn row_bytes(
        &self,
        key: f64,
        start: u32,
        count: u32,
        first: u32,
        byte_count: u32,
    ) -> Vec<u16> {
        let Ok(filter) = self.filter(key) else {
            return Vec::new();
        };
        let Some(end_byte) = first.checked_add(byte_count) else {
            return Vec::new();
        };
        if byte_count as usize > MAX_TRANSFER {
            return Vec::new();
        }
        let total = self.row_count(key) as usize;
        let start = (start as usize).min(total);
        let end = start.saturating_add(count as usize).min(total);
        let Some(len) = (end - start).checked_mul(byte_count as usize) else {
            return Vec::new();
        };
        let bytes = first as usize..end_byte as usize;
        let mut out = Vec::with_capacity(len);
        for row in start..end {
            let index = filter.map_or(row, |stats| stats.frames[row] as usize);
            let data = self.store.frame(index).data;
            out.extend(
                bytes
                    .clone()
                    .map(|b| data.get(b).map_or(NO_BYTE, |&v| u16::from(v))),
            );
        }
        out
    }

    /// Per-bit change counts for one ID, indexed `byte * 8 + bit` (bit 0 = LSB).
    pub fn bit_flips(&self, key: f64) -> Vec<u32> {
        match self.filter(key) {
            Ok(Some(stats)) => stats.bit_flips.clone(),
            _ => Vec::new(),
        }
    }

    /// Decode one signal of ID `key` across the whole log. Returns a JSON `SeriesInfo` whose
    /// `handle` is passed to [`Session::series_view`].
    pub fn decode_signal(&mut self, key: f64, signal: &str) -> Result<String, JsError> {
        let stats = self
            .filter(key)
            .ok()
            .flatten()
            .ok_or_else(|| js_err("unknown ID"))?;
        let message = self
            .message(stats.channel, stats.id)
            .ok_or_else(|| js_err("no loaded DBC defines this ID on this bus"))?;
        let sig = message
            .signal(signal)
            .ok_or_else(|| js_err("unknown signal"))?;
        let series = Series::decode(&self.store, &stats.frames, self.origin_ns(), |data| {
            message.decode(sig, data)
        });
        // Owned because `sig` borrows all of `self`, and `add_series` borrows `self.series` mutably.
        let (name, unit) = (sig.name.clone(), sig.unit.clone());
        Ok(add_series(&mut self.series, series, &name, &unit))
    }

    /// Decode a bit range of ID `key` given as a JSON `RawSignalSpec`, with no database entry.
    /// Returns a JSON `SeriesInfo` like [`Session::decode_signal`].
    pub fn decode_raw(&mut self, key: f64, spec: &str) -> Result<String, JsError> {
        let spec: RawSignalSpec = serde_json::from_str(spec).map_err(js_err)?;
        let stats = self
            .filter(key)
            .ok()
            .flatten()
            .ok_or_else(|| js_err("unknown ID"))?;
        let longest = vec![0u8; usize::from(stats.max_len)];
        if bits::extract(&longest, spec.start_bit, spec.size, spec.byte_order).is_none() {
            return Err(js_err(
                "the bit range must be 1 to 64 bits and fit in this ID's frames",
            ));
        }
        let series = Series::decode(&self.store, &stats.frames, self.origin_ns(), |data| {
            let raw = bits::extract(data, spec.start_bit, spec.size, spec.byte_order)?;
            let value = if spec.signed {
                bits::sign_extend(raw, spec.size) as f64
            } else {
                raw as f64
            };
            Some(value * spec.factor + spec.offset)
        });
        let order = match spec.byte_order {
            ByteOrder::Intel => 1,
            ByteOrder::Motorola => 0,
        };
        let sign = if spec.signed { '-' } else { '+' };
        let name = format!("bits {}|{}@{order}{sign}", spec.start_bit, spec.size);
        Ok(add_series(&mut self.series, series, &name, ""))
    }

    /// Replace the databases with a JSON array of `ScopedDatabase`. A frame's message comes from
    /// the first database whose `channel` is null or names the frame's bus and that defines the
    /// ID; failing that, from the first such database with a J1939 message for the frame's PGN.
    /// Decoded series are kept.
    pub fn set_databases(&mut self, json: &str) -> Result<(), JsError> {
        self.databases = serde_json::from_str(json).map_err(js_err)?;
        Ok(())
    }

    /// Index of the first row of `key` (-1 for all frames) at or after `t` seconds, clamped to
    /// the last row.
    pub fn row_at_time(&self, key: f64, t: f64) -> u32 {
        let ts = self.ns_at(t);
        let (row, rows) = match self.filter(key) {
            Ok(Some(stats)) => (
                self.store.first_of_id_at_or_after(stats, ts),
                stats.frames.len(),
            ),
            Ok(None) => (self.store.first_at_or_after(ts), self.store.len()),
            Err(()) => return 0,
        };
        row.min(rows.saturating_sub(1)) as u32
    }

    /// Number of rows of `key` (-1 for all frames) timestamped between `t0` and `t1` seconds,
    /// both ends included. For an ID key these are the frames [`Session::bit_flips_between`]
    /// compares.
    pub fn row_count_between(&self, key: f64, t0: f64, t1: f64) -> u32 {
        let (t0, t1) = (self.ns_at(t0), self.ns_at(t1));
        let rows = match self.filter(key) {
            Ok(Some(stats)) => self.store.id_frames_between(stats, t0, t1).len(),
            Ok(None) => self
                .store
                .first_at_or_after(t1.saturating_add(1))
                .saturating_sub(self.store.first_at_or_after(t0)),
            Err(()) => 0,
        };
        rows as u32
    }

    /// Estimated load (0..1) of `channel` at `bitrate` bit/s in `buckets` buckets between `t0`
    /// and `t1` seconds; see [`FrameStore::bus_load`]. Returns bucket centre times followed by
    /// loads, each half the array.
    pub fn bus_load(&self, channel: u8, t0: f64, t1: f64, buckets: u32, bitrate: f64) -> Vec<f64> {
        let buckets = buckets as usize;
        if buckets == 0 || t1 <= t0 {
            return Vec::new();
        }
        let width = (t1 - t0) / buckets as f64;
        let mut out: Vec<f64> = (0..buckets)
            .map(|i| t0 + (i as f64 + 0.5) * width)
            .collect();
        out.extend(
            self.store
                .bus_load(channel, self.ns_at(t0), self.ns_at(t1), buckets, bitrate),
        );
        out
    }

    /// Like [`Session::bit_flips`], counting only changes between consecutive frames that are
    /// both between `t0` and `t1` seconds.
    pub fn bit_flips_between(&self, key: f64, t0: f64, t1: f64) -> Vec<u32> {
        match self.filter(key) {
            Ok(Some(stats)) => self
                .store
                .bit_flips_between(stats, self.ns_at(t0), self.ns_at(t1)),
            _ => Vec::new(),
        }
    }

    /// Payload bits of ID `key` that changed from its previous frame, summed in `buckets`
    /// buckets between `t0` and `t1` seconds.
    pub fn change_activity(&self, key: f64, t0: f64, t1: f64, buckets: u32) -> Vec<u32> {
        match self.filter(key) {
            Ok(Some(stats)) => {
                self.store
                    .change_activity(stats, self.ns_at(t0), self.ns_at(t1), buckets as usize)
            }
            _ => vec![0; buckets as usize],
        }
    }

    /// Rank bit ranges of `keys` (every ID when empty) against a JSON array of `FindRule`;
    /// see [`find::find_signal`]. Returns a JSON array of `Candidate`, best first.
    pub fn find_signal(&self, rules: &str, keys: &[f64], limit: u32) -> Result<String, JsError> {
        let rules: Vec<FindRule> = serde_json::from_str(rules).map_err(js_err)?;
        let rules: Vec<find::Rule> = rules
            .iter()
            .map(|r| find::Rule {
                behaviour: r.behaviour,
                t0_ns: self.ns_at(r.t0),
                t1_ns: self.ns_at(r.t1),
            })
            .collect();
        let keys: Vec<IdKey> = keys.iter().map(|&k| k as IdKey).collect();
        let candidates: Vec<Candidate> =
            find::find_signal(&self.store, &rules, &keys, limit as usize)
                .into_iter()
                .map(|found| Candidate {
                    key: found.key,
                    spec: RawSignalSpec {
                        start_bit: found.range.start_bit,
                        size: found.range.size,
                        byte_order: found.range.byte_order,
                        signed: false,
                        factor: 1.0,
                        offset: 0.0,
                    },
                    score: found.score,
                })
                .collect();
        Ok(to_json(&candidates))
    }

    /// Points of a series between `t0` and `t1` seconds, min/max-decimated to about `2 * buckets`
    /// points. Returns x values followed by y values, each half the array.
    pub fn series_view(&self, handle: usize, t0: f64, t1: f64, buckets: u32) -> Vec<f64> {
        match self.series.get(handle) {
            Some(Some(s)) => s.view(t0, t1, buckets as usize),
            _ => Vec::new(),
        }
    }

    pub fn drop_series(&mut self, handle: usize) {
        if let Some(slot) = self.series.get_mut(handle) {
            *slot = None;
        }
    }

    /// Views of payload bytes `first..first + count` of ID `key` between `t0` and `t1` seconds,
    /// for a row of sparklines at once with no series to hold and drop. For each byte in turn:
    /// the number of points n, then n times, then n values, laid out as [`Session::series_view`]
    /// does. A frame too short to carry a byte adds no point to it.
    pub fn byte_lanes(
        &self,
        key: f64,
        first: u32,
        count: u32,
        t0: f64,
        t1: f64,
        buckets: u32,
    ) -> Vec<f64> {
        byte_lanes_in(&self.store, key, first, count, t0, t1, buckets)
    }

    fn origin_ns(&self) -> i64 {
        origin_in(&self.store)
    }

    fn ns_at(&self, t: f64) -> i64 {
        ns_in(&self.store, t)
    }

    /// The definition of `id` (DBC convention) on bus `channel`, by the rule in
    /// [`Session::set_databases`].
    fn message(&self, channel: u8, id: u32) -> Option<&MessageDef> {
        self.resolve(channel, id).map(|(_, m)| m)
    }

    /// Like [`Session::message`], with the index of the database it came from. Error frames
    /// have no message.
    fn resolve(&self, channel: u8, id: u32) -> Option<(usize, &MessageDef)> {
        if id & ERR_FLAG != 0 {
            return None;
        }
        self.resolve_on(self.store.channels().get(usize::from(channel)), id)
    }

    /// Like [`Session::resolve`], for a bus by name.
    fn resolve_on(&self, bus: Option<&String>, id: u32) -> Option<(usize, &MessageDef)> {
        let applicable = || {
            self.databases
                .iter()
                .enumerate()
                .filter(move |(_, d)| d.channel.is_none() || d.channel.as_ref() == bus)
        };
        applicable()
            .find_map(|(i, d)| d.db.message(id).map(|m| (i, m)))
            .or_else(|| applicable().find_map(|(i, d)| d.db.j1939_message(id).map(|m| (i, m))))
    }

    fn filter(&self, key: f64) -> Result<Option<&can_core::IdStats>, ()> {
        if key < 0.0 {
            return Ok(None);
        }
        self.store.id_stats(key as IdKey).map(Some).ok_or(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use can_core::id_key;
    use serde_json::{json, Value};

    const LOG: &str = "\
(100.000000) can0 123#0102FF7F
(100.010000) can0 123#03048000
(100.030000) can0 456#00
(100.040000) can1 7FF#00
(100.050000) can0 20000080#0000000000000000
(100.060000) can0 123#05060000
";

    #[test]
    fn the_store_is_sized_from_the_file_size_up_to_a_cap() {
        assert_eq!(reserved_frames(Format::Candump, 4000.0), 100);
        assert_eq!(
            reserved_frames(Format::Blf, 2.0 * (1u64 << 30) as f64),
            MAX_RESERVED_FRAMES
        );

        let mut head = b"MDF     4.10    ".to_vec();
        head.resize(SNIFF_BYTES, 0);
        let mf4_heap = |total_bytes: f64| {
            let mut s = Session::new();
            s.set_file_name("drive.mf4");
            s.reserve_for_bytes(total_bytes);
            s.push_chunk(&head);
            let before_finish = s.store.heap_bytes();
            s.finish();
            (before_finish, s.store.heap_bytes())
        };
        let (before_finish, after_finish) = mf4_heap(1100.0);
        assert_eq!(
            before_finish, 0,
            "an MF4 store is sized after the file is buffered"
        );
        assert!(after_finish > 0);
        assert_eq!(
            mf4_heap(2.0 * (1u64 << 30) as f64),
            (0, 0),
            "an MF4 file too large to read sizes no store"
        );
    }

    fn session() -> Session {
        let mut s = Session::new();
        s.push_chunk(LOG.as_bytes());
        s.finish();
        s
    }

    fn key_123() -> f64 {
        id_key(0, 0x123) as f64
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    /// Values of a raw decode of 0x123, and the series name.
    fn decode_raw(s: &mut Session, spec: &Value) -> (Vec<f64>, String) {
        let info = json(&s.decode_raw(key_123(), &spec.to_string()).unwrap());
        let handle = info["handle"].as_u64().unwrap() as usize;
        let xy = s.series_view(handle, 0.0, 1.0, 100);
        (
            xy[xy.len() / 2..].to_vec(),
            info["name"].as_str().unwrap().to_owned(),
        )
    }

    fn spec(start_bit: u16, size: u16, byte_order: &str, signed: bool) -> Value {
        json!({ "startBit": start_bit, "size": size, "byteOrder": byte_order, "signed": signed,
                "factor": 1, "offset": 0 })
    }

    #[test]
    fn byte_lanes_view_each_byte_of_the_window() {
        let s = session();
        // Bytes 0..3 of the three 123 frames, then byte 60, which no frame carries.
        let out = s.byte_lanes(key_123(), 0, 3, 0.0, 1.0, 100);
        let mut at = 0;
        let mut lanes = Vec::new();
        while at < out.len() {
            let n = out[at] as usize;
            lanes.push((
                out[at + 1..at + 1 + n].to_vec(),
                out[at + 1 + n..at + 1 + 2 * n].to_vec(),
            ));
            at += 1 + 2 * n;
        }
        assert_eq!(lanes.len(), 3);
        assert_eq!(lanes[0].0, vec![0.0, 0.01, 0.06]);
        assert_eq!(lanes[0].1, vec![1.0, 3.0, 5.0]);
        assert_eq!(lanes[1].1, vec![2.0, 4.0, 6.0]);
        assert_eq!(lanes[2].1, vec![255.0, 128.0, 0.0]);
        assert_eq!(s.byte_lanes(key_123(), 60, 1, 0.0, 1.0, 100), vec![0.0]);
        // A window after every frame still gets the last frame as its leading neighbour.
        let late = s.byte_lanes(key_123(), 0, 1, 0.5, 1.0, 100);
        assert_eq!(late, vec![1.0, 0.06, 5.0]);
        assert!(s.byte_lanes(-1.0, 0, 1, 0.0, 1.0, 100).is_empty());
    }

    #[test]
    fn decodes_raw_bit_ranges() {
        let mut s = session();
        assert_eq!(
            decode_raw(&mut s, &spec(0, 16, "intel", false)),
            (vec![513.0, 1027.0, 1541.0], "bits 0|16@1+".into())
        );
        assert_eq!(
            decode_raw(&mut s, &spec(7, 16, "motorola", false)).0,
            vec![258.0, 772.0, 1286.0]
        );
        assert_eq!(
            decode_raw(&mut s, &spec(16, 8, "intel", true)).0,
            vec![-1.0, -128.0, 0.0]
        );
        let mut scaled = spec(23, 16, "motorola", true);
        scaled["factor"] = json!(0.5);
        scaled["offset"] = json!(1);
        assert_eq!(
            decode_raw(&mut s, &scaled),
            (vec![-63.5, -16383.0, 1.0], "bits 23|16@0-".into())
        );
    }

    #[test]
    fn finds_rows_by_time() {
        let s = session();
        assert_eq!(s.row_at_time(-1.0, -5.0), 0);
        assert_eq!(s.row_at_time(-1.0, 0.02), 2);
        assert_eq!(s.row_at_time(-1.0, 0.03), 2);
        assert_eq!(s.row_at_time(-1.0, 99.0), 5);
        assert_eq!(s.row_at_time(key_123(), 0.005), 1);
        assert_eq!(s.row_at_time(key_123(), 0.06), 2);
        assert_eq!(s.row_at_time(key_123(), 99.0), 2);
        assert_eq!(s.row_at_time(id_key(3, 0x123) as f64, 0.0), 0);
        assert_eq!(Session::new().row_at_time(-1.0, 0.0), 0);
    }

    #[test]
    fn a_log_out_of_time_order_reads_as_if_it_were_in_order() {
        let backwards: String = LOG.lines().rev().map(|line| format!("{line}\n")).collect();
        let mut s = Session::new();
        s.push_chunk(backwards.as_bytes());
        let mut info = json(&s.finish());
        let sorted = session();
        let mut sorted_info = json(&sorted.log_info());
        // The rebuilt columns hold no spare capacity.
        info["heapBytes"] = Value::Null;
        sorted_info["heapBytes"] = Value::Null;
        assert_eq!(info, sorted_info);
        assert!((info["durationS"].as_f64().unwrap() - 0.06).abs() < 1e-9);
        assert_eq!(s.rows(-1.0, 0, 6), sorted.rows(-1.0, 0, 6));
        assert_eq!(s.id_summary(), sorted.id_summary());
        assert_eq!(s.row_at_time(-1.0, 0.02), 2);
        assert_eq!(s.row_count_between(key_123(), 0.0, 0.06), 3);
    }

    #[test]
    fn counts_rows_in_a_window_as_bit_flips_between_sees_them() {
        let s = session();
        // 123 is at 0, 0.01 and 0.06 s. A window ending on or after the last frame takes it in,
        // where the row_at_time difference of the window's ends would leave it out.
        assert_eq!(s.row_count_between(key_123(), 0.0, 0.06), 3);
        assert_eq!(s.row_count_between(key_123(), 0.0, 99.0), 3);
        assert_eq!(
            s.row_at_time(key_123(), 0.06) - s.row_at_time(key_123(), 0.0),
            2
        );
        assert_eq!(s.row_count_between(key_123(), 0.005, 0.01), 1);
        assert_eq!(s.row_count_between(key_123(), 0.02, 0.05), 0);
        assert_eq!(s.row_count_between(key_123(), 0.5, 1.0), 0);
        assert_eq!(s.row_count_between(-1.0, 0.0, 0.03), 3);
        assert_eq!(s.row_count_between(-1.0, -5.0, 99.0), 6);
        assert_eq!(s.row_count_between(id_key(3, 0x123) as f64, 0.0, 1.0), 0);

        // No bit can change more often than there are steps between the rows of the window.
        for (t0, t1) in [(0.0, 0.06), (0.0, 0.01), (0.01, 99.0), (0.02, 0.05)] {
            let steps = s.row_count_between(key_123(), t0, t1).saturating_sub(1);
            let flips = s.bit_flips_between(key_123(), t0, t1);
            assert!(flips.iter().all(|&n| n <= steps), "{t0}..{t1}");
            assert_eq!(
                flips.iter().max().copied().unwrap_or(0),
                steps,
                "{t0}..{t1}"
            );
        }
    }

    #[test]
    fn reports_error_frames_and_jitter() {
        let s = session();
        assert_eq!(json(&s.log_info())["errorFrames"], 1);
        let ids = json(&s.id_summary());
        let summary = |id: u32| {
            ids.as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == id)
                .unwrap()
                .clone()
        };
        let jitter = summary(0x123)["jitterMs"].as_f64().unwrap();
        assert!((jitter - 20.0).abs() < 1e-9, "{jitter}");
        assert_eq!(summary(0x456)["jitterMs"], Value::Null);
    }

    /// A JSON `Database` with an 8-bit Intel signal `Value` at `start_bit` in each message.
    fn database(messages: &[(u32, &str, u16)]) -> Value {
        let messages: Vec<Value> = messages
            .iter()
            .map(|&(id, name, start_bit)| {
                json!({ "id": id, "name": name, "size": 8, "transmitter": null, "comment": null,
                    "signals": [{ "name": "Value", "startBit": start_bit, "size": 8,
                    "byteOrder": "intel", "kind": "unsigned", "factor": 1, "offset": 0,
                    "min": 0, "max": 255, "unit": "", "isMultiplexor": false, "muxValue": null,
                    "valueTable": [], "comment": null }] })
            })
            .collect();
        json!({ "name": "test", "messages": messages })
    }

    fn set_databases(s: &mut Session, dbs: &[(Option<&str>, Value)]) {
        let dbs: Vec<Value> = dbs
            .iter()
            .map(|(channel, db)| json!({ "channel": channel, "db": db }))
            .collect();
        s.set_databases(&Value::from(dbs).to_string()).unwrap();
    }

    /// The `IdSummary` name of `id` on bus `channel`.
    fn summary_name(s: &Session, channel: u8, id: u32) -> Value {
        json(&s.id_summary())
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["channel"] == channel && v["id"] == id)
            .unwrap()["name"]
            .clone()
    }

    fn series_values(s: &Session, info: &str) -> Vec<f64> {
        let handle = json(info)["handle"].as_u64().unwrap() as usize;
        let xy = s.series_view(handle, 0.0, 1.0, 100);
        xy[xy.len() / 2..].to_vec()
    }

    #[test]
    fn earlier_database_wins_for_a_shared_id() {
        let mut s = session();
        set_databases(
            &mut s,
            &[
                (None, database(&[(0x123, "FIRST", 0)])),
                (None, database(&[(0x123, "SECOND", 8), (0x456, "LATER", 0)])),
            ],
        );
        assert_eq!(summary_name(&s, 0, 0x123), "FIRST");
        assert_eq!(summary_name(&s, 0, 0x456), "LATER");
        let info = s.decode_signal(key_123(), "Value").unwrap();
        assert_eq!(series_values(&s, &info), [1.0, 3.0, 5.0]);
    }

    #[test]
    fn scoped_database_applies_only_to_its_bus() {
        let mut s = session();
        set_databases(
            &mut s,
            &[
                (Some("vcan9"), database(&[(0x123, "NO_SUCH_BUS", 0)])),
                (
                    Some("can1"),
                    database(&[
                        (0x123, "CAN1_123", 0),
                        (0x456, "CAN1_456", 0),
                        (0x7FF, "CAN1_7FF", 0),
                    ]),
                ),
                (None, database(&[(0x123, "ANY_BUS", 8)])),
            ],
        );
        assert_eq!(summary_name(&s, 0, 0x123), "ANY_BUS");
        assert_eq!(summary_name(&s, 0, 0x456), Value::Null);
        assert_eq!(summary_name(&s, 1, 0x7FF), "CAN1_7FF");
        assert_eq!(s.message(1, 0x123).unwrap().name, "CAN1_123");
        assert!(s.message(0, 0x7FF).is_none());
        let info = s.decode_signal(key_123(), "Value").unwrap();
        assert_eq!(series_values(&s, &info), [2.0, 4.0, 6.0]);
    }

    #[test]
    fn j1939_messages_match_by_pgn_after_exact_ids() {
        let mut s = Session::new();
        s.push_chunk(
            b"(1.000000) can0 0CF00400#11\n\
              (1.010000) can0 18FF1D03#22\n\
              (1.020000) can0 18FF1D17#33\n\
              (1.030000) can0 18FEF100#44\n",
        );
        s.finish();
        let mut generic = database(&[
            (0x8CF0_04FE, "EEC1", 0),
            (0x98FF_1D17, "CLUSTER", 0),
            (0x98FE_F1FE, "CCVS", 0),
        ]);
        for m in generic["messages"].as_array_mut().unwrap() {
            m["j1939"] = json!(true);
        }
        let exact = database(&[(0x98FE_F100, "CCVS_EXACT", 0)]);
        set_databases(&mut s, &[(None, generic), (None, exact)]);

        let ids = json(&s.id_summary());
        let found = |id: u32| {
            let v = ids
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == id)
                .unwrap();
            (v["name"].clone(), v["dbc"].clone(), v["messageId"].clone())
        };
        assert_eq!(
            found(0x0CF0_0400),
            (json!("EEC1"), json!(0), json!(0x8CF0_04FEu32))
        );
        assert_eq!(
            found(0x18FF_1D17),
            (json!("CLUSTER"), json!(0), json!(0x98FF_1D17u32))
        );
        assert_eq!(
            found(0x18FF_1D03).0,
            Value::Null,
            "proprietary, another sender"
        );
        assert_eq!(
            found(0x18FE_F100),
            (json!("CCVS_EXACT"), json!(1), json!(0x98FE_F100u32))
        );

        let info = s
            .decode_signal(id_key(0, 0x8CF0_0400) as f64, "Value")
            .unwrap();
        assert_eq!(series_values(&s, &info), [17.0]);
    }

    #[test]
    fn error_frames_are_not_decoded_as_the_standard_id_they_spell() {
        let mut s = Session::new();
        s.push_chunk(
            b"(1.0) can0 080#0102\n\
              (1.1) can0 20000080#0000000000000000\n\
              (1.2) can0 080#0304\n",
        );
        s.finish();
        set_databases(&mut s, &[(None, database(&[(0x080, "STD_80", 0)]))]);

        let ids = json(&s.id_summary());
        let ids = ids.as_array().unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(
            (&ids[0]["id"], &ids[0]["count"], &ids[0]["name"]),
            (&json!(0x080), &json!(2), &json!("STD_80"))
        );
        assert_eq!(
            (&ids[1]["id"], &ids[1]["extended"], &ids[1]["name"]),
            (&json!(0x2000_0080u32), &json!(false), &Value::Null)
        );

        let info = s.decode_signal(id_key(0, 0x080) as f64, "Value").unwrap();
        assert_eq!(series_values(&s, &info), [1.0, 3.0]);
        assert!(s.message(0, 0x80 | ERR_FLAG).is_none());
    }

    #[test]
    fn series_with_no_values_has_null_min_and_max() {
        let mut s = Session::new();
        s.push_chunk(b"(1.0) can0 18FEF100#FF\n(1.1) can0 18FEF100#FE\n");
        s.finish();
        let mut ccvs = database(&[(0x98FE_F100, "CCVS", 0)]);
        ccvs["messages"][0]["j1939"] = json!(true);
        set_databases(&mut s, &[(None, ccvs)]);
        let key = id_key(0, 0x98FE_F100) as f64;

        let info = json(&s.decode_signal(key, "Value").unwrap());
        assert_eq!(info["count"], 0);
        assert_eq!(info.get("min"), Some(&Value::Null));
        assert_eq!(info.get("max"), Some(&Value::Null));

        let raw = json(
            &s.decode_raw(key, &spec(0, 8, "intel", false).to_string())
                .unwrap(),
        );
        assert_eq!((&raw["min"], &raw["max"]), (&json!(254.0), &json!(255.0)));
    }

    #[test]
    fn set_databases_keeps_series_handles() {
        let mut s = session();
        let raw = s
            .decode_raw(key_123(), &spec(0, 8, "intel", false).to_string())
            .unwrap();
        set_databases(&mut s, &[(None, database(&[(0x123, "MYSTERY", 8)]))]);
        assert_eq!(series_values(&s, &raw), [1.0, 3.0, 5.0]);
        let decoded = s.decode_signal(key_123(), "Value").unwrap();
        assert_ne!(json(&raw)["handle"], json(&decoded)["handle"]);

        set_databases(&mut s, &[]);
        assert_eq!(summary_name(&s, 0, 0x123), Value::Null);
        assert_eq!(series_values(&s, &raw), [1.0, 3.0, 5.0]);
        assert_eq!(series_values(&s, &decoded), [2.0, 4.0, 6.0]);
    }

    #[test]
    fn export_dbc_round_trips_through_parse_dbc() {
        let mut db = database(&[(0x123, "MYSTERY", 0)]);
        db["messages"][0]["comment"] = json!("found it");
        db["messages"][0]["signals"][0]["name"] = json!("Counter");
        let dbc = export_dbc(&db.to_string()).unwrap();
        assert!(
            dbc.contains("BO_ 291 MYSTERY: 8 Vector__XXX\n SG_ Counter : 0|8@1+"),
            "{dbc}"
        );
        assert!(dbc.contains("CM_ BO_ 291 \"found it\";"));

        let parsed: Database = serde_json::from_str(&parse_dbc(dbc.as_bytes()).unwrap()).unwrap();
        assert_eq!(parsed, serde_json::from_value::<Database>(db).unwrap());
        assert!(export_dbc(r#"{ "name": "empty", "messages": [] }"#)
            .unwrap()
            .contains("BU_:\n"));
    }

    /// A DM1 (PGN 0xFECA) of 14 bytes sent by BAM from SA 0x00, then one from SA 0x17 whose
    /// packets interleave with a second one from 0x00 that is abandoned.
    const TP_LOG: &str = "\
(1.000000) can0 18ECFF00#200E0002FFCAFE00
(1.050000) can0 18EBFF00#0101020304050607
(1.100000) can0 18EBFF00#02080A0C0E101214
(1.200000) can0 18ECFF17#200E0002FFCAFE00
(1.210000) can0 18ECFF00#200E0002FFCAFE00
(1.250000) can0 18EBFF17#01AABBCCDDEEFF11
(1.260000) can0 18EBFF00#0199999999999999
(1.300000) can0 18EBFF17#0222334455667788
(1.400000) can0 18ECFF00#200E0002FFCAFE00
";

    #[test]
    fn reassembles_j1939_transport_protocol_from_candump_text() {
        let mut s = Session::new();
        s.push_chunk(TP_LOG.as_bytes());
        let info = json(&s.finish());
        assert_eq!(info["frames"], 11);
        assert_eq!(info["reassembledFrames"], 2);

        let ids = json(&s.id_summary());
        let ids = ids.as_array().unwrap();
        let dm1: Vec<&Value> = ids
            .iter()
            .filter(|v| v["flags"].as_u64().unwrap() & u64::from(can_core::flags::REASSEMBLED) != 0)
            .collect();
        assert_eq!(dm1.len(), 2);
        assert_eq!(
            (
                &dm1[0]["id"],
                &dm1[0]["extended"],
                &dm1[0]["count"],
                &dm1[0]["maxLen"]
            ),
            (&json!(0x18FE_CA00), &json!(true), &json!(1), &json!(14))
        );
        assert_eq!(dm1[1]["id"], 0x18FE_CA17);
        assert_eq!(
            ids.iter().filter(|v| v["id"] == 0x18EB_FF00).count(),
            1,
            "the packets stay in the log"
        );

        // The reassembled frame decodes with the DBC's message for its PGN.
        let mut dbc = database(&[(0x98FE_CAFE, "DM1", 8 * 8)]);
        dbc["messages"][0]["j1939"] = json!(true);
        set_databases(&mut s, &[(None, dbc)]);
        assert_eq!(summary_name(&s, 0, 0x18FE_CA00), "DM1");
        let key = id_key(0, 0x18FE_CA00 | EXT_FLAG) as f64;
        let info = s.decode_signal(key, "Value").unwrap();
        assert_eq!(
            series_values(&s, &info),
            [10.0],
            "byte 8 of the first transfer"
        );
        let key_17 = id_key(0, 0x18FE_CA17 | EXT_FLAG) as f64;
        let info = s.decode_signal(key_17, "Value").unwrap();
        assert_eq!(series_values(&s, &info), [f64::from(0x33)]);

        let rows = s.rows(key, 0, 1);
        assert_eq!(rows.len(), ROW_STRIDE);
        assert_eq!(f64::from_le_bytes(rows[0..8].try_into().unwrap()), 0.1);
        assert_eq!(rows[17], can_core::flags::REASSEMBLED);
        assert_eq!(rows[18], 14);
        assert_eq!(
            rows[32..46],
            [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20]
        );
    }

    #[test]
    fn rows_cut_reassembled_payloads_at_64_bytes_and_frame_data_gives_all_of_them() {
        // Two 100-byte transfers of bytes 0..99; the second changes bytes 0 and 70.
        let mut log = String::new();
        for (second, change) in [(1, 0), (2, 1)] {
            log += &format!("({second}.000) can0 18ECFF00#2064000FFFCAFE00\n");
            for packet in 1..=15u8 {
                log += &format!("({second}.{packet:03}) can0 18EBFF00#{packet:02X}");
                for byte in 0..7u8 {
                    let index = (packet - 1) * 7 + byte;
                    let changed = index == 0 || index == 70;
                    log += &format!("{:02X}", index + if changed { change } else { 0 });
                }
                log += "\n";
            }
        }
        let mut s = Session::new();
        s.push_chunk(log.as_bytes());
        s.finish();
        let key = id_key(0, 0x18FE_CA00 | EXT_FLAG) as f64;
        assert_eq!(s.row_count(key), 2);
        let rows = s.rows(key, 0, 1);
        assert_eq!(rows[18], 64);
        assert_eq!(u16::from_le_bytes([rows[20], rows[21]]), 100);
        assert_eq!(rows[32..96], (0..64).collect::<Vec<u8>>()[..]);
        // Only byte 0 counts as changed in the second row: byte 70 is past the row's payload.
        let rows = s.rows(key, 1, 1);
        assert_eq!(u64::from_le_bytes(rows[24..32].try_into().unwrap()), 1);

        // frame_data gives the whole payload, by row of the ID or of the whole trace.
        let mut second: Vec<u8> = (0..100).collect();
        second[0] = 1;
        second[70] = 71;
        assert_eq!(s.frame_data(key, 1), second);
        assert_eq!(s.frame_data(-1.0, 16), (0..100).collect::<Vec<u8>>());
        assert_eq!(s.frame_data(-1.0, 15).len(), 8, "a packet");
        assert!(s.frame_data(key, 2).is_empty());
        assert!(s.frame_data(-1.0, 34).is_empty());
        assert!(s.frame_data(12345.0, 0).is_empty());

        // row_bytes gives a byte range of many rows past the 64 in a row, marking missing bytes.
        assert_eq!(s.row_bytes(key, 0, 5, 69, 3), [69, 70, 71, 69, 71, 71]);
        assert_eq!(s.row_bytes(key, 1, 1, 98, 3), [98, 99, NO_BYTE]);
        assert_eq!(
            s.row_bytes(-1.0, 15, 2, 6, 3),
            [103, 104, NO_BYTE, 6, 7, 8],
            "a packet, then the transfer"
        );
        assert!(s.row_bytes(key, 2, 1, 0, 8).is_empty());
        assert!(s.row_bytes(12345.0, 0, 1, 0, 8).is_empty());
        assert!(s.row_bytes(key, 0, 0, 0, 8).is_empty());
        assert!(s.row_bytes(key, 0, 2, 0, 0).is_empty());
        assert_eq!(
            s.row_bytes(key, 0, u32::MAX, 99, 2),
            [99, NO_BYTE, 99, NO_BYTE]
        );
        assert_eq!(s.row_bytes(key, 0, 2, 0, 1785).len(), 2 * 1785);
        assert_eq!(s.row_bytes(key, 0, 1, u32::MAX - 1, 1), [NO_BYTE]);
        assert!(
            s.row_bytes(key, 0, 1, 0, 1786).is_empty(),
            "past the longest payload"
        );
        assert!(s.row_bytes(-1.0, 0, 5, 0, 0x4000_0000).is_empty());
        assert!(s.row_bytes(-1.0, 0, 1, 0, u32::MAX).is_empty());
        assert!(
            s.row_bytes(-1.0, 0, 5, 0xFFFF_FFF0, 0x20).is_empty(),
            "first + byte_count overflows"
        );

        // Raw decodes reach the whole payload.
        let info = s
            .decode_raw(key, &spec(792, 8, "intel", false).to_string())
            .unwrap();
        assert_eq!(series_values(&s, &info), [99.0, 99.0]);
        let info = s
            .decode_raw(key, &spec(560, 8, "intel", false).to_string())
            .unwrap();
        assert_eq!(series_values(&s, &info), [70.0, 71.0]);

        // Find Signal searches the first 64 bytes, so it sees byte 0 change but not byte 70.
        let rules = json!([{ "behaviour": "changes", "t0": 0.0, "t1": 2.0 }]).to_string();
        let found = json(&s.find_signal(&rules, &[key], 100).unwrap());
        let found = found.as_array().unwrap();
        assert!(!found.is_empty());
        assert!(found
            .iter()
            .all(|c| c["spec"]["startBit"].as_u64().unwrap() < 512));
        assert_eq!(found[0]["spec"]["startBit"], 0);
    }

    #[test]
    fn rows_clamp_any_start_and_count() {
        let s = session();
        assert_eq!(s.rows(-1.0, 3, u32::MAX).len(), 3 * ROW_STRIDE);
        assert!(s.rows(-1.0, u32::MAX, u32::MAX).is_empty());
        assert!(s.rows(-1.0, 0, 0).is_empty());
    }

    #[test]
    fn bus_load_reports_bucket_centres() {
        let s = session();
        let out = s.bus_load(0, 0.0, 0.08, 2, 10_000.0);
        let (t, load) = out.split_at(2);
        assert_eq!(t, [0.02, 0.06]);
        // 0x123 twice (79 bits each) and 0x456 (55) in the first 40 ms, 0x123 (79) after.
        let capacity = 10_000.0 * 0.04;
        assert!(
            (load[0] - (79.0 * 2.0 + 55.0) / capacity).abs() < 1e-12,
            "{load:?}"
        );
        assert!((load[1] - 79.0 / capacity).abs() < 1e-12, "{load:?}");
        assert!(s.bus_load(0, 1.0, 0.0, 2, 10_000.0).is_empty());
    }

    #[test]
    fn picks_the_parser_from_the_content_and_reports_the_format() {
        let mut s = Session::new();
        s.set_file_name("drive.bin");
        s.push_chunk(LOG.as_bytes());
        let info = json(&s.finish());
        assert_eq!(info["format"], "candump");
        assert_eq!(info["frames"], 6);

        // Past the sniff window the log is parsed as it streams, not held until the end.
        let line = "(100.000000) can0 123#0102\n";
        let count = SNIFF_BYTES / line.len() + 10;
        let long = line.repeat(count);
        let mut s = Session::new();
        s.set_file_name("drive.log");
        s.push_chunk(&long.as_bytes()[..SNIFF_BYTES + 5]);
        assert!(s.input.parser.is_some());
        assert!(s.store.len() > 100);
        s.push_chunk(&long.as_bytes()[SNIFF_BYTES + 5..]);
        let info = json(&s.finish());
        assert_eq!(
            (&info["frames"], &info["rejected"]),
            (&json!(count), &json!(0))
        );

        let empty = json(&Session::new().finish());
        assert_eq!(
            (&empty["format"], &empty["frames"]),
            (&json!("candump"), &json!(0))
        );
    }
}
