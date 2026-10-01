//! Frame types and the columnar in-memory frame store shared by the web and desktop builds.

mod store;
pub mod tp;

pub use store::{frame_bits, id_key, FrameStore, IdKey, IdStats};

/// Largest payload of any frame a log can hold (CAN FD). Frames reassembled from J1939
/// transport protocol packets ([`tp`]) are longer, up to [`tp::MAX_TRANSFER`] bytes.
pub const MAX_PAYLOAD: usize = 64;

/// Bit 31 of an ID marks a 29-bit extended identifier, matching the DBC `BO_` convention.
pub const EXT_FLAG: u32 = 1 << 31;

/// Bit 29 of an ID marks an error frame, whose low bits are the error class, as in SocketCAN's
/// `CAN_ERR_FLAG`. Real 11-bit and 29-bit IDs never set it, so error frames get IDs of their own.
pub const ERR_FLAG: u32 = 1 << 29;

/// Per-frame flag bits.
pub mod flags {
    pub const FD: u8 = 1 << 0;
    pub const BRS: u8 = 1 << 1;
    pub const ESI: u8 = 1 << 2;
    pub const RTR: u8 = 1 << 3;
    pub const ERROR: u8 = 1 << 4;
    pub const TX: u8 = 1 << 5;
    /// Not from the log: one J1939 parameter group reassembled from its transport protocol
    /// packets ([`crate::tp`]), which stay in the log too.
    pub const REASSEMBLED: u8 = 1 << 6;
}

/// One frame as produced by a parser or read back from the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameRef<'a> {
    /// Absolute timestamp in nanoseconds (Unix epoch when the log provides one).
    pub ts_ns: i64,
    pub channel: u8,
    /// Arbitration ID, with [`EXT_FLAG`] set for extended IDs or [`ERR_FLAG`] for error frames.
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
