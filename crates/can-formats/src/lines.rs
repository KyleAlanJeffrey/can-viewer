//! Splits chunked input into lines for the text formats, carrying a partial line from one
//! chunk to the next.

use crate::ParseStats;

/// Longest line accepted, well above the ~200 bytes of a CAN FD line. Longer lines (a binary
/// file dropped by mistake, say) are rejected without being buffered.
pub(crate) const MAX_LINE: usize = 4096;
pub(crate) const LINE_TOO_LONG: &str = "line too long";

#[derive(Debug, Default)]
pub(crate) struct LineSplitter {
    /// The start of a line continued in the next chunk.
    carry: Vec<u8>,
    /// The carried line grew past [`MAX_LINE`] and was rejected, so the rest of it is skipped.
    skipping_line: bool,
    /// The input starts at a line other than the file's first, so has no byte order mark.
    mid_file: bool,
}

impl LineSplitter {
    /// A splitter for input that starts at a line other than the first of the file.
    pub(crate) fn mid_file() -> Self {
        Self {
            mid_file: true,
            ..Self::default()
        }
    }

    /// Counts `chunk` and every line it completes in `stats`, rejects over-long lines, and
    /// calls `on_line` with each remaining line, trimmed, if it is not blank.
    pub(crate) fn push(
        &mut self,
        chunk: &[u8],
        stats: &mut ParseStats,
        mut on_line: impl FnMut(&[u8], &mut ParseStats),
    ) {
        stats.bytes += chunk.len() as u64;
        let bom = !self.mid_file;
        let mut rest = chunk;
        if self.mid_line() {
            let nl = memchr::memchr(b'\n', rest);
            self.carry_over(&rest[..nl.unwrap_or(rest.len())], stats);
            let Some(nl) = nl else {
                return;
            };
            self.end_carried_line(stats, &mut on_line);
            rest = &rest[nl + 1..];
        }
        let complete = memchr::memrchr(b'\n', rest).map_or(0, |i| i + 1);
        let (body, tail) = rest.split_at(complete);
        let mut start = 0;
        for nl in memchr::memchr_iter(b'\n', body) {
            line(&body[start..nl], bom, stats, &mut on_line);
            start = nl + 1;
        }
        self.carry_over(tail, stats);
    }

    /// Delivers the last line of the file if it has no newline.
    pub(crate) fn finish(
        &mut self,
        stats: &mut ParseStats,
        mut on_line: impl FnMut(&[u8], &mut ParseStats),
    ) {
        if self.mid_line() {
            self.end_carried_line(stats, &mut on_line);
        }
    }

    /// Whether the input so far ends partway through a line.
    pub(crate) fn mid_line(&self) -> bool {
        !self.carry.is_empty() || self.skipping_line
    }

    #[cfg(test)]
    pub(crate) fn carried(&self) -> usize {
        self.carry.len()
    }

    /// Appends `part` to the carried line, or rejects the line once it is too long.
    fn carry_over(&mut self, part: &[u8], stats: &mut ParseStats) {
        if self.skipping_line {
            return;
        }
        if self.carry.len() + part.len() > MAX_LINE {
            self.carry = Vec::new();
            self.skipping_line = true;
            stats.lines += 1;
            stats.reject(LINE_TOO_LONG);
        } else {
            self.carry.extend_from_slice(part);
        }
    }

    /// Delivers the carried line, which ends at a newline or the end of the file.
    fn end_carried_line(
        &mut self,
        stats: &mut ParseStats,
        on_line: &mut impl FnMut(&[u8], &mut ParseStats),
    ) {
        if std::mem::take(&mut self.skipping_line) {
            return;
        }
        let mut carried = std::mem::take(&mut self.carry);
        line(&carried, !self.mid_file, stats, on_line);
        carried.clear();
        self.carry = carried;
    }
}

/// `bom`: the input starts at the start of the file, where a byte order mark may come first.
fn line(
    line: &[u8],
    bom: bool,
    stats: &mut ParseStats,
    on_line: &mut impl FnMut(&[u8], &mut ParseStats),
) {
    stats.lines += 1;
    if line.len() > MAX_LINE {
        stats.reject(LINE_TOO_LONG);
        return;
    }
    let line = if bom && stats.lines == 1 {
        line.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(line)
    } else {
        line
    };
    let line = line.trim_ascii();
    if !line.is_empty() {
        on_line(line, stats);
    }
}
