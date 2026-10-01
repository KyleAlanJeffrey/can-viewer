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
    /// Only present when the message's multiplexor has this raw value.
    pub mux_value: Option<u64>,
    pub value_table: Vec<(i64, String)>,
    pub comment: Option<String>,
    /// Receiving nodes. Not in the UI's `SignalDef` yet, so absent means none.
    #[serde(default)]
    pub receivers: Vec<String>,
}

impl SignalDef {
    #[must_use]
    pub fn raw(&self, data: &[u8]) -> Option<u64> {
        bits::extract(data, self.start_bit, self.size, self.byte_order)
    }

    /// Physical value, ignoring multiplexing (see [`MessageDef::decode`]).
    #[must_use]
    pub fn value(&self, data: &[u8]) -> Option<f64> {
        let raw = self.raw(data)?;
        let v = match self.kind {
            ValueKind::Unsigned => raw as f64,
            ValueKind::Signed => bits::sign_extend(raw, self.size) as f64,
            ValueKind::Float32 => f64::from(f32::from_bits(raw as u32)),
            ValueKind::Float64 => f64::from_bits(raw),
        };
        Some(v * self.factor + self.offset)
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

    /// Whether `physical` is within min..max, give or take half a step for rounding in the DBC.
    /// An empty range, often written [0|0], means none was given.
    #[must_use]
    pub fn in_range(&self, physical: f64) -> bool {
        if self.min >= self.max {
            return true;
        }
        let slack = self.factor.abs() / 2.0;
        (self.min - slack..=self.max + slack).contains(&physical)
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
    /// A J1939 parameter group (DBC `VFrameFormat` J1939PG). It decodes frames by PGN, and its
    /// values outside min..max mean error or not available.
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
    /// multiplexed out of this frame, or this is J1939 and the value is out of range.
    ///
    /// Extended multiplexing (`SG_MUL_VAL_`) is not handled yet: every multiplexed signal is
    /// assumed to be switched by the message's single multiplexor.
    #[must_use]
    pub fn decode(&self, signal: &SignalDef, data: &[u8]) -> Option<f64> {
        if let Some(want) = signal.mux_value {
            if self.multiplexor()?.raw(data)? != want {
                return None;
            }
        }
        let value = signal.value(data)?;
        (!self.j1939 || signal.in_range(value)).then_some(value)
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

    /// The J1939 message whose PGN a frame with ID `id` carries; see [`j1939::matches`]. Look
    /// for an exact [`Database::message`] first.
    #[must_use]
    pub fn j1939_message(&self, id: u32) -> Option<&MessageDef> {
        self.messages
            .iter()
            .find(|m| m.j1939 && j1939::matches(m.id, id))
    }
}

/// `VFrameFormat` J1939PG, given for the message or as the default. A file that doesn't define
/// `VFrameFormat` but has `ProtocolType` "J1939" counts its extended messages as J1939.
fn is_j1939(dbc: &can_dbc::Dbc, id: can_dbc::MessageId) -> bool {
    use can_dbc::{AttributeDefinition as D, AttributeValue as V, AttributeValueType as T};

    const FRAME_FORMAT: &str = "VFrameFormat";
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
        return matches!(id, can_dbc::MessageId::Extended(_))
            && matches!(protocol, Some(V::String(p)) if p == "J1939");
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
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž',
        '\u{8F}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}',
        'ž', 'Ÿ',
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
    fn j1939_lookup_and_not_available_values() {
        let db = Database::from_dbc_str(J1939_DBC).unwrap();
        let eec1 = db.j1939_message(0x0CF0_0400 | j1939::EXTENDED).unwrap();
        assert_eq!(eec1.name, "EEC1");
        assert!(
            db.j1939_message(0x98FE_F117).is_none(),
            "RAW_EXT isn't J1939"
        );

        let speed = eec1.signal("EngineSpeed").unwrap();
        let rpm = |raw: u16| {
            let mut data = [0u8; 8];
            data[3..5].copy_from_slice(&raw.to_le_bytes());
            eec1.decode(speed, &data)
        };
        assert_eq!(rpm(8000), Some(1000.0));
        assert_eq!(rpm(0xFAFF), Some(8031.875));
        assert_eq!(rpm(0xFE00), None, "error");
        assert_eq!(rpm(0xFFFF), None, "not available");
        let unspecified = eec1.signal("Unspecified").unwrap();
        assert_eq!(
            eec1.decode(unspecified, &[200, 0, 0, 0, 0, 0, 0, 0]),
            Some(200.0)
        );

        let raw_ext = db.message(0x98FE_F100).unwrap();
        assert_eq!(raw_ext.decode(&raw_ext.signals[0], &[200; 8]), Some(200.0));
    }

    #[test]
    fn falls_back_to_cp1252() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFabc"), "abc");
        assert_eq!(decode_text(b"\x80 \xB0C"), "\u{20AC} \u{B0}C");
    }
}
