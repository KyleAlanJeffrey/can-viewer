//! DBC text output for [`Database`].

use std::fmt::{self, Write};

use crate::j1939::EXTENDED;
use crate::{
    AttributeDefinition, AttributeObject, AttributeType, AttributeValue, ByteOrder, Database,
    MessageDef, SignalDef, ValueKind,
};

/// The `NS_` list as Vector CANdb++ writes it. Some tools refuse files without it.
const NEW_SYMBOLS: [&str; 28] = [
    "NS_DESC_",
    "CM_",
    "BA_DEF_",
    "BA_",
    "VAL_",
    "CAT_DEF_",
    "CAT_",
    "FILTER",
    "BA_DEF_DEF_",
    "EV_DATA_",
    "ENVVAR_DATA_",
    "SGTYPE_",
    "SGTYPE_VAL_",
    "BA_DEF_SGTYPE_",
    "BA_SGTYPE_",
    "SIG_TYPE_REF_",
    "VAL_TABLE_",
    "SIG_GROUP_",
    "SIG_VALTYPE_",
    "SIGTYPE_VALTYPE_",
    "BO_TX_BU_",
    "BA_DEF_REL_",
    "BA_REL_",
    "BA_DEF_DEF_REL_",
    "BU_SG_REL_",
    "BU_EV_REL_",
    "BU_BO_REL_",
    "SG_MUL_VAL_",
];

/// Placeholder DBC uses for "no node".
const NO_NODE: &str = "Vector__XXX";

/// The `VFrameFormat` enum as Vector CANdb++ defines it; the model's `j1939` and `fd` flags
/// map to indexes 3, 14 and 15.
const FRAME_FORMATS: &str = "\"StandardCAN\",\"ExtendedCAN\",\"reserved\",\"J1939PG\",\
    \"reserved\",\"reserved\",\"reserved\",\"reserved\",\"reserved\",\"reserved\",\"reserved\",\
    \"reserved\",\"reserved\",\"reserved\",\"StandardCAN_FD\",\"ExtendedCAN_FD\"";

impl Database {
    /// Serialise as DBC text, which [`Database::from_dbc_str`] reads back as an equal database.
    /// Numbers are written in Rust's shortest round-trip form.
    #[must_use]
    pub fn to_dbc(&self) -> String {
        let mut out = String::new();
        self.write_dbc(&mut out)
            .expect("writing to a String cannot fail");
        out
    }

    fn write_dbc(&self, out: &mut String) -> fmt::Result {
        writeln!(out, "VERSION \"\"\n\n")?;
        writeln!(out, "NS_ :")?;
        for symbol in NEW_SYMBOLS {
            writeln!(out, "\t{symbol}")?;
        }
        writeln!(out, "\nBS_:\n")?;
        writeln!(
            out,
            "BU_:{}\n",
            self.nodes().map(|n| format!(" {n}")).collect::<String>()
        )?;
        for table in &self.value_tables {
            write!(out, "VAL_TABLE_ {}", table.name)?;
            for (value, description) in &table.entries {
                write!(out, " {value} {}", Quoted(description))?;
            }
            writeln!(out, " ;")?;
        }
        if !self.value_tables.is_empty() {
            writeln!(out)?;
        }

        for message in &self.messages {
            write_message(out, message)?;
        }

        for node in &self.nodes {
            if let Some(comment) = &node.comment {
                writeln!(out, "CM_ BU_ {} {};", node.name, Quoted(comment))?;
            }
        }
        for message in &self.messages {
            if let Some(comment) = &message.comment {
                writeln!(out, "CM_ BO_ {} {};", message.id, Quoted(comment))?;
            }
            for signal in &message.signals {
                if let Some(comment) = &signal.comment {
                    writeln!(
                        out,
                        "CM_ SG_ {} {} {};",
                        message.id,
                        signal.name,
                        Quoted(comment)
                    )?;
                }
            }
        }
        self.write_attributes(out)?;
        for message in &self.messages {
            for signal in message.signals.iter().filter(|s| !s.value_table.is_empty()) {
                write!(out, "VAL_ {} {}", message.id, signal.name)?;
                for (value, description) in &signal.value_table {
                    write!(out, " {value} {}", Quoted(description))?;
                }
                writeln!(out, " ;")?;
            }
        }
        for message in &self.messages {
            for signal in &message.signals {
                let value_type = match signal.kind {
                    ValueKind::Float32 => 1,
                    ValueKind::Float64 => 2,
                    ValueKind::Unsigned | ValueKind::Signed => continue,
                };
                writeln!(
                    out,
                    "SIG_VALTYPE_ {} {} : {value_type};",
                    message.id, signal.name
                )?;
            }
        }
        for message in &self.messages {
            for signal in &message.signals {
                let Some(switch) = &signal.mux_switch else {
                    continue;
                };
                let ranges: Vec<String> = switch
                    .ranges
                    .iter()
                    .map(|(lo, hi)| format!("{lo}-{hi}"))
                    .collect();
                writeln!(
                    out,
                    "SG_MUL_VAL_ {} {} {} {};",
                    message.id,
                    signal.name,
                    switch.signal,
                    ranges.join(", ")
                )?;
            }
        }
        Ok(())
    }

