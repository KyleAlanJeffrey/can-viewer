//! Which parser a file needs: its extension suggests one, and its first bytes confirm or
//! correct that, so a log with the wrong extension still opens.

use crate::text::starts_with_ignore_case;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Candump,
    Asc,
    Trc,
    Csv,
    Blf,
    Mf4,
}

impl Format {
    /// The name reported to the UI in `LogInfo.format`.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Format::Candump => "candump",
            Format::Asc => "asc",
            Format::Trc => "trc",
            Format::Csv => "csv",
            Format::Blf => "blf",
            Format::Mf4 => "mf4",
        }
    }

    /// The format a file name's extension suggests, if it is one we know.
    #[must_use]
    pub fn from_file_name(name: &str) -> Option<Self> {
        let (_, extension) = name.rsplit_once('.')?;
        match extension.to_ascii_lowercase().as_str() {
            "log" | "txt" | "candump" => Some(Format::Candump),
            "asc" => Some(Format::Asc),
            "trc" => Some(Format::Trc),
            "csv" => Some(Format::Csv),
            "blf" => Some(Format::Blf),
            "mf4" | "mdf" => Some(Format::Mf4),
            _ => None,
        }
    }

    /// The format the first bytes of a file identify, if they identify one. Content that
    /// could be more than one format (a `;` line without a TRC marker, a `date` line that
    /// does not parse) identifies none, so that the extension decides.
    #[must_use]
    pub fn sniff(head: &[u8]) -> Option<Self> {
        if head.starts_with(b"LOGG") {
            return Some(Format::Blf);
        }
        if head.starts_with(b"MDF     ") || head.starts_with(b"UnFinMF ") {
            return Some(Format::Mf4);
        }
        let first = first_line(head)?;
        if first.starts_with(b"(") {
            return Some(Format::Candump);
        }
        if first_header_line(head).is_some_and(crate::csv::is_header) {
            return Some(Format::Csv);
        }
        if [&b";$"[..], b";#", b";-"]
            .iter()
            .any(|marker| first.starts_with(marker))
        {
            return Some(Format::Trc);
        }
        let asc_header = [&b"base hex"[..], b"base dec", b"begin triggerblock"];
        if asc_header
            .iter()
            .any(|prefix| starts_with_ignore_case(first, prefix))
            || crate::asc::is_date_line(first)
        {
            return Some(Format::Asc);
        }
        None
    }

    /// The format to parse a file with: what its content shows, else what its extension
    /// suggests, else candump.
    #[must_use]
    pub fn detect(name: &str, head: &[u8]) -> Self {
        Self::sniff(head)
            .or_else(|| Self::from_file_name(name))
            .unwrap_or(Format::Candump)
    }
}

/// The non-blank lines of `head`, trimmed, after any UTF-8 byte order mark.
fn lines(head: &[u8]) -> impl Iterator<Item = &[u8]> {
    let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    head.split(|&b| b == b'\n')
        .map(<[u8]>::trim_ascii)
        .filter(|line| !line.is_empty())
}

fn first_line(head: &[u8]) -> Option<&[u8]> {
    lines(head).next()
}

