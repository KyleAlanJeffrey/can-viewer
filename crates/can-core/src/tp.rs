//! SAE J1939-21 transport protocol: reassembly of multi-packet parameter groups.
//!
//! A sender announces a transfer with TP.CM (PGN 0xEC00), as a BAM to every node or an RTS to
//! one, then sends the bytes in TP.DT (PGN 0xEB00) packets of 7, numbered from 1: up to 1785
//! bytes in 255 packets. Transfers are tracked per channel, source and destination address, so
//! interleaved senders don't mix.
//!
//! For an RTS the receiver paces the sender with CTS messages, each naming the next packet to
//! send. A CTS for a packet already sent is a request to send it again, so the transfer rewinds
//! to it; a CTS for no packets holds the connection open. The receiver need not be seen: packets
//! that follow an RTS in order are taken without any CTS.
//!
//! Anything that goes wrong drops the transfer quietly: a packet out of order (for an RTS it is
//! only ignored, since a CTS may ask for it again), a packet shorter than 8 bytes (likewise), a
//! new announcement before the last packet, an abort of its PGN, or a timeout. Between packets
//! the limit is [`T1_NS`]; on a connection it is [`T2_NS`] after a CTS, [`T3_NS`] after the RTS
//! or the last packet of a block, and [`T4_NS`] after a hold. Timeouts use the frames'
//! timestamps and are checked when the transfer's next frame arrives, and transfers left
//! unfinished are swept out now and then.

use rustc_hash::FxHashMap;

use crate::{FrameRef, EXT_FLAG};

/// Largest payload one transfer can carry: 255 packets of 7 bytes.
pub const MAX_TRANSFER: usize = 1785;

/// T1: the longest a receiver waits for the next packet of a BAM or of a CTS block. BAM packets
/// come 50 to 200 ms apart.
pub const T1_NS: i64 = 750_000_000;

/// T2: the longest a receiver waits after a CTS for its first packet.
pub const T2_NS: i64 = 1_250_000_000;

/// T3: the longest a sender waits after an RTS, or after the last packet of a block, for a CTS.
pub const T3_NS: i64 = 1_250_000_000;

/// T4: the longest a sender waits after a CTS that holds the connection.
pub const T4_NS: i64 = 1_050_000_000;

/// PDU formats of the connection management and data transfer groups.
const TP_CM: u32 = 0xEC;
const TP_DT: u32 = 0xEB;

/// TP.CM control bytes. The end-of-message acknowledgement (19) changes nothing here.
const RTS: u8 = 16;
const CTS: u8 = 17;
const BAM: u8 = 32;
const ABORT: u8 = 255;

/// Open transfers at which expired ones are first swept out.
const SWEEP_AT: usize = 256;

/// One completed transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transfer {
    /// The announced PGN as a 29-bit ID with [`EXT_FLAG`], with the TP.CM frame's priority and
    /// source address and, for a PDU1 group, its destination address.
    pub id: u32,
    /// Timestamp of the last packet.
    pub ts_ns: i64,
    pub data: Vec<u8>,
}

#[derive(Debug)]
struct Session {
    id: u32,
    /// As announced, which an abort must name.
    pgn: u32,
    size: usize,
    /// Announced by an RTS rather than a BAM.
    connection: bool,
    next_sequence: u8,
    /// Last packet of the block the latest CTS asked for.
    block_end: Option<u8>,
    data: Vec<u8>,
    /// The transfer is dropped if its next frame comes later than this.
    deadline_ns: i64,
}

/// Open transfers, keyed by channel, source address and destination address.
#[derive(Debug, Default)]
pub struct Reassembler {
    sessions: FxHashMap<(u8, u8, u8), Session>,
    /// Open transfers left by the last sweep. Sweeping again only once the map has doubled keeps
    /// the cost per frame constant however many transfers are live.
    left_after_sweep: usize,
}