    /// Attribute definitions, defaults and values, in that order as DBC wants them. The
    /// `VFrameFormat` attribute is derived from the `j1939` and `fd` flags, and only written
    /// when some message has one, so other files keep no frame formats.
    fn write_attributes(&self, out: &mut String) -> fmt::Result {
        let frame_formats = self.messages.iter().any(|m| m.j1939 || m.fd);
        for definition in &self.attribute_definitions {
            write_attribute_definition(out, definition)?;
        }
        if frame_formats {
            writeln!(out, "BA_DEF_ BO_ \"VFrameFormat\" ENUM {FRAME_FORMATS};")?;
        }
        for definition in &self.attribute_definitions {
            if let Some(default) = &definition.default {
                writeln!(out, "BA_DEF_DEF_ {} {default};", Quoted(&definition.name))?;
            }
        }
        if frame_formats {
            writeln!(out, "BA_DEF_DEF_ \"VFrameFormat\" \"StandardCAN\";")?;
        }
        for attribute in &self.attributes {
            writeln!(out, "BA_ {} {};", Quoted(&attribute.name), attribute.value)?;
        }
        for node in &self.nodes {
            for attribute in &node.attributes {
                writeln!(
                    out,
                    "BA_ {} BU_ {} {};",
                    Quoted(&attribute.name),
                    node.name,
                    attribute.value
                )?;
            }
        }
        for message in &self.messages {
            for attribute in &message.attributes {
                writeln!(
                    out,
                    "BA_ {} BO_ {} {};",
                    Quoted(&attribute.name),
                    message.id,
                    attribute.value
                )?;
            }
            let extended = message.id & EXTENDED != 0;
            let format = match (message.j1939, message.fd, extended) {
                (true, _, _) => Some(3),
                (false, true, false) => Some(14),
                (false, true, true) => Some(15),
                (false, false, true) => Some(1),
                (false, false, false) => None,
            };
            if let (true, Some(format)) = (frame_formats, format) {
                writeln!(out, "BA_ \"VFrameFormat\" BO_ {} {format};", message.id)?;
            }
            for signal in &message.signals {
                for attribute in &signal.attributes {
                    writeln!(
                        out,
                        "BA_ {} SG_ {} {} {};",
                        Quoted(&attribute.name),
                        message.id,
                        signal.name,
                        attribute.value
                    )?;
                }
            }
        }
        Ok(())
    }

