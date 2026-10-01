//! SAE J1939-21 transport protocol: reassembly of multi-packet parameter groups.
//!
//! A sender announces a transfer with TP.CM (PGN 0xEC00), as a BAM to every node or an RTS to
//! one, then sends the bytes in TP.DT (PGN 0xEB00) packets of 7, numbered from 1: up to 1785
//! bytes in 255 packets. Transfers are tracked per channel, source and destination address, so
//! interleaved senders don't mix. Anything that goes wrong (a missing packet, a new announcement
//! before the last packet, an abort) drops the transfer quietly.

use rustc_hash::FxHashMap;

use crate::{FrameRef, EXT_FLAG};

/// Largest payload one transfer can carry: 255 packets of 7 bytes.
pub const MAX_TRANSFER: usize = 1785;

/// PDU formats of the connection management and data transfer groups.
const TP_CM: u32 = 0xEC;
const TP_DT: u32 = 0xEB;

/// TP.CM control bytes. CTS (17) and the end-of-message acknowledgement (19) come from the
/// receiver and change nothing here.
const RTS: u8 = 16;
const BAM: u8 = 32;
const ABORT: u8 = 255;

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
    size: usize,
    next_sequence: u8,
    data: Vec<u8>,
}

/// Open transfers, keyed by channel, source address and destination address.
#[derive(Debug, Default)]
pub struct Reassembler {
    sessions: FxHashMap<(u8, u8, u8), Session>,
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
        match control {
            RTS | BAM => {
                let size = usize::from(u16::from_le_bytes([size_lo, size_hi]));
                if size == 0 || size > MAX_TRANSFER {
                    return;
                }
                let pgn = u32::from(pgn_lo) | (u32::from(pgn_mid) << 8) | (u32::from(pgn_hi) << 16);
                let (_, source, destination) = key;
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
                // Replaces any unfinished transfer from the same sender to the same destination.
                self.sessions.insert(
                    key,
                    Session {
                        id,
                        size,
                        next_sequence: 1,
                        data: Vec::with_capacity(size),
                    },
                );
            }
            ABORT => {
                // Either side may abort, so the addresses may be the other way round.
                let (channel, source, destination) = key;
                self.sessions.remove(&key);
                self.sessions.remove(&(channel, destination, source));
            }
            _ => {}
        }
    }

    fn data(&mut self, key: (u8, u8, u8), frame: &FrameRef<'_>) -> Option<Transfer> {
        let (&sequence, payload) = frame.data.split_first()?;
        let session = self.sessions.get_mut(&key)?;
        if sequence != session.next_sequence {
            self.sessions.remove(&key);
            return None;
        }
        let missing = session.size - session.data.len();
        session
            .data
            .extend_from_slice(&payload[..payload.len().min(missing)]);
        session.next_sequence = session.next_sequence.wrapping_add(1);
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
}
