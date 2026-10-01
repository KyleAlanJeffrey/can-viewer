//! Frame types and the columnar in-memory frame store shared by the web and desktop builds.

mod store;

pub use store::{frame_bits, id_key, FrameStore, IdKey, IdStats};

/// Largest payload of any supported frame type (CAN FD).
pub const MAX_PAYLOAD: usize = 64;

/// Bit 31 of an ID marks a 29-bit extended identifier, matching the DBC `BO_` convention.
pub const EXT_FLAG: u32 = 1 << 31;

/// Per-frame flag bits.
pub mod flags {
    pub const FD: u8 = 1 << 0;
    pub const BRS: u8 = 1 << 1;
    pub const ESI: u8 = 1 << 2;
    pub const RTR: u8 = 1 << 3;
    pub const ERROR: u8 = 1 << 4;
    pub const TX: u8 = 1 << 5;
}

/// One frame as produced by a parser or read back from the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameRef<'a> {
    /// Absolute timestamp in nanoseconds (Unix epoch when the log provides one).
    pub ts_ns: i64,
    pub channel: u8,
    /// Arbitration ID, with [`EXT_FLAG`] set for extended IDs.
    pub id: u32,
    pub flags: u8,
    pub data: &'a [u8],
}

/// Receives frames from a log parser.
pub trait FrameSink {
    /// Map an interface name from the log (e.g. `can0`) to a channel index.
    fn channel_index(&mut self, name: &[u8]) -> u8;
    fn push(&mut self, frame: FrameRef<'_>);
}
