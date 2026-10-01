//! Which parser a file needs: its extension suggests one, and its first bytes confirm or
//! correct that, so a log with the wrong extension still opens.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Candump,
}

impl Format {
    /// The name reported to the UI in `LogInfo.format`.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Format::Candump => "candump",
        }
    }

    /// The format a file name's extension suggests, if it is one we know.
    #[must_use]
    pub fn from_file_name(name: &str) -> Option<Self> {
        let (_, extension) = name.rsplit_once('.')?;
        match extension.to_ascii_lowercase().as_str() {
            "log" | "txt" | "candump" => Some(Format::Candump),
            _ => None,
        }
    }

    /// The format the first bytes of a file identify, if they identify one.
    #[must_use]
    pub fn sniff(head: &[u8]) -> Option<Self> {
        let first = first_line(head)?;
        if first.starts_with(b"(") {
            return Some(Format::Candump);
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

/// The first non-blank line of `head`, trimmed, after any UTF-8 byte order mark.
fn first_line(head: &[u8]) -> Option<&[u8]> {
    let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    head.split(|&b| b == b'\n')
        .map(|line| line.trim_ascii())
        .find(|line| !line.is_empty())
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
        assert_eq!(Format::detect("drive.bin", candump), Format::Candump);
        assert_eq!(Format::detect("drive.bin", b"hello"), Format::Candump);
        assert_eq!(Format::detect("", b""), Format::Candump);
    }
}
