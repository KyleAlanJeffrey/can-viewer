//! Editable CAN database model, loaded from DBC via `can-dbc`, with signal decoding and encoding.
//!
//! `can-dbc` only parses, so this crate owns the model the UI edits and the decoder the viewer
//! runs. Message IDs use the DBC convention: bit 31 set for extended IDs.

pub mod bits;
pub mod j1939;
mod writer;

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

pub use bits::ByteOrder;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueKind {
    Unsigned,
    Signed,
    Float32,
    Float64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDef {
    pub name: String,
    /// DBC start bit: the LSB for Intel signals, the MSB for Motorola signals.
    pub start_bit: u16,
    pub size: u16,
    pub byte_order: ByteOrder,
    pub kind: ValueKind,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub unit: String,
    /// This signal selects which multiplexed signals are present.
    pub is_multiplexor: bool,
    /// Only present when the message's multiplexor has this raw value, unless `mux_switch`
    /// says otherwise.
    pub mux_value: Option<u64>,
    pub value_table: Vec<(i64, String)>,
    pub comment: Option<String>,
    /// Receiving nodes. Not in the UI's `SignalDef` yet, so absent means none.
    #[serde(default)]
    pub receivers: Vec<String>,
    /// Extended multiplexing (`SG_MUL_VAL_`): which multiplexor switches this signal and under
    /// which of its raw values. Takes precedence over `mux_value`. Absent means simple
    /// multiplexing by the message's multiplexor.
    #[serde(default)]
    pub mux_switch: Option<MuxSwitch>,
}

/// The multiplexor that switches a signal in, and when. The multiplexor may itself be
/// multiplexed, in which case the signal is present only when the multiplexor is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxSwitch {
    /// Name of the multiplexor signal, in the same message.
    pub signal: String,
    /// Inclusive raw value ranges of the multiplexor under which the signal is present.
    pub ranges: Vec<(u64, u64)>,
}

impl MuxSwitch {
    #[must_use]
    pub fn covers(&self, raw: u64) -> bool {
        self.ranges.iter().any(|&(lo, hi)| (lo..=hi).contains(&raw))
    }
}

impl SignalDef {
    #[must_use]
    pub fn raw(&self, data: &[u8]) -> Option<u64> {
        bits::extract(data, self.start_bit, self.size, self.byte_order)
    }

    /// Physical value, ignoring multiplexing (see [`MessageDef::decode`]).
    #[must_use]
    pub fn value(&self, data: &[u8]) -> Option<f64> {
        self.raw(data).map(|raw| self.physical(raw))
    }

    fn physical(&self, raw: u64) -> f64 {
        let v = match self.kind {
            ValueKind::Unsigned => raw as f64,
            ValueKind::Signed => bits::sign_extend(raw, self.size) as f64,
            ValueKind::Float32 => f64::from(f32::from_bits(raw as u32)),
            ValueKind::Float64 => f64::from_bits(raw),
        };
        v * self.factor + self.offset
    }

    /// Raw field value for a physical value, rounded to the nearest step.
    #[must_use]
    pub fn raw_for(&self, physical: f64) -> u64 {
        let scaled = (physical - self.offset) / self.factor;
        match self.kind {
            ValueKind::Unsigned => scaled.round() as u64,
            ValueKind::Signed => scaled.round() as i64 as u64,
            ValueKind::Float32 => u64::from((scaled as f32).to_bits()),
            ValueKind::Float64 => scaled.to_bits(),
        }
    }

