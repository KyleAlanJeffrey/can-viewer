//! DBC text output for [`Database`].

use std::fmt::{self, Write};

use crate::j1939::EXTENDED;
use crate::{ByteOrder, Database, MessageDef, SignalDef, ValueKind};

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

        for message in &self.messages {
            write_message(out, message)?;
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
        self.write_frame_formats(out)?;
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
        Ok(())
    }

    /// `VFrameFormat` as Vector writes it, which marks J1939 messages. Only written when there
    /// are some, so other files keep no attributes.
    fn write_frame_formats(&self, out: &mut String) -> fmt::Result {
        if !self.messages.iter().any(|m| m.j1939) {
            return Ok(());
        }
        writeln!(
            out,
            "BA_DEF_ BO_ \"VFrameFormat\" ENUM \"StandardCAN\",\"ExtendedCAN\",\"reserved\",\"J1939PG\";"
        )?;
        writeln!(out, "BA_DEF_DEF_ \"VFrameFormat\" \"StandardCAN\";")?;
        for message in &self.messages {
            let format = match (message.j1939, message.id & EXTENDED != 0) {
                (true, _) => 3,
                (false, true) => 1,
                (false, false) => continue,
            };
            writeln!(out, "BA_ \"VFrameFormat\" BO_ {} {format};", message.id)?;
        }
        Ok(())
    }

    /// Every transmitter and receiver, once each, in order of first mention.
    fn nodes(&self) -> impl Iterator<Item = &str> {
        let mut nodes: Vec<&str> = Vec::new();
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
    let mux = match (s.is_multiplexor, s.mux_value) {
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
        assert!(text.contains("\nBU_: GW DASH ECU\n"), "{text}");
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
        assert_eq!(again, db);
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