    /// The declared nodes, then every other transmitter and receiver once each, in order of
    /// first mention.
    fn nodes(&self) -> impl Iterator<Item = &str> {
        let mut nodes: Vec<&str> = self.nodes.iter().map(|n| n.name.as_str()).collect();
        for message in &self.messages {
            let receivers = message.signals.iter().flat_map(|s| &s.receivers);
            for node in message.transmitter.iter().chain(receivers) {
                if !nodes.contains(&node.as_str()) {
                    nodes.push(node);
                }
            }
        }
        nodes.into_iter()
    }
}

fn write_attribute_definition(out: &mut String, definition: &AttributeDefinition) -> fmt::Result {
    let object = match definition.object {
        AttributeObject::Network => "",
        AttributeObject::Node => "BU_ ",
        AttributeObject::Message => "BO_ ",
        AttributeObject::Signal => "SG_ ",
        AttributeObject::EnvVar => "EV_ ",
    };
    write!(out, "BA_DEF_ {object}{} ", Quoted(&definition.name))?;
    match &definition.kind {
        AttributeType::Int { min, max } => write!(out, "INT {min} {max}")?,
        AttributeType::Hex { min, max } => write!(out, "HEX {min} {max}")?,
        AttributeType::Float { min, max } => write!(out, "FLOAT {min} {max}")?,
        AttributeType::String => write!(out, "STRING")?,
        AttributeType::Enum { choices } => {
            let choices: Vec<String> = choices.iter().map(|c| Quoted(c).to_string()).collect();
            write!(out, "ENUM {}", choices.join(","))?;
        }
    }
    writeln!(out, ";")
}

impl fmt::Display for AttributeValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttributeValue::Number(n) => write!(f, "{n}"),
            AttributeValue::Text(s) => Quoted(s).fmt(f),
        }
    }
}

fn write_message(out: &mut String, message: &MessageDef) -> fmt::Result {
    let transmitter = message.transmitter.as_deref().unwrap_or(NO_NODE);
    writeln!(
        out,
        "BO_ {} {}: {} {transmitter}",
        message.id, message.name, message.size
    )?;
    for signal in &message.signals {
        write_signal(out, signal)?;
    }
    writeln!(out)
}

fn write_signal(out: &mut String, s: &SignalDef) -> fmt::Result {
    // DBC wants an `m` indicator on every multiplexed signal, so a signal switched only by
    // `SG_MUL_VAL_` borrows the start of its first range.
    let mux_value = s.mux_value.or_else(|| {
        s.mux_switch
            .as_ref()
            .and_then(|switch| switch.ranges.first().map(|&(lo, _)| lo))
    });
    let mux = match (s.is_multiplexor, mux_value) {
        (false, None) => String::new(),
        (true, None) => " M".into(),
        (false, Some(v)) => format!(" m{v}"),
        (true, Some(v)) => format!(" m{v}M"),
    };
    let order = match s.byte_order {
        ByteOrder::Intel => '1',
        ByteOrder::Motorola => '0',
    };
    // Floats are flagged by SIG_VALTYPE_; Vector writes them as signed.
    let sign = if s.kind == ValueKind::Unsigned {
        '+'
    } else {
        '-'
    };
    let receivers = if s.receivers.is_empty() {
        NO_NODE.to_owned()
    } else {
        s.receivers.join(",")
    };
    writeln!(
        out,
        " SG_ {}{mux} : {}|{}@{order}{sign} ({},{}) [{}|{}] {} {receivers}",
        s.name,
        s.start_bit,
        s.size,
        s.factor,
        s.offset,
        s.min,
        s.max,
        Quoted(&s.unit),
    )
}

/// A DBC string literal. `can-dbc` keeps `\"` escapes verbatim when reading, so text loaded
/// from a DBC already holds them; only bare quotes need escaping.
struct Quoted<'a>(&'a str);