    pub fn encode(&self, data: &mut [u8], physical: f64) -> Option<()> {
        bits::insert(
            data,
            self.start_bit,
            self.size,
            self.byte_order,
            self.raw_for(physical),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDef {
    pub id: u32,
    pub name: String,
    pub size: u32,
    pub transmitter: Option<String>,
    pub comment: Option<String>,
    pub signals: Vec<SignalDef>,
    /// A J1939 parameter group (DBC `VFrameFormat` J1939PG). It decodes frames by PGN, and some
    /// raw values of its signals mean error or not available; see [`j1939::not_available`].
    #[serde(default)]
    pub j1939: bool,
}

impl MessageDef {
    #[must_use]
    pub fn signal(&self, name: &str) -> Option<&SignalDef> {
        self.signals.iter().find(|s| s.name == name)
    }

    #[must_use]
    pub fn multiplexor(&self) -> Option<&SignalDef> {
        self.signals.iter().find(|s| s.is_multiplexor)
    }

    /// Physical value of `signal`, or `None` if the frame is too short, the signal is
    /// multiplexed out of this frame ([`MessageDef::is_present`]), or this is J1939 and an
    /// unsigned signal of whole bytes has a raw value meaning error or not available
    /// ([`j1939::not_available`]).
    #[must_use]
    pub fn decode(&self, signal: &SignalDef, data: &[u8]) -> Option<f64> {
        if !self.is_present(signal, data) {
            return None;
        }
        let raw = signal.raw(data)?;
        if self.j1939
            && signal.kind == ValueKind::Unsigned
            && j1939::not_available(raw, signal.size)
        {
            return None;
        }
        Some(signal.physical(raw))
    }

    /// Whether `signal` is switched into this frame. A signal with a `mux_switch` is present
    /// when its multiplexor's raw value is in one of the ranges and that multiplexor is itself
    /// present; one with only a `mux_value` when the message's multiplexor has that value.
    #[must_use]
    pub fn is_present(&self, signal: &SignalDef, data: &[u8]) -> bool {
        // A chain of switches can't be longer than the signal list, so anything deeper is a
        // cycle in a hand-edited database.
        let mut hops = 0;
        let mut current = signal;
        loop {
            let Some(switch) = &current.mux_switch else {
                return match current.mux_value {
                    Some(want) => self.multiplexor().and_then(|m| m.raw(data)) == Some(want),
                    None => true,
                };
            };
            let Some(multiplexor) = self.signal(&switch.signal) else {
                return false;
            };
            if !multiplexor.raw(data).is_some_and(|raw| switch.covers(raw)) {
                return false;
            }
            hops += 1;
            if hops > self.signals.len() {
                return false;
            }
            current = multiplexor;
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Database {
    pub messages: Vec<MessageDef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadError(pub String);

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LoadError {}

impl Database {
    /// Load a DBC file. DBC doesn't declare its encoding: this tries UTF-8, then Windows-1252.
    pub fn from_dbc_bytes(bytes: &[u8]) -> Result<Self, LoadError> {
        Self::from_dbc_str(&decode_text(bytes))
    }

    pub fn from_dbc_str(text: &str) -> Result<Self, LoadError> {
        let dbc = can_dbc::Dbc::try_from(text).map_err(|e| LoadError(e.to_string()))?;
        let messages = dbc
            .messages
            .iter()
            .filter(|m| m.name != "VECTOR__INDEPENDENT_SIG_MSG")
            .map(|m| MessageDef {
                id: m.id.raw(),
                name: m.name.clone(),
                size: u32::try_from(m.size).unwrap_or(u32::MAX),
                transmitter: m.transmitter.clone(),
                comment: dbc.message_comment(m.id).map(str::to_owned),
                signals: m
                    .signals
                    .iter()
                    .map(|s| signal_from_ast(&dbc, m.id, s))
                    .collect(),
                j1939: is_j1939(&dbc, m.id),
            })
            .collect();
        Ok(Self { messages })
    }

    #[must_use]
    pub fn message(&self, id: u32) -> Option<&MessageDef> {
        self.messages.iter().find(|m| m.id == id)
    }

    /// The J1939 message whose PGN a frame with ID `id` carries; see [`j1939::matches`]. Of
    /// several, the first with the frame's ID apart from priority wins, then the first from the
    /// frame's source address, then the first. Look for an exact [`Database::message`] first.
    #[must_use]
    pub fn j1939_message(&self, id: u32) -> Option<&MessageDef> {
        let rank = |m: &MessageDef| {
            if j1939::without_priority(m.id) == j1939::without_priority(id) {
                0
            } else if j1939::source_address(m.id) == j1939::source_address(id) {
                1
            } else {
                2
            }
        };
        self.messages
            .iter()
            .filter(|m| m.j1939 && j1939::matches(m.id, id))
            .min_by_key(|m| rank(m))
    }
}

/// An extended message with `VFrameFormat` J1939PG, given for the message or as the default. A
/// file that doesn't define `VFrameFormat` but has `ProtocolType` "J1939" counts all its extended
/// messages as J1939.
fn is_j1939(dbc: &can_dbc::Dbc, id: can_dbc::MessageId) -> bool {
    use can_dbc::{AttributeDefinition as D, AttributeValue as V, AttributeValueType as T};

    const FRAME_FORMAT: &str = "VFrameFormat";
    if !matches!(id, can_dbc::MessageId::Extended(_)) {
        return false;
    }
    let choices = dbc.attribute_definitions.iter().find_map(|d| match d {
        D::Message(name, T::Enum(choices)) if name == FRAME_FORMAT => Some(choices),
        _ => None,
    });
    let Some(choices) = choices else {
        let protocol = dbc
            .attribute_values_database
            .iter()
            .find(|a| a.name == "ProtocolType")
            .map(|a| &a.value);
        return matches!(protocol, Some(V::String(p)) if p == "J1939");
    };
    // Values are enum indexes, but defaults are usually written as the label.
    let choice = |i: Option<usize>| i.and_then(|i| choices.get(i)).map(String::as_str);
    let label = match dbc.resolved_message_attribute(id, FRAME_FORMAT) {
        Some(V::String(label)) => Some(label.as_str()),
        Some(&V::Uint(i)) => choice(usize::try_from(i).ok()),
        Some(&V::Int(i)) => choice(usize::try_from(i).ok()),
        Some(&V::Double(d)) => choice(Some(d as usize)),
        None => None,
    };
    label == Some("J1939PG")
}

fn signal_from_ast(dbc: &can_dbc::Dbc, id: can_dbc::MessageId, s: &can_dbc::Signal) -> SignalDef {
    use can_dbc::{MultiplexIndicator as M, SignalExtendedValueType as X};

    let kind = match dbc.extended_value_type_for_signal(id, &s.name) {
        Some(X::IEEEfloat32Bit) => ValueKind::Float32,
        Some(X::IEEEdouble64bit) => ValueKind::Float64,
        _ if s.value_type == can_dbc::ValueType::Signed => ValueKind::Signed,
        _ => ValueKind::Unsigned,
    };
    let (is_multiplexor, mux_value) = match s.multiplexer_indicator {
        M::Plain => (false, None),
        M::Multiplexor => (true, None),
        M::MultiplexedSignal(v) => (false, Some(v)),
        M::MultiplexorAndMultiplexedSignal(v) => (true, Some(v)),
    };
    let mux_switch = dbc
        .extended_multiplex
        .iter()
        .find(|x| x.message_id == id && x.signal_name == s.name)
        .map(|x| MuxSwitch {
            signal: x.multiplexor_signal_name.clone(),
            ranges: x
                .mappings
                .iter()
                .map(|m| (m.min_value, m.max_value))
                .collect(),
        });
    SignalDef {
        name: s.name.clone(),
        start_bit: u16::try_from(s.start_bit).unwrap_or(u16::MAX),
        size: u16::try_from(s.size).unwrap_or(0),
        byte_order: match s.byte_order {
            can_dbc::ByteOrder::LittleEndian => ByteOrder::Intel,
            can_dbc::ByteOrder::BigEndian => ByteOrder::Motorola,
        },
        kind,
        factor: s.factor,
        offset: s.offset,
        min: numeric(&s.min),
        max: numeric(&s.max),
        unit: s.unit.clone(),
        is_multiplexor,
        mux_value,
        value_table: dbc
            .value_descriptions_for_signal(id, &s.name)
            .unwrap_or_default()
            .iter()
            .map(|d| (d.id, d.description.clone()))
            .collect(),
        comment: dbc.signal_comment(id, &s.name).map(str::to_owned),
        receivers: s.receivers.clone(),
        mux_switch,
    }
}

fn numeric(v: &can_dbc::NumericValue) -> f64 {
    match *v {
        can_dbc::NumericValue::Uint(u) => u as f64,
        can_dbc::NumericValue::Int(i) => i as f64,
        can_dbc::NumericValue::Double(d) => d,
    }
}

/// UTF-8 (minus any BOM) if valid, otherwise Windows-1252, which Vector tools write.
#[must_use]
pub fn decode_text(bytes: &[u8]) -> Cow<'_, str> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Cow::Borrowed(s);
    }
    Cow::Owned(bytes.iter().map(|&b| cp1252(b)).collect())
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{81}', '\u{201A}', '\u{192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{2C6}', '\u{2030}', '\u{160}', '\u{2039}', '\u{152}', '\u{8D}', '\u{17D}',
        '\u{8F}', '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}',
        '\u{2014}', '\u{2DC}', '\u{2122}', '\u{161}', '\u{203A}', '\u{153}', '\u{9D}', '\u{17E}',
        '\u{178}',
    ];
    match b {
        0x80..=0x9F => HIGH[usize::from(b - 0x80)],
        _ => char::from(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 100 ENGINE: 8 ECU
 SG_ RPM : 0|16@1+ (0.25,0) [0|16383.75] "rpm" Vector__XXX
 SG_ Temp : 16|8@1+ (1,-40) [-40|215] "degC" Vector__XXX
 SG_ Torque : 31|12@0- (0.5,0) [-1024|1023.5] "Nm" Vector__XXX

BO_ 2566844672 J1939_CCVS: 8 ECU
 SG_ Speed : 8|16@1+ (0.00390625,0) [0|250.996] "km/h" Vector__XXX

BO_ 200 BATTERY: 8 ECU
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Cell1 m0 : 8|16@1+ (0.001,0) [0|65.535] "V" Vector__XXX
 SG_ Cell4 m1 : 8|16@1+ (0.001,0) [0|65.535] "V" Vector__XXX

BO_ 300 IMU: 8 ECU
 SG_ LatAccel : 0|32@1- (1,0) [-100|100] "m/s2" Vector__XXX

CM_ SG_ 100 RPM "Engine speed";
VAL_ 100 Temp 0 "cold" 255 "sensor fault" ;
SIG_VALTYPE_ 300 LatAccel : 1;
"#;

    fn db() -> Database {
        Database::from_dbc_str(DBC).unwrap()
    }

    #[test]
    fn loads_messages_and_signal_attributes() {
        let db = db();
        assert_eq!(db.messages.len(), 4);
        let engine = db.message(100).unwrap();
        let rpm = engine.signal("RPM").unwrap();
        assert_eq!(rpm.comment.as_deref(), Some("Engine speed"));
        assert_eq!(rpm.unit, "rpm");
        let temp = engine.signal("Temp").unwrap();
        assert_eq!(
            temp.value_table,
            vec![(0, "cold".into()), (255, "sensor fault".into())]
        );
        let torque = engine.signal("Torque").unwrap();
        assert_eq!(
            (torque.byte_order, torque.kind),
            (ByteOrder::Motorola, ValueKind::Signed)
        );
        assert!(db.message(0x18FE_F100 | 1 << 31).is_some());
        assert_eq!(db.message(300).unwrap().signals[0].kind, ValueKind::Float32);
    }

    #[test]
    fn decodes_scaled_signed_and_float_signals() {
        let db = db();
        let engine = db.message(100).unwrap();
        // RPM raw 0x1F40 = 8000 -> 2000 rpm; Temp raw 130 -> 90 degC;
        // Torque Motorola MSB at byte 3 bit 7, 12 bits: 0xFF8 -> -8 -> -4 Nm.
        let data = [0x40, 0x1F, 130, 0xFF, 0x80, 0, 0, 0];
        let v = |name| engine.decode(engine.signal(name).unwrap(), &data);
        assert_eq!(v("RPM"), Some(2000.0));
        assert_eq!(v("Temp"), Some(90.0));
        assert_eq!(v("Torque"), Some(-4.0));

        let imu = db.message(300).unwrap();
        let mut data = [0u8; 8];
        data[..4].copy_from_slice(&(-3.5f32).to_bits().to_le_bytes());
        assert_eq!(imu.decode(&imu.signals[0], &data), Some(-3.5));
    }

    #[test]
    fn multiplexed_signals_only_decode_on_their_page() {
        let db = db();
        let battery = db.message(200).unwrap();
        let (cell1, cell4) = (
            battery.signal("Cell1").unwrap(),
            battery.signal("Cell4").unwrap(),
        );
        let page0 = [0, 0x10, 0x0E, 0, 0, 0, 0, 0];
        let page1 = [1, 0x10, 0x0E, 0, 0, 0, 0, 0];
        assert_eq!(battery.decode(cell1, &page0), Some(3.6));
        assert_eq!(battery.decode(cell4, &page0), None);
        assert_eq!(battery.decode(cell4, &page1), Some(3.6));
    }

    #[test]
    fn encode_then_decode_round_trips() {
        let db = db();
        let engine = db.message(100).unwrap();
        let mut data = [0u8; 8];
        for (name, v) in [("RPM", 1234.5), ("Temp", -12.0), ("Torque", -300.5)] {
            engine.signal(name).unwrap().encode(&mut data, v).unwrap();
        }
        for (name, v) in [("RPM", 1234.5), ("Temp", -12.0), ("Torque", -300.5)] {
            assert_eq!(
                engine.decode(engine.signal(name).unwrap(), &data),
                Some(v),
                "{name}"
            );
        }
    }

    #[test]
    fn json_round_trips_and_accepts_the_ui_shape() {
        let db = db();
        let json = serde_json::to_string(&db).unwrap();
        assert_eq!(serde_json::from_str::<Database>(&json).unwrap(), db);

        // The UI adds a name and doesn't know about receivers.
        let ui = r#"{"name": "edited.dbc", "messages": [{"id": 2147484195, "name": "NEW",
            "size": 8, "transmitter": null, "comment": null, "signals": [{"name": "Speed",
            "startBit": 7, "size": 16, "byteOrder": "motorola", "kind": "signed", "factor": 0.5,
            "offset": 0, "min": -100, "max": 100, "unit": "km/h", "isMultiplexor": false,
            "muxValue": null, "valueTable": [[0, "stop"]], "comment": "edited"}]}]}"#;
        let db: Database = serde_json::from_str(ui).unwrap();
        let speed = &db.message(0x223 | 1 << 31).unwrap().signals[0];
        assert_eq!(speed.byte_order, ByteOrder::Motorola);
        assert_eq!(speed.kind, ValueKind::Signed);
        assert_eq!(speed.value_table, vec![(0, "stop".into())]);
        assert!(speed.receivers.is_empty());
    }

    pub(crate) const J1939_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 2364540158 EEC1: 8 ECU
 SG_ EngineSpeed : 24|16@1+ (0.125,0) [0|8031.875] "rpm" Vector__XXX
 SG_ Unspecified : 0|8@1+ (1,0) [0|0] "" Vector__XXX
 SG_ Switch : 8|2@1+ (1,0) [0|1] "" Vector__XXX

BO_ 2566844672 RAW_EXT: 8 ECU
 SG_ Value : 0|8@1+ (1,0) [0|100] "" Vector__XXX

BA_DEF_ BO_  "VFrameFormat" ENUM  "StandardCAN","ExtendedCAN","reserved","J1939PG";
BA_DEF_  "ProtocolType" STRING ;
BA_DEF_DEF_  "VFrameFormat" "J1939PG";
BA_DEF_DEF_  "ProtocolType" "";
BA_ "ProtocolType" "J1939";
BA_ "VFrameFormat" BO_ 2566844672 1;
"#;

    #[test]
    fn reads_j1939_frame_format() {
        let db = Database::from_dbc_str(J1939_DBC).unwrap();
        assert!(db.message(0x8CF0_04FE).unwrap().j1939, "from the default");
        assert!(
            !db.message(0x98FE_F100).unwrap().j1939,
            "ExtendedCAN by value"
        );
        assert!(!self::db().messages.iter().any(|m| m.j1939));

        // ProtocolType alone marks extended messages.
        let protocol_only = J1939_DBC
            .lines()
            .filter(|l| !l.contains("VFrameFormat"))
            .collect::<Vec<_>>()
            .join("\n");
        let db = Database::from_dbc_str(&protocol_only).unwrap();
        assert!(db.messages.iter().all(|m| m.j1939));
    }

    #[test]
    fn standard_messages_are_never_j1939() {
        let with_standard = J1939_DBC.replace(
            "BO_ 2566844672 RAW_EXT",
            "BO_ 1024 STANDARD: 8 ECU\n SG_ Value : 0|8@1+ (1,0) [0|100] \"\" Vector__XXX\n\n\
             BO_ 2566844672 RAW_EXT",
        );
        let db = Database::from_dbc_str(&with_standard).unwrap();
        assert!(!db.message(1024).unwrap().j1939, "J1939PG by default");
        let text = db.to_dbc();
        assert!(!text.contains("\"VFrameFormat\" BO_ 1024 "), "{text}");
        assert_eq!(Database::from_dbc_str(&text).unwrap(), db);

        let protocol_only = with_standard
            .lines()
            .filter(|l| !l.contains("VFrameFormat"))
            .collect::<Vec<_>>()
            .join("\n");
        let db = Database::from_dbc_str(&protocol_only).unwrap();
        assert!(!db.message(1024).unwrap().j1939);
    }

    #[test]
    fn j1939_lookup_and_not_available_values() {
        let db = Database::from_dbc_str(J1939_DBC).unwrap();
        let eec1 = db.j1939_message(0x0CF0_0400 | j1939::EXTENDED).unwrap();
        assert_eq!(eec1.name, "EEC1");
        assert!(
            db.j1939_message(0x98FE_F117).is_none(),
            "RAW_EXT isn't J1939"
        );

        let mut speed = eec1.signal("EngineSpeed").unwrap().clone();
        let rpm = |speed: &SignalDef, raw: u16| {
            let mut data = [0u8; 8];
            data[3..5].copy_from_slice(&raw.to_le_bytes());
            eec1.decode(speed, &data)
        };
        assert_eq!(rpm(&speed, 8000), Some(1000.0));
        assert_eq!(rpm(&speed, 0xFAFF), Some(8031.875));
        assert_eq!(rpm(&speed, 0xFB00), None, "parameter-specific indicator");
        assert_eq!(rpm(&speed, 0xFE00), None, "error");
        assert_eq!(rpm(&speed, 0xFFFF), None, "not available");
        speed.max = 3000.0;
        assert_eq!(rpm(&speed, 25_600), Some(3200.0), "beyond the DBC range");

        let byte = |name, data: u8| eec1.decode(eec1.signal(name).unwrap(), &[data; 8]);
        assert_eq!(byte("Unspecified", 200), Some(200.0));
        assert_eq!(byte("Unspecified", 0xFB), None);
        assert_eq!(
            byte("Switch", 3),
            Some(3.0),
            "bit fields have no such range"
        );

        let raw_ext = db.message(0x98FE_F100).unwrap();
        assert_eq!(raw_ext.decode(&raw_ext.signals[0], &[0xFF; 8]), Some(255.0));
    }

    fn j1939_messages(defs: &[(u32, &str)]) -> Database {
        let messages = defs
            .iter()
            .map(|&(id, name)| MessageDef {
                id,
                name: name.into(),
                size: 8,
                transmitter: None,
                comment: None,
                signals: Vec::new(),
                j1939: true,
            })
            .collect();
        Database { messages }
    }

    fn j1939_name(db: &Database, id: u32) -> Option<&str> {
        db.j1939_message(id).map(|m| m.name.as_str())
    }

    #[test]
    fn j1939_lookup_prefers_the_frame_id_then_its_source_address() {
        let db = j1939_messages(&[(0x98FE_F100, "CCVS_ENGINE"), (0x98FE_F117, "CCVS_CLUSTER")]);
        assert_eq!(j1939_name(&db, 0x8CFE_F117), Some("CCVS_CLUSTER"));
        assert_eq!(j1939_name(&db, 0x8CFE_F100), Some("CCVS_ENGINE"));
        assert_eq!(j1939_name(&db, 0x8CFE_F121), Some("CCVS_ENGINE"));

        // PDU1: TSC1 to the engine (0x00) and the retarder (0x01) from 0x03, and to the engine
        // from 0x27.
        let db = j1939_messages(&[
            (0x8C00_0027, "TSC1_27_TO_ENGINE"),
            (0x8C00_0003, "TSC1_TO_ENGINE"),
            (0x8C00_0103, "TSC1_TO_RETARDER"),
        ]);
        assert_eq!(j1939_name(&db, 0x9800_0103), Some("TSC1_TO_RETARDER"));
        assert_eq!(j1939_name(&db, 0x9800_0003), Some("TSC1_TO_ENGINE"));
        assert_eq!(j1939_name(&db, 0x8C00_0F03), Some("TSC1_TO_ENGINE"));
        assert_eq!(j1939_name(&db, 0x8C00_0199), Some("TSC1_27_TO_ENGINE"));
    }

    pub(crate) const EXTENDED_MUX_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 400 NESTED: 8 ECU
 SG_ Mux1 M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Mux2 m1M : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ A m0 : 16|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ B m3 : 16|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ C m3 : 24|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Plain : 32|8@1+ (1,0) [0|255] "" Vector__XXX

SG_MUL_VAL_ 400 Mux2 Mux1 1-1;
SG_MUL_VAL_ 400 A Mux1 0-0, 2-2;
SG_MUL_VAL_ 400 B Mux2 3-3;
SG_MUL_VAL_ 400 C Mux2 3-5, 16-24;
"#;

    #[test]
    fn extended_multiplexing_follows_the_switch_chain() {
        let db = Database::from_dbc_str(EXTENDED_MUX_DBC).unwrap();
        let nested = db.message(400).unwrap();
        let mux2 = nested.signal("Mux2").unwrap();
        assert_eq!(
            mux2.mux_switch,
            Some(MuxSwitch {
                signal: "Mux1".into(),
                ranges: vec![(1, 1)]
            })
        );
        assert!(mux2.is_multiplexor);
        assert_eq!(mux2.mux_value, Some(1));
        let c = nested.signal("C").unwrap();
        assert_eq!(
            c.mux_switch.as_ref().unwrap().ranges,
            vec![(3, 5), (16, 24)]
        );
        assert_eq!(nested.signal("Plain").unwrap().mux_switch, None);

        let present = |mux1: u8, mux2: u8| -> Vec<&str> {
            let data = [mux1, mux2, 10, 20, 30, 0, 0, 0];
            nested
                .signals
                .iter()
                .filter(|s| nested.decode(s, &data).is_some())
                .map(|s| s.name.as_str())
                .collect()
        };
        assert_eq!(present(0, 3), ["Mux1", "A", "Plain"]);
        assert_eq!(present(2, 3), ["Mux1", "A", "Plain"]);
        assert_eq!(present(1, 3), ["Mux1", "Mux2", "B", "C", "Plain"]);
        assert_eq!(present(1, 4), ["Mux1", "Mux2", "C", "Plain"]);
        assert_eq!(present(1, 20), ["Mux1", "Mux2", "C", "Plain"]);
        assert_eq!(present(1, 6), ["Mux1", "Mux2", "Plain"]);
        // Mux2 reads 3 here, but it isn't switched in, so neither are its signals.
        assert_eq!(present(3, 3), ["Mux1", "Plain"]);
    }

    #[test]
    fn a_switch_naming_itself_or_a_missing_signal_decodes_nothing() {
        let mut db = Database::from_dbc_str(EXTENDED_MUX_DBC).unwrap();
        let nested = &mut db.messages[0];
        nested.signals[3].mux_switch = Some(MuxSwitch {
            signal: "B".into(),
            ranges: vec![(0, 255)],
        });
        nested.signals[4].mux_switch = Some(MuxSwitch {
            signal: "Nope".into(),
            ranges: vec![(0, 255)],
        });
        let nested = &db.messages[0];
        let data = [1, 3, 10, 20, 30, 0, 0, 0];
        assert_eq!(nested.decode(nested.signal("B").unwrap(), &data), None);
        assert_eq!(nested.decode(nested.signal("C").unwrap(), &data), None);
        assert_eq!(
            nested.decode(nested.signal("Mux2").unwrap(), &data),
            Some(3.0)
        );
    }

    #[test]
    fn mux_switch_serialises_in_camel_case_and_defaults_to_none() {
        use serde_json::{json, Value};

        let db = Database::from_dbc_str(EXTENDED_MUX_DBC).unwrap();
        let json = serde_json::to_value(&db).unwrap();
        let signals = &json["messages"][0]["signals"];
        assert_eq!(
            signals[4]["muxSwitch"],
            json!({ "signal": "Mux2", "ranges": [[3, 5], [16, 24]] })
        );
        assert_eq!(signals[5]["muxSwitch"], Value::Null);
        assert_eq!(serde_json::from_value::<Database>(json).unwrap(), db);
    }

    #[test]
    fn falls_back_to_cp1252() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFabc"), "abc");
        assert_eq!(decode_text(b"\x80 \xB0C"), "\u{20AC} \u{B0}C");
    }
}
