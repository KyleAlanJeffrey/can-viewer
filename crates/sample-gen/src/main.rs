//! Development tool for the CAN viewer.
//!
//! ```text
//! sample-gen generate <out.log> <out.dbc> [frames]   synthetic drive + matching DBC
//! sample-gen bench <file>                            native parse throughput
//! sample-gen decode <file> <file.dbc> <frames>       CSV of decoded values, for cross-checks
//! sample-gen convert <in> <out.asc|out.trc>          rewrite a log in another format
//! ```
//!
//! Logs are read in any format the app opens, chosen as the app chooses it.
//!
//! The demo DBC describes most IDs in the log. `0x123` and `0x456` are left out on purpose,
//! as reverse-engineering practice: 0x123 carries a counter, a big-endian speed, a pedal
//! position and a noise byte.

mod export;

use std::f64::consts::TAU;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::process::ExitCode;
use std::time::Instant;

use can_core::{FrameStore, EXT_FLAG};
use can_dbc_model::{Database, MessageDef};
use can_formats::{AnyParser, Format, LogParser};

const DEMO_DBC: &str = include_str!("demo.dbc");
/// 2025-09-30T00:00:00Z
const START_S: i64 = 1_759_190_400;
const CHUNK: usize = 8 << 20;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["generate", log, dbc] => generate(log, dbc, 1_000_000),
        ["generate", log, dbc, n] => match n.parse() {
            Ok(n) => generate(log, dbc, n),
            Err(_) => Err(format!("bad frame count {n:?}")),
        },
        ["bench", log] => bench(log),
        ["decode", log, dbc, n] => match n.parse() {
            Ok(n) => decode(log, dbc, n),
            Err(_) => Err(format!("bad frame count {n:?}")),
        },
        ["convert", input, output] => {
            load_store(input).and_then(|(store, _, _)| export::convert(&store, output))
        }
        _ => Err(
            "usage: sample-gen generate <out.log> <out.dbc> [frames] | bench <file> | \
                  decode <file> <file.dbc> <frames> | convert <in> <out.asc|out.trc>"
                .into(),
        ),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn load_store(path: &str) -> Result<(FrameStore, AnyParser, f64), String> {
    let mut file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut store = FrameStore::new();
    let frames = (size / 40) as usize;
    store.reserve(frames, frames * 8);
    let mut parser = None;
    let mut buf = vec![0u8; CHUNK];
    let started = Instant::now();
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        parser
            .get_or_insert_with(|| AnyParser::new(Format::detect(path, &buf[..n])))
            .push(&buf[..n], &mut store);
    }
    let mut parser = parser.unwrap_or_else(|| AnyParser::new(Format::detect(path, &[])));
    parser.finish(&mut store);
    Ok((store, parser, started.elapsed().as_secs_f64()))
}

fn bench(path: &str) -> Result<(), String> {
    let (store, parser, secs) = load_store(path)?;
    let stats = parser.stats();
    let mb = stats.bytes as f64 / 1e6;
    println!(
        "{} frames, {} IDs, {:.0} MB in {:.2} s: {:.0} MB/s, {:.1} M frames/s, {:.0} MB store, {} rejected",
        store.len(),
        store.ids().len(),
        mb,
        secs,
        mb / secs,
        store.len() as f64 / secs / 1e6,
        store.heap_bytes() as f64 / 1e6,
        stats.rejected,
    );
    Ok(())
}

fn decode(log: &str, dbc: &str, limit: usize) -> Result<(), String> {
    let db = Database::from_dbc_bytes(&fs::read(dbc).map_err(|e| format!("{dbc}: {e}"))?)
        .map_err(|e| e.to_string())?;
    let (store, _, _) = load_store(log)?;
    let mut out = BufWriter::new(io::stdout().lock());
    let write_err = |e: io::Error| e.to_string();
    writeln!(out, "frame,message,signal,value").map_err(write_err)?;
    for index in 0..store.len().min(limit) {
        let frame = store.frame(index);
        let Some(message) = db.message(frame.id) else {
            continue;
        };
        for signal in &message.signals {
            if let Some(v) = message.decode(signal, frame.data) {
                writeln!(out, "{index},{},{},{v}", message.name, signal.name).map_err(write_err)?;
            }
        }
    }
    Ok(())
}