impl Reassembler {
    /// Feeds one frame and returns the transfer it completes, if any.
    pub fn push(&mut self, frame: &FrameRef<'_>) -> Option<Transfer> {
        if frame.id & EXT_FLAG == 0 {
            return None;
        }
        let key = (frame.channel, frame.id as u8, (frame.id >> 8) as u8);
        // The PDU format with the data page bits above it, which are 0 for both groups.
        match (frame.id >> 16) & 0x3FF {
            TP_CM => {
                self.control(key, frame);
                None
            }
            TP_DT => self.data(key, frame),
            _ => None,
        }
    }

    fn control(&mut self, key: (u8, u8, u8), frame: &FrameRef<'_>) {
        let Some(&[control, size_lo, size_hi, _, _, pgn_lo, pgn_mid, pgn_hi]) =
            frame.data.first_chunk()
        else {
            return;
        };
        let (channel, source, destination) = key;
        let pgn = u32::from(pgn_lo) | (u32::from(pgn_mid) << 8) | (u32::from(pgn_hi) << 16);
        match control {
            RTS | BAM => {
                let size = usize::from(u16::from_le_bytes([size_lo, size_hi]));
                if size == 0 || size > MAX_TRANSFER {
                    return;
                }
                // PDU1 groups (PDU format below 240) carry the destination in the PDU-specific
                // byte, which is not part of the PGN.
                let pdu_specific = if (pgn >> 8) & 0xFF < 240 {
                    u32::from(destination)
                } else {
                    pgn & 0xFF
                };
                let id = EXT_FLAG
                    | (frame.id & (7 << 26))
                    | ((pgn & 0x3_FF00) << 8)
                    | (pdu_specific << 8)
                    | u32::from(source);
                let connection = control == RTS;
                self.sweep(frame.ts_ns);
                // Replaces any unfinished transfer from the same sender to the same destination.
                self.sessions.insert(
                    key,
                    Session {
                        id,
                        pgn,
                        size,
                        connection,
                        next_sequence: 1,
                        block_end: None,
                        // Grown as packets arrive, so announcements alone hold no memory.
                        data: Vec::new(),
                        deadline_ns: frame.ts_ns + if connection { T3_NS } else { T1_NS },
                    },
                );
            }
            // Bytes 1 and 2: how many packets to send, and the number of the first.
            CTS => self.clear_to_send(
                (channel, destination, source),
                frame.ts_ns,
                size_lo,
                size_hi,
            ),
            ABORT => {
                // Either side may abort, so the addresses may be the other way round; a transfer
                // the other way is left alone unless it carries the aborted PGN.
                for key in [key, (channel, destination, source)] {
                    if self.sessions.get(&key).is_some_and(|s| s.pgn == pgn) {
                        self.sessions.remove(&key);
                    }
                }
            }
            _ => {}
        }
    }

    /// A CTS from the receiver of the transfer `key`, asking for `packets` packets from number
    /// `next` on.
    fn clear_to_send(&mut self, key: (u8, u8, u8), ts_ns: i64, packets: u8, next: u8) {
        let Some(session) = self.sessions.get_mut(&key) else {
            return;
        };
        if !session.connection || ts_ns > session.deadline_ns {
            self.sessions.remove(&key);
            return;
        }
        if packets == 0 {
            session.deadline_ns = ts_ns + T4_NS;
            return;
        }
        // A packet not sent yet would leave a gap.
        if next == 0 || next > session.next_sequence {
            self.sessions.remove(&key);
            return;
        }
        session.next_sequence = next;
        session.block_end = Some(next.saturating_add(packets - 1));
        session.data.truncate(usize::from(next - 1) * 7);
        session.deadline_ns = ts_ns + T2_NS;
    }

    /// Drops transfers whose next frame is overdue at `ts_ns`.
    fn sweep(&mut self, ts_ns: i64) {
        if self.sessions.len() < SWEEP_AT.max(2 * self.left_after_sweep) {
            return;
        }
        self.sessions.retain(|_, s| s.deadline_ns >= ts_ns);
        self.left_after_sweep = self.sessions.len();
    }