/// The first line that is not a `#` comment or `sep=` line, where a CSV header would be.
fn first_header_line(head: &[u8]) -> Option<&[u8]> {
    lines(head).find(|line| !crate::csv::is_preamble(line))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_case_insensitive_and_optional() {
        assert_eq!(Format::from_file_name("drive.LOG"), Some(Format::Candump));
        assert_eq!(Format::from_file_name("drive.txt"), Some(Format::Candump));
        assert_eq!(
            Format::from_file_name("drive.candump"),
            Some(Format::Candump)
        );
        assert_eq!(Format::from_file_name("drive.Asc"), Some(Format::Asc));
        assert_eq!(Format::from_file_name("drive.bin"), None);
        assert_eq!(Format::from_file_name("drive"), None);
        assert_eq!(Format::from_file_name(""), None);
    }

    #[test]
    fn content_wins_over_extension_and_candump_is_the_fallback() {
        let candump = b"\xEF\xBB\xBF\r\n\n(1.0) can0 123#00\n";
        assert_eq!(Format::sniff(candump), Some(Format::Candump));
        assert_eq!(Format::sniff(b""), None);
        assert_eq!(Format::sniff(b"\n\n"), None);
        assert_eq!(Format::sniff(b"hello"), None);
        assert_eq!(
            Format::sniff(b"date Tue Sep 30 00:00:00.000 2025\n"),
            Some(Format::Asc)
        );
        assert_eq!(
            Format::sniff(b"Base Hex  timestamps absolute\n"),
            Some(Format::Asc)
        );
        assert_eq!(Format::sniff(b"0.000 1 123 Rx d 0\n"), None);
        assert_eq!(Format::sniff(b";$FILEVERSION=2.1\n"), Some(Format::Trc));
        assert_eq!(Format::sniff(b"\n;####\n"), Some(Format::Trc));
        assert_eq!(Format::from_file_name("x.TRC"), Some(Format::Trc));
        assert_eq!(Format::from_file_name("x.csv"), Some(Format::Csv));
        assert_eq!(
            Format::sniff(b"Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8\n"),
            Some(Format::Csv)
        );
        assert_eq!(Format::sniff(b"a,b,c\n1,2,3\n"), None);
        assert_eq!(Format::sniff(b"LOGG\x90\0\0\0"), Some(Format::Blf));
        assert_eq!(Format::from_file_name("x.BLF"), Some(Format::Blf));
        assert_eq!(Format::from_file_name("x.mf4"), Some(Format::Mf4));
        assert_eq!(Format::sniff(b"MDF     4.10    "), Some(Format::Mf4));
        assert_eq!(Format::sniff(b"UnFinMF 4.10    "), Some(Format::Mf4));
        assert_eq!(Format::detect("drive.bin", candump), Format::Candump);
        assert_eq!(
            Format::detect("drive.log", b"date Tue Sep 30 00:00:00.000 2025\n"),
            Format::Asc
        );
        assert_eq!(
            Format::detect("drive.asc", b"0.000 1 123 Rx d 0\n"),
            Format::Asc
        );
        assert_eq!(Format::detect("drive.bin", b"hello"), Format::Candump);
        assert_eq!(Format::detect("", b""), Format::Candump);
    }

    #[test]
    fn csv_headers_are_not_mistaken_for_trc_or_asc() {
        let pandas = b";time;id;data\n0;0.5;123;0011\n";
        assert_eq!(Format::sniff(pandas), Some(Format::Csv));
        assert_eq!(Format::detect("x.log", pandas), Format::Csv);
        let dated = b"Date Time,Timestamp,ID,Data\n2025-09-30 00:00,0.5,123,00\n";
        assert_eq!(Format::sniff(dated), Some(Format::Csv));
        let commented = b"# exported by a logger\n# bus: can0\ntime,id,data\n1,2,00\n";
        assert_eq!(Format::sniff(commented), Some(Format::Csv));
        let excel = b"sep=,\r\ntime,id,data\r\n1,2,00\r\n";
        assert_eq!(Format::sniff(excel), Some(Format::Csv));
    }

    #[test]
    fn the_extension_decides_when_the_content_is_ambiguous() {
        let comment = b";a comment\n";
        assert_eq!(Format::sniff(comment), None);
        assert_eq!(Format::detect("x.trc", comment), Format::Trc);
        assert_eq!(Format::detect("x.log", comment), Format::Candump);
        let odd_date = b"date 2025-09-30 00:00:00\n0.1 1 123 Rx d 0\n";
        assert_eq!(Format::sniff(odd_date), None);
        assert_eq!(Format::detect("x.asc", odd_date), Format::Asc);
        let headerless = b"0.000 1 123 Rx d 0\n";
        assert_eq!(Format::detect("x.asc", headerless), Format::Asc);
        assert_eq!(Format::detect("x.csv", b"a,b\n"), Format::Csv);
    }
}