/// Deterministic xorshift64 so demo files are reproducible.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// Uniform in `[-1, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 52) as f64 - 1.0
    }
}

/// Simulated vehicle, sampled at arbitrary times.
struct Vehicle {
    rng: Rng,
    odometer_km: f64,
    last_t: f64,
}

/// Speed over a repeating 180 s drive cycle: idle, accelerate, cruise, brake, idle.
fn speed_kmh(t: f64) -> f64 {
    let smooth = |x: f64| {
        let x = x.clamp(0.0, 1.0);
        x * x * (3.0 - 2.0 * x)
    };
    match t % 180.0 {
        p if p < 10.0 => 0.0,
        p if p < 50.0 => 110.0 * smooth((p - 10.0) / 40.0),
        p if p < 110.0 => 110.0 + 8.0 * (TAU * (p - 50.0) / 20.0).sin(),
        p if p < 150.0 => 110.0 * (1.0 - smooth((p - 110.0) / 40.0)),
        _ => 0.0,
    }
}

fn steering_deg(t: f64) -> f64 {
    120.0 * (TAU * t / 23.0).sin() + 15.0 * (TAU * t / 3.1).sin()
}

impl Vehicle {
    fn advance(&mut self, t: f64) {
        self.odometer_km += speed_kmh(t) / 3600.0 * (t - self.last_t);
        self.last_t = t;
    }

    fn payload(&mut self, message: &MessageDef, t: f64, count: u64) -> Vec<(&'static str, f64)> {
        let speed = speed_kmh(t);
        let accel = (speed_kmh(t + 0.1) - speed) / 0.1;
        let steer = steering_deg(t);
        let moving = speed > 0.5;
        let noise = self.rng.unit();
        let counter = (count % 16) as f64;
        match message.name.as_str() {
            "ENGINE_1" => vec![
                (
                    "EngineSpeed",
                    if moving {
                        1000.0 + (speed % 35.0) / 35.0 * 3500.0
                    } else {
                        800.0
                    } + noise * 15.0,
                ),
                (
                    "ThrottlePos",
                    (accel * 12.0 + speed / 6.0).clamp(0.0, 100.0),
                ),
                ("CoolantTemp", 90.0 - 70.0 * (-t / 400.0).exp()),
                ("Counter", counter),
            ],
            "WHEEL_SPEEDS" => {
                let turn = steer / 1000.0;
                vec![
                    (
                        "WheelSpeedFL",
                        (speed * (1.0 - turn) + noise * 0.05).max(0.0),
                    ),
                    (
                        "WheelSpeedFR",
                        (speed * (1.0 + turn) + noise * 0.05).max(0.0),
                    ),
                    (
                        "WheelSpeedRL",
                        (speed * (1.0 - turn) - noise * 0.05).max(0.0),
                    ),
                    (
                        "WheelSpeedRR",
                        (speed * (1.0 + turn) - noise * 0.05).max(0.0),
                    ),
                ]
            }
            "STEERING" => vec![
                ("SteeringAngle", steer),
                ("SteeringRate", (steering_deg(t + 0.01) - steer) / 0.01),
                ("Counter", counter),
            ],
            "VEHICLE_STATE" => vec![
                ("Gear", if t % 180.0 < 5.0 { 0.0 } else { 3.0 }),
                ("VehicleSpeed", speed),
                ("Odometer", 12_345.6 + self.odometer_km),
            ],
            "BODY" => {
                let blink = if ((t * 3.0) as u64).is_multiple_of(2) {
                    1.0
                } else {
                    0.0
                };
                vec![
                    ("DoorFL", 0.0),
                    ("DoorFR", 0.0),
                    ("TurnLeft", if steer < -60.0 { blink } else { 0.0 }),
                    ("TurnRight", if steer > 60.0 { blink } else { 0.0 }),
                    ("Headlights", if t > 3600.0 { 2.0 } else { 0.0 }),
                ]
            }
            "IMU" => {
                let v = speed / 3.6;
                let wheel = (steer / 16.0).to_radians();
                vec![
                    (
                        "LateralAccel",
                        (v * v * wheel.tan() / 2.8).clamp(-12.0, 12.0) + noise * 0.05,
                    ),
                    (
                        "YawRate",
                        (v * wheel.tan() / 2.8).to_degrees() + noise * 0.1,
                    ),
                ]
            }
            "BATTERY" => {
                let page = (count % 2) as f64;
                let base = 3.95 - t / 200_000.0;
                let cell = |i: f64| base + 0.004 * i + noise * 0.002;
                let mut v = vec![
                    ("Page", page),
                    (
                        "PackCurrent",
                        (-accel * 40.0 - speed * 0.5).clamp(-256.0, 254.0),
                    ),
                ];
                let names = if page == 0.0 {
                    ["Cell1", "Cell2", "Cell3"]
                } else {
                    ["Cell4", "Cell5", "Cell6"]
                };
                v.extend(
                    names
                        .iter()
                        .enumerate()
                        .map(|(i, &n)| (n, cell(i as f64 + page * 3.0))),
                );
                v
            }
            "CCVS" => vec![
                ("WheelBasedVehicleSpeed", speed),
                ("CruiseControlActive", if speed > 100.0 { 1.0 } else { 0.0 }),
            ],
            "RADAR_TRACKS" => {
                const NAMES: [(&str, &str); 8] = [
                    ("Track1Range", "Track1RelSpeed"),
                    ("Track2Range", "Track2RelSpeed"),
                    ("Track3Range", "Track3RelSpeed"),
                    ("Track4Range", "Track4RelSpeed"),
                    ("Track5Range", "Track5RelSpeed"),
                    ("Track6Range", "Track6RelSpeed"),
                    ("Track7Range", "Track7RelSpeed"),
                    ("Track8Range", "Track8RelSpeed"),
                ];
                let mut v = Vec::with_capacity(16);
                for (k, (range, rel)) in NAMES.iter().enumerate() {
                    let k = k as f64;
                    let r = |t: f64| 25.0 + 12.0 * k + 6.0 * (t / 4.0 + k).sin();
                    v.push((*range, r(t)));
                    v.push((*rel, (r(t + 0.01) - r(t)) / 0.01));
                }
                v
            }
            _ => Vec::new(),
        }
    }
}