    fn data(&mut self, key: (u8, u8, u8), frame: &FrameRef<'_>) -> Option<Transfer> {
        let (&sequence, payload) = frame.data.split_first()?;
        let session = self.sessions.get_mut(&key)?;
        if frame.ts_ns > session.deadline_ns {
            self.sessions.remove(&key);
            return None;
        }
        // A short packet would shift every later byte; rewinds also count 7 bytes a packet.
        if sequence != session.next_sequence || payload.len() != 7 {
            if !session.connection {
                self.sessions.remove(&key);
            }
            return None;
        }
        let missing = session.size - session.data.len();
        session
            .data
            .extend_from_slice(&payload[..payload.len().min(missing)]);
        session.next_sequence = session.next_sequence.wrapping_add(1);
        let mid_block = session.block_end.is_some_and(|end| sequence < end);
        // Without a CTS block to finish, the next frame of a connection may be a CTS.
        session.deadline_ns = frame.ts_ns
            + if session.connection && !mid_block {
                T3_NS
            } else {
                T1_NS
            };
        if session.data.len() < session.size {
            return None;
        }
        let session = self.sessions.remove(&key)?;
        Some(Transfer {
            id: session.id,
            ts_ns: frame.ts_ns,
            data: session.data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_on(
        r: &mut Reassembler,
        channel: u8,
        ts_ns: i64,
        id: u32,
        data: &[u8],
    ) -> Option<Transfer> {
        r.push(&FrameRef {
            ts_ns,
            channel,
            id: id | EXT_FLAG,
            flags: 0,
            data,
        })
    }

    fn push(r: &mut Reassembler, ts_ns: i64, id: u32, data: &[u8]) -> Option<Transfer> {
        push_on(r, 0, ts_ns, id, data)
    }

    /// A BAM from `source` at priority 6 announcing `size` bytes of `pgn`.
    fn bam(r: &mut Reassembler, ts_ns: i64, source: u8, pgn: u32, size: u16) -> Option<Transfer> {
        let [lo, hi] = size.to_le_bytes();
        let packets = size.div_ceil(7) as u8;
        let data = [
            BAM,
            lo,
            hi,
            packets,
            0xFF,
            pgn as u8,
            (pgn >> 8) as u8,
            (pgn >> 16) as u8,
        ];
        push(r, ts_ns, 0x18EC_FF00 | u32::from(source), &data)
    }

    const MS: i64 = 1_000_000;

    /// An RTS from `source` to `destination` at priority 6 announcing `size` bytes of
    /// proprietary A (PGN 0xEF00).
    fn rts(r: &mut Reassembler, ts_ns: i64, source: u8, destination: u8, size: u8) {
        let id = 0x18EC_0000 | (u32::from(destination) << 8) | u32::from(source);
        let packets = size.div_ceil(7);
        push(
            r,
            ts_ns,
            id,
            &[RTS, size, 0, packets, 0xFF, 0x00, 0xEF, 0x00],
        );
    }

    /// A CTS from `receiver` to `sender` for `packets` packets from number `next`.
    fn cts(r: &mut Reassembler, ts_ns: i64, receiver: u8, sender: u8, packets: u8, next: u8) {
        let id = 0x18EC_0000 | (u32::from(sender) << 8) | u32::from(receiver);
        push(
            r,
            ts_ns,
            id,
            &[CTS, packets, next, 0xFF, 0xFF, 0x00, 0xEF, 0x00],
        );
    }

    /// TP.DT packet `sequence` from `source` to `destination`, carrying `byte` seven times.
    fn dt(
        r: &mut Reassembler,
        ts_ns: i64,
        source: u8,
        destination: u8,
        sequence: u8,
        byte: u8,
    ) -> Option<Transfer> {
        let id = 0x18EB_0000 | (u32::from(destination) << 8) | u32::from(source);
        push(
            r,
            ts_ns,
            id,
            &[sequence, byte, byte, byte, byte, byte, byte, byte],
        )
    }

    #[test]
    fn reassembles_a_bam_transfer() {
        let mut r = Reassembler::default();
        // DM1 (PGN 0xFECA), 10 bytes in two packets; the last one is padded with 0xFF.
        assert_eq!(bam(&mut r, 1, 0x00, 0xFECA, 10), None);
        assert_eq!(
            push(&mut r, 2, 0x18EB_FF00, &[1, 1, 2, 3, 4, 5, 6, 7]),
            None
        );
        let done = push(
            &mut r,
            3,
            0x18EB_FF00,
            &[2, 8, 9, 10, 0xFF, 0xFF, 0xFF, 0xFF],
        )
        .unwrap();
        assert_eq!(
            done,
            Transfer {
                id: 0x18FE_CA00 | EXT_FLAG,
                ts_ns: 3,
                data: (1..=10).collect(),
            }
        );
        assert!(r.sessions.is_empty());
        assert_eq!(
            push(&mut r, 4, 0x18EB_FF00, &[3, 0, 0, 0, 0, 0, 0, 0]),
            None
        );
    }

    #[test]
    fn pdu1_groups_take_the_destination_and_priority_of_the_announcement() {
        // RTS from 0x03 to 0x17 at priority 7: nine bytes of proprietary A (PGN 0xEF00).
        let mut r = Reassembler::default();
        push(
            &mut r,
            1,
            0x1CEC_1703,
            &[RTS, 9, 0, 2, 0xFF, 0x00, 0xEF, 0x00],
        );
        // The CTS from 0x17 opens nothing.
        push(
            &mut r,
            2,
            0x1CEC_0317,
            &[17, 2, 1, 0xFF, 0xFF, 0x00, 0xEF, 0x00],
        );
        assert_eq!(r.sessions.len(), 1);
        push(&mut r, 3, 0x1CEB_1703, &[1, 1, 2, 3, 4, 5, 6, 7]);
        let done = push(
            &mut r,
            4,
            0x1CEB_1703,
            &[2, 8, 9, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        )
        .unwrap();
        assert_eq!(done.id, 0x1CEF_1703 | EXT_FLAG);
        assert_eq!(done.data, (1..=9).collect::<Vec<u8>>());
        // Nor does the end-of-message acknowledgement.
        assert_eq!(
            push(
                &mut r,
                5,
                0x1CEC_0317,
                &[19, 9, 0, 2, 0xFF, 0x00, 0xEF, 0x00]
            ),
            None
        );
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn a_missing_packet_or_a_new_announcement_drops_the_transfer() {
        let mut r = Reassembler::default();
        bam(&mut r, 1, 0x00, 0xFECA, 20);
        push(&mut r, 2, 0x18EB_FF00, &[1; 8]);
        assert_eq!(
            push(&mut r, 3, 0x18EB_FF00, &[3; 8]),
            None,
            "packet 2 missing"
        );
        assert!(r.sessions.is_empty());

        bam(&mut r, 4, 0x00, 0xFECA, 14);
        push(&mut r, 5, 0x18EB_FF00, &[1; 8]);
        bam(&mut r, 6, 0x00, 0xFECA, 14);
        push(&mut r, 7, 0x18EB_FF00, &[1, 2, 2, 2, 2, 2, 2, 2]);
        let done = push(&mut r, 8, 0x18EB_FF00, &[2, 3, 3, 3, 3, 3, 3, 3]).unwrap();
        assert_eq!(done.data, [2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3]);
        assert_eq!(done.ts_ns, 8);
    }

    #[test]
    fn an_abort_from_either_side_drops_the_transfer() {
        let mut r = Reassembler::default();
        push(
            &mut r,
            1,
            0x18EC_1703,
            &[RTS, 9, 0, 2, 0xFF, 0x00, 0xEF, 0x00],
        );
        push(
            &mut r,
            2,
            0x18EC_0317,
            &[ABORT, 1, 0xFF, 0xFF, 0xFF, 0x00, 0xEF, 0x00],
        );
        assert!(r.sessions.is_empty());
        push(
            &mut r,
            3,
            0x18EC_1703,
            &[RTS, 9, 0, 2, 0xFF, 0x00, 0xEF, 0x00],
        );
        push(
            &mut r,
            4,
            0x18EC_1703,
            &[ABORT, 1, 0xFF, 0xFF, 0xFF, 0x00, 0xEF, 0x00],
        );
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn an_abort_leaves_the_transfer_the_other_way_alone() {
        let mut r = Reassembler::default();
        // 0x03 sends proprietary A to 0x17 while 0x17 sends 14 bytes of PGN 0xEA00 to 0x03.
        rts(&mut r, 0, 0x03, 0x17, 14);
        push(
            &mut r,
            1,
            0x18EC_0317,
            &[RTS, 14, 0, 2, 0xFF, 0x00, 0xEA, 0x00],
        );
        assert_eq!(r.sessions.len(), 2);
        // 0x17 aborts the transfer it is receiving.
        push(
            &mut r,
            2,
            0x18EC_0317,
            &[ABORT, 1, 0xFF, 0xFF, 0xFF, 0x00, 0xEF, 0x00],
        );
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(dt(&mut r, 3, 0x03, 0x17, 1, 1), None);
        dt(&mut r, 4, 0x17, 0x03, 1, 1);
        let done = dt(&mut r, 5, 0x17, 0x03, 2, 2).unwrap();
        assert_eq!(done.id, 0x18EA_0317 | EXT_FLAG);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn a_short_packet_drops_a_bam_and_is_ignored_on_a_connection() {
        let mut r = Reassembler::default();
        bam(&mut r, 0, 0x00, 0xFECA, 14);
        assert_eq!(push(&mut r, 1, 0x18EB_FF00, &[1, 1, 1, 1, 1, 1]), None);
        assert!(r.sessions.is_empty());

        rts(&mut r, 10, 0x03, 0x17, 14);
        assert_eq!(push(&mut r, 11, 0x18EB_1703, &[1, 9, 9, 9]), None);
        assert_eq!(r.sessions.len(), 1);
        dt(&mut r, 12, 0x03, 0x17, 1, 1);
        let done = dt(&mut r, 13, 0x03, 0x17, 2, 2).unwrap();
        assert_eq!(done.data, [[1; 7], [2; 7]].concat());
    }

    #[test]
    fn expired_transfers_are_swept_out() {
        let mut r = Reassembler::default();
        for source in 0..255 {
            bam(&mut r, 0, source, 0xFECA, 100);
        }
        bam(&mut r, 1500 * MS, 0xFF, 0xFECA, 100);
        assert_eq!(r.sessions.len(), SWEEP_AT);
        // Only the last announcement is still due a packet.
        push_on(
            &mut r,
            1,
            2000 * MS,
            0x18EC_FF00,
            &[BAM, 9, 0, 2, 0xFF, 0xCA, 0xFE, 0x00],
        );
        assert_eq!(r.sessions.len(), 2);
        assert!(r.sessions.values().all(|s| s.data.capacity() == 0));
    }

    #[test]
    fn senders_and_channels_are_kept_apart() {
        let mut r = Reassembler::default();
        bam(&mut r, 1, 0x00, 0xFECA, 8);
        bam(&mut r, 2, 0x01, 0xFECA, 8);
        push(&mut r, 3, 0x18EB_FF00, &[1, 0, 0, 0, 0, 0, 0, 0]);
        push(&mut r, 4, 0x18EB_FF01, &[1, 1, 1, 1, 1, 1, 1, 1]);
        // A packet on another channel belongs to no transfer here.
        assert_eq!(push_on(&mut r, 1, 5, 0x18EB_FF00, &[2; 8]), None);
        let b = push(
            &mut r,
            6,
            0x18EB_FF01,
            &[2, 1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        )
        .unwrap();
        let a = push(
            &mut r,
            7,
            0x18EB_FF00,
            &[2, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        )
        .unwrap();
        assert_eq!((a.id, a.ts_ns, a.data), (0x98FE_CA00, 7, vec![0; 8]));
        assert_eq!((b.id, b.ts_ns, b.data), (0x98FE_CA01, 6, vec![1; 8]));
    }

    #[test]
    fn sizes_outside_the_protocol_and_standard_frames_are_ignored() {
        let mut r = Reassembler::default();
        bam(&mut r, 1, 0x00, 0xFECA, 0);
        bam(&mut r, 2, 0x01, 0xFECA, 1786);
        r.push(&FrameRef {
            ts_ns: 3,
            channel: 0,
            id: 0x6EC,
            flags: 0,
            data: &[BAM, 8, 0, 2, 0xFF, 0xCA, 0xFE, 0x00],
        });
        push(&mut r, 4, 0x18EC_FF02, &[BAM, 8, 0]);
        assert!(r.sessions.is_empty());

        // The largest transfer: 255 packets.
        bam(&mut r, 5, 0x00, 0xFECA, MAX_TRANSFER as u16);
        let mut done = None;
        for sequence in 1..=255u8 {
            done = push(&mut r, 5 + i64::from(sequence), 0x18EB_FF00, &[sequence; 8]);
        }
        let done = done.unwrap();
        assert_eq!(done.data.len(), MAX_TRANSFER);
        assert_eq!(done.data[..7], [1; 7]);
        assert_eq!(done.data[MAX_TRANSFER - 7..], [255; 7]);
    }

    #[test]
    fn bam_packets_may_come_up_to_t1_apart() {
        let mut r = Reassembler::default();
        // At the spec's 50 to 200 ms spacing, and once exactly T1 after the packet before.
        bam(&mut r, 0, 0x00, 0xFECA, 21);
        assert_eq!(dt(&mut r, 50 * MS, 0x00, 0xFF, 1, 1), None);
        assert_eq!(dt(&mut r, 250 * MS, 0x00, 0xFF, 2, 2), None);
        let done = dt(&mut r, 250 * MS + T1_NS, 0x00, 0xFF, 3, 3).unwrap();
        assert_eq!(done.data, [[1; 7], [2; 7], [3; 7]].concat());

        // One nanosecond more drops the transfer, and its later packets are ignored.
        bam(&mut r, 2000 * MS, 0x00, 0xFECA, 14);
        dt(&mut r, 2100 * MS, 0x00, 0xFF, 1, 1);
        assert_eq!(dt(&mut r, 2100 * MS + T1_NS + 1, 0x00, 0xFF, 2, 2), None);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn a_first_frame_later_than_t3_after_an_rts_drops_the_transfer() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 7);
        assert_eq!(dt(&mut r, T3_NS + 1, 0x03, 0x17, 1, 1), None);
        assert!(r.sessions.is_empty());

        // Up to T3 is fine, for a packet or a CTS.
        rts(&mut r, 0, 0x03, 0x17, 7);
        assert!(dt(&mut r, T3_NS, 0x03, 0x17, 1, 1).is_some());
        rts(&mut r, 0, 0x03, 0x17, 7);
        cts(&mut r, T3_NS, 0x17, 0x03, 1, 1);
        assert!(dt(&mut r, T3_NS + 10 * MS, 0x03, 0x17, 1, 1).is_some());
    }

    #[test]
    fn the_next_cts_may_come_up_to_t3_after_the_last_packet_of_a_block() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 14);
        cts(&mut r, 10 * MS, 0x17, 0x03, 1, 1);
        dt(&mut r, 20 * MS, 0x03, 0x17, 1, 1);
        cts(&mut r, 820 * MS, 0x17, 0x03, 1, 2);
        let done = dt(&mut r, 830 * MS, 0x03, 0x17, 2, 2).unwrap();
        assert_eq!(done.data, [[1; 7], [2; 7]].concat());
    }

    #[test]
    fn the_first_packet_may_come_up_to_t2_after_a_cts() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 14);
        cts(&mut r, 10 * MS, 0x17, 0x03, 2, 1);
        dt(&mut r, 810 * MS, 0x03, 0x17, 1, 1);
        let done = dt(&mut r, 820 * MS, 0x03, 0x17, 2, 2).unwrap();
        assert_eq!(done.data, [[1; 7], [2; 7]].concat());

        rts(&mut r, 0, 0x03, 0x17, 14);
        cts(&mut r, 10 * MS, 0x17, 0x03, 2, 1);
        assert_eq!(dt(&mut r, 10 * MS + T2_NS + 1, 0x03, 0x17, 1, 1), None);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn packets_within_a_cts_block_may_come_only_t1_apart() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 14);
        cts(&mut r, 10 * MS, 0x17, 0x03, 2, 1);
        dt(&mut r, 20 * MS, 0x03, 0x17, 1, 1);
        assert_eq!(dt(&mut r, 820 * MS, 0x03, 0x17, 2, 2), None);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn a_cts_for_earlier_packets_has_them_sent_again() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 20);
        cts(&mut r, 5 * MS, 0x17, 0x03, 3, 1);
        dt(&mut r, 10 * MS, 0x03, 0x17, 1, 1);
        dt(&mut r, 20 * MS, 0x03, 0x17, 2, 0xEE);
        // The receiver wants packet 2 again, then 3.
        cts(&mut r, 30 * MS, 0x17, 0x03, 2, 2);
        dt(&mut r, 40 * MS, 0x03, 0x17, 2, 2);
        let done = dt(&mut r, 50 * MS, 0x03, 0x17, 3, 3).unwrap();
        assert_eq!(done.id, 0x18EF_1703 | EXT_FLAG);
        assert_eq!(done.ts_ns, 50 * MS);
        assert_eq!(done.data, [&[1; 7][..], &[2; 7], &[3; 6]].concat());
    }

    #[test]
    fn rts_packets_out_of_order_wait_for_a_cts() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 21);
        dt(&mut r, 10 * MS, 0x03, 0x17, 1, 1);
        // Packet 2 went missing: 3 is ignored, not taken as 2, until the receiver asks again.
        assert_eq!(dt(&mut r, 30 * MS, 0x03, 0x17, 3, 3), None);
        assert_eq!(r.sessions.len(), 1);
        cts(&mut r, 40 * MS, 0x17, 0x03, 2, 2);
        dt(&mut r, 50 * MS, 0x03, 0x17, 2, 2);
        let done = dt(&mut r, 60 * MS, 0x03, 0x17, 3, 3).unwrap();
        assert_eq!(done.data, [[1; 7], [2; 7], [3; 7]].concat());

        // Ignored packets don't keep the transfer alive.
        rts(&mut r, 100 * MS, 0x03, 0x17, 21);
        dt(&mut r, 110 * MS, 0x03, 0x17, 1, 1);
        dt(&mut r, 110 * MS + T3_NS, 0x03, 0x17, 3, 3);
        cts(&mut r, 110 * MS + T3_NS + 1, 0x17, 0x03, 2, 2);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn a_cts_for_a_packet_not_sent_yet_drops_the_transfer() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 21);
        dt(&mut r, 10 * MS, 0x03, 0x17, 1, 1);
        cts(&mut r, 20 * MS, 0x17, 0x03, 1, 3);
        assert!(r.sessions.is_empty());