impl fmt::Display for Quoted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_char('"')?;
        let mut prev = '\0';
        for c in self.0.chars() {
            if c == '"' && prev != '\\' {
                f.write_char('\\')?;
            }
            f.write_char(c)?;
            prev = c;
        }
        // can-dbc would read a final `\` and the closing quote as an escaped quote.
        if prev == '\\' {
            f.write_char(' ')?;
        }
        f.write_char('"')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO_DBC: &str = include_str!("../../sample-gen/src/demo.dbc");

    fn round_trip(text: &str) -> (Database, String) {
        let db = Database::from_dbc_str(text).unwrap();
        let written = db.to_dbc();
        let again = Database::from_dbc_str(&written)
            .unwrap_or_else(|e| panic!("{e}\n--- written DBC ---\n{written}"));
        assert_eq!(again, db, "--- written DBC ---\n{written}");
        (db, written)
    }

    #[test]
    fn demo_dbc_round_trips() {
        let (db, text) = round_trip(DEMO_DBC);
        assert_eq!(db.messages.len(), 9);
        assert!(text.starts_with("VERSION \"\"\n\n\nNS_ :\n\tNS_DESC_\n"));
        assert!(text.contains("\nBS_:\n"));
        assert!(text.contains("\nBU_: ECM ABS EPS BCM IMU BMS RADAR\n"));
        assert!(text.contains(
            "BO_ 1712 BATTERY: 8 BMS\n SG_ Page M : 0|8@1+ (1,0) [0|255] \"\" Vector__XXX\n \
             SG_ Cell1 m0 : 8|16@1+ (0.001,0) [0|65.535] \"V\" Vector__XXX\n"
        ));
        assert!(text.contains(
            " SG_ SteeringAngle : 7|16@0- (0.1,0) [-3276.8|3276.7] \"deg\" Vector__XXX\n"
        ));
        assert!(text.contains("BO_ 2566844672 CCVS: 8 ECM\n"));
        assert!(text.contains("CM_ BO_ 201 \"Engine status, 100 Hz\";\n"));
        assert!(text.contains("CM_ SG_ 201 Checksum \"Sum of bytes 0-6, modulo 256\";\n"));
        assert!(
            text.contains("BA_ \"VFrameFormat\" BO_ 768 14;\n"),
            "{text}"
        );
        assert!(text.contains("BA_ \"VFrameFormat\" BO_ 2566844672 3;\n"));
        assert!(text.contains("VAL_ 1001 Gear 0 \"P\" 1 \"R\" 2 \"N\" 3 \"D\" ;\n"));
        assert!(text.contains("SIG_VALTYPE_ 1440 YawRate : 1;\n"));
    }

    #[test]
    fn test_dbc_round_trips() {
        let (_, text) = round_trip(crate::tests::DBC);
        assert!(!text.contains("VFrameFormat"));
    }

    #[test]
    fn j1939_frame_format_round_trips() {
        let (db, text) = round_trip(crate::tests::J1939_DBC);
        assert!(db.messages[0].j1939);
        assert!(
            text.contains("BA_ \"VFrameFormat\" BO_ 2364540158 3;\n"),
            "{text}"
        );
        assert!(text.contains("BA_ \"VFrameFormat\" BO_ 2566844672 1;\n"));
    }

    #[test]
    fn writes_receivers_nested_multiplexors_and_edited_text() {
        let mut db = Database::from_dbc_str(crate::tests::DBC).unwrap();
        let message = &mut db.messages[0];
        message.transmitter = None;
        message.comment = Some("Says \"hi\"\non two lines".into());
        let rpm = &mut message.signals[0];
        rpm.receivers = vec!["GW".into(), "DASH".into()];
        rpm.factor = 1e-7;
        rpm.max = 1e21;
        let torque = &mut message.signals[2];
        torque.is_multiplexor = true;
        torque.mux_value = Some(3);
        torque.kind = ValueKind::Float64;
        torque.size = 64;

        let text = db.to_dbc();
        assert!(text.contains("\nBU_: ECU GW DASH\n"), "{text}");
        assert!(text.contains("BO_ 100 ENGINE: 8 Vector__XXX\n"));
        assert!(text.contains(
            " SG_ RPM : 0|16@1+ (0.0000001,0) [0|1000000000000000000000] \"rpm\" GW,DASH\n"
        ));
        assert!(text.contains(" SG_ Torque m3M : 31|64@0- "));
        assert!(text.contains("SIG_VALTYPE_ 100 Torque : 2;\n"));

        let again = Database::from_dbc_str(&text).unwrap();
        // DBC has no unescaped form of a quote, so it reads back escaped.
        assert_eq!(
            again.messages[0].comment.as_deref(),
            Some("Says \\\"hi\\\"\non two lines")
        );
        db.messages[0]
            .comment
            .clone_from(&again.messages[0].comment);
        // The new receivers were listed in BU_, so they read back as nodes.
        assert_eq!(
            again
                .nodes
                .iter()
                .map(|n| n.name.as_str())
                .collect::<Vec<_>>(),
            ["ECU", "GW", "DASH"]
        );
        db.nodes.clone_from(&again.nodes);
        assert_eq!(again, db);
    }

    #[test]
    fn attributes_value_tables_and_node_comments_round_trip() {
        let (_, text) = round_trip(crate::tests::ATTRIBUTES_DBC);
        assert!(text.contains("\nBU_: ECU GW\n"), "{text}");
        assert!(text.contains(
            "VAL_TABLE_ OnOff 0 \"Off\" 1 \"On\" ;\nVAL_TABLE_ Gears 0 \"P\" 1 \"R\" 2 \"N\" 3 \"D\" ;\n"
        ));
        assert!(text.contains("CM_ BU_ ECU \"Engine control unit\";\nCM_ BU_ GW \"Gateway\";\n"));
        for line in [
            "BA_DEF_ BU_ \"NodeLayerModules\" STRING;\n",
            "BA_DEF_ BO_ \"GenMsgCycleTime\" INT 0 65535;\n",
            "BA_DEF_ BO_ \"GenMsgSendType\" ENUM \"cyclic\",\"spontaneous\",\"cyclicIfActive\";\n",
            "BA_DEF_ SG_ \"GenSigStartValue\" FLOAT -1000000000000000000000000000000 \
             1000000000000000000000000000000;\n",
            "BA_DEF_ SG_ \"SPN\" HEX 0 524287;\n",
            "BA_DEF_ \"BusType\" STRING;\n",
            "BA_DEF_ \"Baudrate\" INT 0 1000000;\n",
            "BA_DEF_ EV_ \"GenEnvVarEndingDis\" STRING;\n",
            "BA_DEF_DEF_ \"NodeLayerModules\" \"\";\n",
            "BA_DEF_DEF_ \"GenMsgCycleTime\" 0;\n",
            "BA_DEF_DEF_ \"GenMsgSendType\" \"cyclic\";\n",
            "BA_DEF_DEF_ \"GenSigStartValue\" 0;\n",
            "BA_DEF_DEF_ \"Baudrate\" 500000;\n",
            "BA_DEF_DEF_ \"VFrameFormat\" \"StandardCAN\";\n",
            "BA_ \"BusType\" \"CAN FD\";\nBA_ \"Baudrate\" 500000;\n",
            "BA_ \"NodeLayerModules\" BU_ ECU \"CANoeILNLVector.dll\";\n",
            "BA_ \"GenMsgCycleTime\" BO_ 100 10;\nBA_ \"GenMsgSendType\" BO_ 100 1;\n",
            "BA_ \"GenSigStartValue\" SG_ 100 RPM 800;\n",
            "BA_ \"VFrameFormat\" BO_ 2566844672 3;\n",
            "BA_ \"SPN\" SG_ 2566844672 Speed 84;\n",
            "BA_ \"GenMsgCycleTime\" BO_ 768 20;\nBA_ \"VFrameFormat\" BO_ 768 14;\n",
            "BA_ \"VFrameFormat\" BO_ 2415919104 15;\n",
        ] {
            assert!(text.contains(line), "missing {line:?} in\n{text}");
        }
        assert_eq!(
            text.matches("VFrameFormat").count(),
            5,
            "one definition, one default and three values:\n{text}"
        );
        assert!(!text.contains("BA_ \"VFrameFormat\" BO_ 100 "), "{text}");
    }

    #[test]
    fn frame_formats_resolve_through_the_files_own_enum() {
        let text = r#"VERSION ""

NS_ :

BS_:

BU_:

BO_ 100 STD: 8 Vector__XXX
BO_ 2147484196 EXT: 8 Vector__XXX
BO_ 2566844672 PG: 8 Vector__XXX
BO_ 300 FD: 64 Vector__XXX

BA_DEF_ BO_ "VFrameFormat" ENUM "ExtendedCAN_FD","J1939PG","StandardCAN_FD","StandardCAN";
BA_DEF_DEF_ "VFrameFormat" 0;
BA_ "VFrameFormat" BO_ 2566844672 1;
BA_ "VFrameFormat" BO_ 300 2;
BA_ "VFrameFormat" BO_ 100 3;
"#;
        let (db, written) = round_trip(text);
        let flags = |id| {
            let m = db.message(id).unwrap();
            (m.j1939, m.fd)
        };
        assert_eq!(flags(100), (false, false));
        assert_eq!(flags(0x224 | EXTENDED), (false, true), "from the default");
        assert_eq!(flags(0x98FE_F100), (true, false));
        assert_eq!(flags(300), (false, true));
        assert!(db.attribute_definitions.is_empty());
        assert!(written.contains("BA_ \"VFrameFormat\" BO_ 2147484196 15;\n"));
        assert!(written.contains("BA_ \"VFrameFormat\" BO_ 2566844672 3;\n"));
        assert!(written.contains("BA_ \"VFrameFormat\" BO_ 300 14;\n"));
        assert!(!written.contains("BO_ 100 3;"), "{written}");
    }

    #[test]
    fn extended_multiplexing_round_trips() {
        let (mut db, text) = round_trip(crate::tests::EXTENDED_MUX_DBC);
        assert!(text.contains(" SG_ Mux2 m1M : 8|8@1+ "), "{text}");
        assert!(
            text.contains(
                "SG_MUL_VAL_ 400 Mux2 Mux1 1-1;\nSG_MUL_VAL_ 400 A Mux1 0-0, 2-2;\n\
                 SG_MUL_VAL_ 400 B Mux2 3-3;\nSG_MUL_VAL_ 400 C Mux2 3-5, 16-24;\n"
            ),
            "{text}"
        );

        // A signal switched only by SG_MUL_VAL_ gets its `m` indicator from its first range.
        db.messages[0].signals[4].mux_value = None;
        let text = db.to_dbc();
        assert!(text.contains(" SG_ C m3 : 24|8@1+ "), "{text}");
        let again = Database::from_dbc_str(&text).unwrap();
        assert_eq!(again.messages[0].signals[4].mux_value, Some(3));
    }

    #[test]
    fn trailing_backslash_keeps_its_closing_quote() {
        let mut db = Database::from_dbc_str(crate::tests::DBC).unwrap();
        db.messages[0].comment = Some(r"Logs in C:\logs\".into());
        let text = db.to_dbc();
        let again = Database::from_dbc_str(&text).unwrap_or_else(|e| panic!("{e}\n{text}"));
        assert_eq!(
            again.messages[0].comment.as_deref(),
            Some(r"Logs in C:\logs\ ")
        );
        assert_eq!(
            again.messages[0].signals[0].comment.as_deref(),
            Some("Engine speed")
        );
    }

    #[test]
    fn empty_database_is_valid_dbc() {
        let text = Database::default().to_dbc();
        assert_eq!(Database::from_dbc_str(&text).unwrap(), Database::default());
    }
}
