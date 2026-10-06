//! The [`Session`] binding for Suggested signals ([`discover`]).

use can_core::{IdKey, IdStats};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::discover::{self, Findings, Hints, Job, Kind, Marker, Reference, STEP_WORK};
use crate::{js_err, to_json, MuxSpec, RawSignalSpec, Session};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct HintsJson {
    markers: Vec<MarkerJson>,
    reference: Option<ReferenceJson>,
}

#[derive(Deserialize)]
struct MarkerJson {
    t: f64,
}

#[derive(Deserialize)]
struct ReferenceJson {
    key: f64,
    signal: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageSuggestions {
    key: IdKey,
    frames: usize,
    sampled_frames: usize,
    suggestions: Vec<SuggestionJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Level {
    High,
    Medium,
    Low,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionJson {
    kind: Kind,
    spec: RawSignalSpec,
    confidence: f64,
    level: Level,
    reason: String,
    unconfirmed: bool,
    sparkline: Sparkline,
    fit: Option<FitJson>,
}

#[derive(Serialize)]
struct Sparkline {
    t: Vec<f64>,
    v: Vec<f64>,
}

#[derive(Serialize)]
struct FitJson {
    reference: String,
    unit: String,
    r: f64,
    factor: f64,
    offset: f64,
}

fn level(score: f64) -> Level {
    if score >= 0.85 {
        Level::High
    } else if score >= 0.6 {
        Level::Medium
    } else {
        Level::Low
    }
}

/// Suggestions being made a step at a time, by job id; see [`Session::suggest_begin`].
#[derive(Default)]
pub(crate) struct PendingSuggestions {
    next_id: u32,
    jobs: Vec<Pending>,
    /// Ids below this were begun before the store last changed.
    stale_below: u32,
}

impl PendingSuggestions {
    /// Lets every job go: they read frames by their place in the store, which any change to it
    /// (frames added, sorted or trimmed, or another log) can move. Their next step says so.
    pub(crate) fn store_changed(&mut self) {
        self.jobs.clear();
        self.stale_below = self.next_id;
    }
}

struct Pending {
    id: u32,
    key: f64,
    job: Job,
    /// For the result: the reference's name and unit.
    reference: Option<String>,
    unit: String,
}

#[wasm_bindgen]
impl Session {
    /// Suggested signals for ID `key`, given hints as a JSON `DiscoveryHints`; see
    /// [`discover::suggest`]. Returns a JSON `MessageSuggestions`.
    pub fn suggest_signals(&self, key: f64, hints: &str) -> Result<String, JsError> {
        self.suggestions(key, hints).map_err(js_err)
    }

    /// Starts [`Session::suggest_signals`] as a job to run with `suggest_step`, so other calls
    /// can run between its steps. Returns the job's id. A job keeps its sampled frames until it
    /// is stepped to the end, dropped, or the log changes, so callers see each one through.
    pub fn suggest_begin(&mut self, key: f64, hints: &str) -> Result<u32, JsError> {
        self.begin_suggestions(key, hints).map_err(js_err)
    }

    /// Does the next part of job `job`: `undefined` while there is more to do, else the JSON
    /// `MessageSuggestions`, and the job is over. Fails for an unknown job, or one whose log
    /// changed under it, which is then over too.
    pub fn suggest_step(&mut self, job: u32) -> Result<Option<String>, JsError> {
        self.step_suggestions(job).map_err(js_err)
    }

    /// Gives up job `job`, if it is still going.
    pub fn suggest_drop(&mut self, job: u32) {
        self.discovery.jobs.retain(|p| p.id != job);
    }
}

impl Session {
    fn suggestions(&self, key: f64, hints: &str) -> Result<String, String> {
        let (stats, hints, unit) = self.suggestion_inputs(key, hints)?;
        let reference = hints.reference.as_ref().map(|r| r.name.clone());
        let findings = discover::suggest(&self.store, stats, &hints);
        Ok(self.suggestions_json(stats, findings, reference, &unit))
    }

    fn begin_suggestions(&mut self, key: f64, hints: &str) -> Result<u32, String> {
        let (stats, hints, unit) = self.suggestion_inputs(key, hints)?;
        let reference = hints.reference.as_ref().map(|r| r.name.clone());
        let job = Job::new(&self.store, stats, hints);
        let pending = &mut self.discovery;
        let id = pending.next_id;
        pending.next_id = pending.next_id.wrapping_add(1);
        pending.jobs.push(Pending {
            id,
            key,
            job,
            reference,
            unit,
        });
        Ok(id)
    }

    fn step_suggestions(&mut self, id: u32) -> Result<Option<String>, String> {
        let Some(at) = self.discovery.jobs.iter().position(|p| p.id == id) else {
            return Err(if id < self.discovery.stale_below {
                "the log changed"
            } else {
                "unknown suggestion job"
            }
            .into());
        };
        let mut pending = self.discovery.jobs.remove(at);
        let stats = self
            .filter(pending.key)
            .ok()
            .flatten()
            .ok_or("the log changed")?;
        if !pending.job.scored_all() {
            pending.job.step(&self.store, stats, STEP_WORK);
            self.discovery.jobs.insert(at, pending);
            return Ok(None);
        }
        let findings = pending.job.finish(&self.store, stats);
        Ok(Some(self.suggestions_json(
            stats,
            findings,
            pending.reference,
            &pending.unit,
        )))
    }

    /// The ID's stats, the hints as [`discover`] takes them, and the reference's unit.
    fn suggestion_inputs(
        &self,
        key: f64,
        hints: &str,
    ) -> Result<(&IdStats, Hints, String), String> {
        let parsed: HintsJson = if hints.trim().is_empty() {
            HintsJson::default()
        } else {
            serde_json::from_str(hints).map_err(|e| e.to_string())?
        };
        let stats = self.filter(key).ok().flatten().ok_or("unknown ID")?;
        let mut unit = String::new();
        let reference = match &parsed.reference {
            None => None,
            Some(r) => {
                let ref_stats = self
                    .filter(r.key)
                    .ok()
                    .flatten()
                    .ok_or("unknown reference ID")?;
                let message = self
                    .message(ref_stats.channel, ref_stats.id)
                    .ok_or("no loaded DBC defines the reference's message")?;
                let signal = message
                    .signal(&r.signal)
                    .ok_or("unknown reference signal")?;
                unit.clone_from(&signal.unit);
                let (mut t_ns, mut values) = (Vec::new(), Vec::new());
                for &f in &ref_stats.frames {
                    let frame = self.store.frame(f as usize);
                    if let Some(v) = message.decode(signal, frame.data) {
                        t_ns.push(frame.ts_ns);
                        values.push(v);
                    }
                }
                Some(Reference {
                    name: signal.name.clone(),
                    t_ns,
                    values,
                })
            }
        };
        let hints = Hints {
            markers: parsed
                .markers
                .iter()
                .map(|m| Marker {
                    t_ns: self.ns_at(m.t),
                    label: format!("{} s", trim_seconds(m.t)),
                })
                .collect(),
            reference,
        };
        Ok((stats, hints, unit))
    }

    fn suggestions_json(
        &self,
        stats: &IdStats,
        findings: Findings,
        reference: Option<String>,
        unit: &str,
    ) -> String {
        let origin = self.origin_ns();
        let seconds = |ns: i64| (ns - origin) as f64 / 1e9;
        let suggestions = findings
            .suggestions
            .into_iter()
            .map(|s| {
                let (factor, offset) = s.fit.map_or((1.0, 0.0), |f| (f.factor, f.offset));
                SuggestionJson {
                    kind: s.kind,
                    spec: RawSignalSpec {
                        start_bit: s.range.start_bit,
                        size: s.range.size,
                        byte_order: s.range.byte_order,
                        signed: s.signed,
                        float: s.kind == Kind::Float,
                        factor,
                        offset,
                        mux: s.page.map(|(selector, value)| MuxSpec {
                            start_bit: selector.start_bit,
                            size: selector.size,
                            byte_order: selector.byte_order,
                            value,
                        }),
                    },
                    confidence: (s.score * 100.0).round() / 100.0,
                    level: level(s.score),
                    reason: s.reason,
                    unconfirmed: s.unconfirmed,
                    sparkline: Sparkline {
                        t: s.spark.iter().map(|&(t, _)| seconds(t)).collect(),
                        v: s.spark.iter().map(|&(_, v)| v).collect(),
                    },
                    fit: s.fit.map(|f| FitJson {
                        reference: reference.clone().unwrap_or_default(),
                        unit: unit.to_owned(),
                        r: (f.r * 1000.0).round() / 1000.0,
                        factor: f.factor,
                        offset: f.offset,
                    }),
                }
            })
            .collect();
        to_json(&MessageSuggestions {
            key: stats.key(),
            frames: stats.frames.len(),
            sampled_frames: findings.sampled_frames,
            suggestions,
        })
    }
}

/// `12`, `12.5` or `0.25`: seconds as a person would type them.
fn trim_seconds(t: f64) -> String {
    let text = format!("{t:.3}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use can_core::id_key;
    use serde_json::{json, Value};

    /// 0x100 counts in byte 0 at 100 Hz for 10 s; 0x200 carries a speed in its first byte.
    fn session() -> Session {
        let mut log = String::new();
        for i in 0..1000u32 {
            let t = f64::from(i) / 100.0;
            log += &format!("({t:.6}) can0 100#{:02X}00\n", i % 256);
            log += &format!("({:.6}) can0 200#{:02X}\n", t + 0.001, i / 10);
        }
        let mut s = Session::new();
        s.push_chunk(log.as_bytes());
        s.finish();
        s
    }

    #[test]
    fn suggests_signals_as_json() {
        let s = session();
        let found: Value =
            serde_json::from_str(&s.suggest_signals(id_key(0, 0x100) as f64, "").unwrap()).unwrap();
        assert_eq!(found["key"], id_key(0, 0x100));
        assert_eq!(
            (&found["frames"], &found["sampledFrames"]),
            (&json!(1000), &json!(1000))
        );
        let first = &found["suggestions"][0];
        assert_eq!(first["kind"], "counter");
        assert_eq!(
            first["spec"],
            json!({ "startBit": 0, "size": 8, "byteOrder": "intel", "signed": false, "factor": 1.0, "offset": 0.0 })
        );
        assert_eq!(first["level"], "high");
        assert_eq!(first["unconfirmed"], false);
        assert_eq!(first["fit"], Value::Null);
        assert_eq!(first["sparkline"]["t"][0], 0.0);
        assert_eq!(first["sparkline"]["v"].as_array().unwrap().len(), 64);
        let confidence = first["confidence"].as_f64().unwrap();
        assert!(confidence > 0.9 && confidence < 1.0);
    }

    #[test]
    fn a_job_run_in_steps_gives_the_same_suggestions() {
        let mut s = session();
        let key = id_key(0, 0x100) as f64;
        let hints = json!({ "markers": [{ "t": 2.5 }] }).to_string();
        let whole = s.suggestions(key, &hints).unwrap();
        let id = s.begin_suggestions(key, &hints).unwrap();
        let other = s.begin_suggestions(id_key(0, 0x200) as f64, "").unwrap();
        let mut steps = 0;
        let stepped = loop {
            steps += 1;
            if let Some(json) = s.step_suggestions(id).unwrap() {
                break json;
            }
        };
        assert_eq!(stepped, whole);
        assert!(steps >= 2);
        assert_eq!(
            s.step_suggestions(id).unwrap_err(),
            "unknown suggestion job"
        );
        s.suggest_drop(other);
        assert_eq!(
            s.step_suggestions(other).unwrap_err(),
            "unknown suggestion job"
        );
    }

    /// A batch of `push_frames` records for ID 0x100: a counter and a slow value, from frame
    /// `from`, 10 ms apart, with every other pair of frames swapped as an adapter might.
    fn capture_batch(from: u32, count: u32) -> Vec<u8> {
        let mut batch = Vec::new();
        for i in from..from + count {
            let at = if i % 2 == 0 { i + 1 } else { i - 1 };
            let data = [i as u8, (i / 50) as u8, 0, 0];
            batch.extend_from_slice(&(f64::from(at) * 1e7).to_le_bytes());
            batch.extend_from_slice(&0x100u32.to_le_bytes());
            batch.extend_from_slice(&[0, data.len() as u8]);
            batch.extend_from_slice(&data);
        }
        batch
    }

    #[test]
    fn a_job_ends_when_the_store_changes_under_it() {
        let key = id_key(0, 0x100) as f64;
        let mut s = Session::new();
        s.start_capture("can0", 1_700_000_000_000.0);
        s.push_frames(&capture_batch(0, 2000)).unwrap();
        let changes: [fn(&mut Session); 5] = [
            |s| drop(s.push_frames(&capture_batch(2000, 10))),
            |s| drop(s.trim_capture(5e9)),
            |s| drop(s.finish_capture()),
            |s| s.start_capture("can0", 1_700_000_000_000.0),
            |s| s.push_chunk(b"(0.000000) can0 100#00\n"),
        ];
        for change in changes {
            if s.filter(key).ok().flatten().is_none() {
                s.start_capture("can0", 1_700_000_000_000.0);
                s.push_frames(&capture_batch(0, 2000)).unwrap();
            }
            let job = s.begin_suggestions(key, "").unwrap();
            assert_eq!(s.step_suggestions(job).unwrap(), None);
            change(&mut s);
            assert_eq!(s.step_suggestions(job).unwrap_err(), "the log changed");
            assert_eq!(s.step_suggestions(job).unwrap_err(), "the log changed");
        }
        // A job begun after the change runs to the end.
        s.start_capture("can0", 1_700_000_000_000.0);
        s.push_frames(&capture_batch(0, 2000)).unwrap();
        s.finish_capture().unwrap();
        let job = s.begin_suggestions(key, "").unwrap();
        let stepped = loop {
            if let Some(json) = s.step_suggestions(job).unwrap() {
                break json;
            }
        };
        assert_eq!(stepped, s.suggestions(key, "").unwrap());
    }

    #[test]
    fn many_jobs_can_be_under_way_at_once() {
        let mut s = session();
        let key = id_key(0, 0x100) as f64;
        let jobs: Vec<u32> = (0..40)
            .map(|_| s.begin_suggestions(key, "").unwrap())
            .collect();
        for job in jobs {
            while s.step_suggestions(job).unwrap().is_none() {}
        }
    }

    #[test]
    fn hints_are_checked() {
        let s = session();
        let key = id_key(0, 0x100) as f64;
        assert_eq!(s.suggestions(12345.0, "").unwrap_err(), "unknown ID");
        assert!(s.suggestions(key, "{ nope").is_err(), "bad JSON");
        let hints = json!({ "markers": [{ "t": 2.5 }] }).to_string();
        assert!(s.suggestions(key, &hints).is_ok());
        let reference =
            |key: f64| json!({ "reference": { "key": key, "signal": "Speed" } }).to_string();
        assert_eq!(
            s.suggestions(key, &reference(999.0)).unwrap_err(),
            "unknown reference ID"
        );
        assert_eq!(
            s.suggestions(key, &reference(id_key(0, 0x200) as f64))
                .unwrap_err(),
            "no loaded DBC defines the reference's message"
        );
    }

    #[test]
    fn a_float_suggestion_decodes_as_a_float() {
        let mut log = String::new();
        for i in 0..3000u32 {
            let v = (f64::from(i) / 300.0).sin() as f32 * 10.0;
            let hex: String = v.to_le_bytes().iter().map(|b| format!("{b:02X}")).collect();
            log += &format!("({:.6}) can0 100#{hex}00000000\n", f64::from(i) / 100.0);
        }
        let mut s = Session::new();
        s.push_chunk(log.as_bytes());
        s.finish();
        let key = id_key(0, 0x100) as f64;
        let found: Value = serde_json::from_str(&s.suggest_signals(key, "").unwrap()).unwrap();
        let first = &found["suggestions"][0];
        assert_eq!(first["kind"], "float");
        assert_eq!(
            first["spec"],
            json!({ "startBit": 0, "size": 32, "byteOrder": "intel", "signed": false, "float": true, "factor": 1.0, "offset": 0.0 })
        );
        let info: Value =
            serde_json::from_str(&s.decode_raw(key, &first["spec"].to_string()).unwrap()).unwrap();
        assert!(
            (info["max"].as_f64().unwrap() - 10.0).abs() < 1e-3,
            "{info}"
        );
        assert!(
            (info["min"].as_f64().unwrap() + 10.0).abs() < 1e-3,
            "{info}"
        );
    }

    #[test]
    fn a_page_suggestion_decodes_only_its_page() {
        let mut log = String::new();
        for i in 0..4000u32 {
            let page = i % 2;
            let base = [1000.0, 40_000.0][page as usize];
            let v = (base + (f64::from(i) / 200.0).sin() * 800.0) as u16;
            let [lo, hi] = v.to_le_bytes();
            let t = f64::from(i) / 100.0;
            log += &format!("({t:.6}) can0 100#{page:02X}{lo:02X}{hi:02X}0000000000\n");
        }
        let mut s = Session::new();
        s.push_chunk(log.as_bytes());
        s.finish();
        let key = id_key(0, 0x100) as f64;
        let found: Value = serde_json::from_str(&s.suggest_signals(key, "").unwrap()).unwrap();
        let all = found["suggestions"].as_array().unwrap();
        assert_eq!(all[0]["kind"], "multiplexor");
        let page1 = all
            .iter()
            .find(|g| g["spec"]["mux"]["value"] == 1)
            .expect("a page 1 cell");
        assert_eq!(
            page1["spec"]["mux"],
            json!({ "startBit": 0, "size": 8, "byteOrder": "intel", "value": 1 })
        );
        let info: Value =
            serde_json::from_str(&s.decode_raw(key, &page1["spec"].to_string()).unwrap()).unwrap();
        assert_eq!(info["count"], 2000);
        assert!(info["min"].as_f64().unwrap() >= 39_000.0, "{info}");
        assert!(info["name"].as_str().unwrap().ends_with(" m1"), "{info}");
    }

    #[test]
    fn marker_labels_read_as_typed() {
        assert_eq!(trim_seconds(12.0), "12");
        assert_eq!(trim_seconds(12.5), "12.5");
        assert_eq!(trim_seconds(0.25), "0.25");
    }

    /// The demo log's unknown IDs against how `sample-gen` writes them. Needs the demo log:
    /// `pnpm --dir web demo`, then
    /// `cargo test -p can-wasm --release -- --ignored --nocapture demo_unknown_ids`.
    #[test]
    #[ignore = "needs the generated demo log"]
    fn demo_unknown_ids() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let path =
            std::env::var("DEMO_LOG").unwrap_or_else(|_| format!("{root}/target/demo/demo.log"));
        let log = std::fs::read(&path).expect("demo log");
        let mut s = Session::new();
        s.set_file_name("demo.log");
        s.push_chunk(&log);
        s.finish();
        let dbc = std::fs::read(format!("{root}/crates/sample-gen/src/demo.dbc")).unwrap();
        let db: Value = serde_json::from_str(&crate::parse_dbc(&dbc).unwrap()).unwrap();
        s.set_databases(&serde_json::json!([{ "channel": null, "db": db }]).to_string())
            .unwrap();

        let mut ids: Vec<(u8, u32, String)> = [201, 501, 672, 1001, 1104, 1440, 1712, 0x98FE_F100]
            .into_iter()
            .map(|id| (0, id, String::new()))
            .chain([(1, 768, String::new())])
            .collect();
        if std::env::var("ALL_IDS").is_err() {
            ids.clear();
        }
        for id in ids.into_iter().chain([
            (0, 0x123, String::new()),
            (0, 0x456, String::new()),
            (
                0,
                0x123,
                serde_json::json!({ "markers": [], "reference": { "key": id_key(0, 501) as f64, "signal": "WheelSpeedFL" } })
                    .to_string(),
            ),
        ]) {
            let (channel, id, hints) = id;
            let started = std::time::Instant::now();
            let found: Value =
                serde_json::from_str(&s.suggest_signals(id_key(channel, id) as f64, &hints).unwrap())
                    .unwrap();
            println!(
                "{id:03X} in {:.1} ms, {} of {} frames",
                started.elapsed().as_secs_f64() * 1e3,
                found["sampledFrames"],
                found["frames"]
            );
            let suggestions = found["suggestions"].as_array().unwrap();
            let summary: Vec<String> = suggestions
                .iter()
                .map(|s| {
                    let spec = &s["spec"];
                    format!(
                        "{} {}|{}@{}{}",
                        s["kind"].as_str().unwrap(),
                        spec["startBit"],
                        spec["size"],
                        u8::from(spec["byteOrder"] == "intel"),
                        if spec["signed"] == true { '-' } else { '+' }
                    )
                })
                .collect();
            // sample-gen: a counter in byte 0, speed * 100 big-endian in bytes 2-3, a value
            // from 0 to 24 in byte 5 and noise in byte 6 of 0x123; 0x456 never changes.
            match (channel, id) {
                (0, 0x123) => {
                    let mut sorted = summary.clone();
                    sorted.sort();
                    assert_eq!(
                        sorted,
                        ["continuous 23|16@0+", "continuous 40|8@1+", "counter 0|8@1+"]
                    );
                }
                (0, 0x456) => assert!(summary.is_empty()),
                _ => {}
            }
            for s in suggestions {
                println!(
                    "  {:<10} {:>3}|{:<2} {:<8} signed={} {:.2} {:<6} {} {}",
                    s["kind"].as_str().unwrap(),
                    s["spec"]["startBit"],
                    s["spec"]["size"],
                    s["spec"]["byteOrder"].as_str().unwrap(),
                    s["spec"]["signed"],
                    s["confidence"].as_f64().unwrap(),
                    s["level"].as_str().unwrap(),
                    s["reason"].as_str().unwrap(),
                    s["fit"]
                );
            }
        }
    }
}