struct Scheduled {
    channel: &'static str,
    id: u32,
    fd: bool,
    period_us: i64,
    next_us: i64,
    count: u64,
    message: Option<usize>,
}

fn generate(log_path: &str, dbc_path: &str, frames: u64) -> Result<(), String> {
    let db = Database::from_dbc_str(DEMO_DBC).map_err(|e| format!("demo DBC: {e}"))?;
    // Fresh checkouts have no output directory (web/public/demo is git-ignored).
    for path in [log_path, dbc_path] {
        if let Some(dir) = std::path::Path::new(path).parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
    }
    fs::write(dbc_path, DEMO_DBC).map_err(|e| format!("{dbc_path}: {e}"))?;

    let mut schedule: Vec<Scheduled> = [
        ("can0", 201, 10_000),
        ("can0", 501, 20_000),
        ("can0", 672, 10_000),
        ("can0", 1001, 50_000),
        ("can0", 1104, 100_000),
        ("can0", 1440, 10_000),
        ("can0", 1712, 100_000),
        ("can0", 0x18FE_F100 | EXT_FLAG, 100_000),
        ("can1", 768, 10_000),
        ("can0", 0x123, 20_000),
        ("can0", 0x456, 1_000_000),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (channel, id, period_us))| Scheduled {
        channel,
        id,
        fd: id == 768,
        period_us,
        // Stagger messages so their timestamps interleave rather than collide.
        next_us: 370 * i as i64,
        count: 0,
        message: db.messages.iter().position(|m| m.id == id),
    })
    .collect();

    let file = File::create(log_path).map_err(|e| format!("{log_path}: {e}"))?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    let mut vehicle = Vehicle {
        rng: Rng(0x2545_F491_4F6C_DD1D),
        odometer_km: 0.0,
        last_t: 0.0,
    };
    let mut line = Vec::with_capacity(256);
    let started = Instant::now();

    for _ in 0..frames {
        let next = schedule
            .iter_mut()
            .min_by_key(|s| s.next_us)
            .expect("schedule is not empty");
        let jitter = (vehicle.rng.unit() * 30.0) as i64;
        let ts_us = next.next_us + jitter;
        let t = next.next_us as f64 / 1e6;
        vehicle.advance(t);

        let mut data = vec![0u8; if next.fd { 32 } else { 8 }];
        match next.message {
            Some(m) => {
                let message = &db.messages[m];
                for (name, value) in vehicle.payload(message, t, next.count) {
                    let signal = message
                        .signal(name)
                        .ok_or_else(|| format!("no signal {name}"))?;
                    signal.encode(&mut data, value.clamp(signal.min, signal.max));
                }
                if message.name == "ENGINE_1" {
                    data[7] = data[..7].iter().fold(0u8, |a, &b| a.wrapping_add(b));
                }
            }
            None if next.id == 0x123 => {
                let speed = (speed_kmh(t) * 100.0) as u16;
                data[0] = next.count as u8;
                data[2..4].copy_from_slice(&speed.to_be_bytes());
                data[4] = 0xAA;
                data[5] = ((speed_kmh(t + 0.1) - speed_kmh(t)).max(0.0) * 60.0).min(255.0) as u8;
                data[6] = vehicle.rng.next() as u8;
            }
            None => data.copy_from_slice(b"1G1RC6E4"),
        }

        line.clear();
        let secs = START_S + ts_us.div_euclid(1_000_000);
        let micros = ts_us.rem_euclid(1_000_000);
        write!(line, "({secs}.{micros:06}) {} ", next.channel).map_err(|e| e.to_string())?;
        if next.id & EXT_FLAG != 0 {
            write!(line, "{:08X}", next.id & !EXT_FLAG).map_err(|e| e.to_string())?;
        } else {
            write!(line, "{:03X}", next.id).map_err(|e| e.to_string())?;
        }
        line.extend_from_slice(if next.fd { b"##1" } else { b"#" });
        for b in &data {
            write!(line, "{b:02X}").map_err(|e| e.to_string())?;
        }
        line.push(b'\n');
        out.write_all(&line).map_err(|e| e.to_string())?;

        next.count += 1;
        next.next_us += next.period_us;
    }
    out.flush().map_err(|e| e.to_string())?;
    let size = fs::metadata(log_path).map_err(|e| e.to_string())?.len();
    println!(
        "wrote {frames} frames ({:.0} MB, {:.0} s of driving) to {log_path} in {:.1} s",
        size as f64 / 1e6,
        vehicle.last_t,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Converts a small demo to `extension` and checks that it reads back frame for frame.
    fn round_trip(extension: &str) {
        let dir =
            std::env::temp_dir().join(format!("sample-gen-{}-{extension}", std::process::id()));
        let path = |name: &str| dir.join(name).to_str().unwrap().to_owned();
        generate(&path("demo.log"), &path("demo.dbc"), 20_000).unwrap();
        let (original, _, _) = load_store(&path("demo.log")).unwrap();
        let converted = path(&format!("demo.{extension}"));
        export::convert(&original, &converted).unwrap();

        let (copy, parser, _) = load_store(&converted).unwrap();
        assert_eq!(parser.format().name(), extension);
        let stats = parser.stats();
        assert_eq!(stats.rejected, 0, "{:?}", stats.first_rejection);
        assert_eq!(copy.len(), original.len());
        for index in 0..original.len() {
            let (a, b) = (original.frame(index), copy.frame(index));
            assert_eq!(a, b, "frame {index}");
        }
        assert_eq!(copy.channels(), ["can1", "can2"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn asc_round_trips_the_demo() {
        round_trip("asc");
    }

    #[test]
    fn trc_round_trips_the_demo() {
        round_trip("trc");
    }
}