        // As does a CTS for packet 0.
        rts(&mut r, 100 * MS, 0x03, 0x17, 21);
        cts(&mut r, 110 * MS, 0x17, 0x03, 1, 0);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn a_cts_for_no_packets_holds_the_connection_for_t4() {
        let mut r = Reassembler::default();
        rts(&mut r, 0, 0x03, 0x17, 14);
        dt(&mut r, 10 * MS, 0x03, 0x17, 1, 1);
        cts(&mut r, 20 * MS, 0x17, 0x03, 0, 0xFF);
        cts(&mut r, 20 * MS + T4_NS, 0x17, 0x03, 0, 0xFF);
        cts(&mut r, 20 * MS + 2 * T4_NS, 0x17, 0x03, 1, 2);
        let done = dt(&mut r, 30 * MS + 2 * T4_NS, 0x03, 0x17, 2, 2).unwrap();
        assert_eq!(done.data, [[1; 7], [2; 7]].concat());

        // A hold runs out after T4.
        rts(&mut r, 0, 0x03, 0x17, 14);
        dt(&mut r, 10 * MS, 0x03, 0x17, 1, 1);
        cts(&mut r, 20 * MS, 0x17, 0x03, 0, 0xFF);
        assert_eq!(dt(&mut r, 20 * MS + T4_NS + 1, 0x03, 0x17, 2, 2), None);
        assert!(r.sessions.is_empty());
    }
}
