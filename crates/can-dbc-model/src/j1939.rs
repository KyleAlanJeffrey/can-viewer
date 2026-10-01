//! SAE J1939 parameter groups. A J1939 message in a DBC is written with one sender's CAN ID, but
//! any node may send its PGN at any priority, so frames are matched by PGN instead.

/// Bit 31 of a DBC message ID: the frame uses a 29-bit identifier.
pub const EXTENDED: u32 = 1 << 31;

/// Parameter group number of a 29-bit identifier. The PDU-specific byte is part of it only for
/// PDU2 formats (240 and up); for PDU1 it is a destination address.
#[must_use]
pub fn pgn(id: u32) -> u32 {
    let pgn = (id >> 8) & 0x3_FFFF;
    if pdu_format(pgn) < 240 {
        pgn & !0xFF
    } else {
        pgn
    }
}

#[must_use]
pub fn source_address(id: u32) -> u8 {
    id as u8
}

/// The 26 bits below the priority: data pages, PDU format, PDU specific and source address.
#[must_use]
pub fn without_priority(id: u32) -> u32 {
    id & 0x03FF_FFFF
}

/// Proprietary A (PF 239) and B (PF 255) groups mean whatever each sender defines, so they match
/// only frames from the source address the DBC was written for.
#[must_use]
pub fn is_proprietary(pgn: u32) -> bool {
    matches!(pdu_format(pgn), 0xEF | 0xFF)
}

fn pdu_format(pgn: u32) -> u32 {
    (pgn >> 8) & 0xFF
}

/// Whether a J1939 message defined with ID `defined` decodes a frame with ID `frame`, both in the
/// DBC convention.
#[must_use]
pub fn matches(defined: u32, frame: u32) -> bool {
    if defined & frame & EXTENDED == 0 {
        return false;
    }
    let group = pgn(frame);
    pgn(defined) == group
        && (!is_proprietary(group) || source_address(defined) == source_address(frame))
}

/// SAE J1939-71 ranges for a parameter of 1 to 8 whole bytes: a most significant byte above
/// 0xFA means a parameter-specific indicator, reserved, error or not available. Fields of other
/// sizes always count as available.
#[must_use]
pub fn not_available(raw: u64, size: u16) -> bool {
    size.is_multiple_of(8) && (8..=64).contains(&size) && raw >= 0xFB_u64 << (size - 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pgn_drops_priority_source_and_pdu1_destination() {
        // EEC1 from the engine (SA 0) and from the DBC's SA 0xFE, at different priorities.
        assert_eq!(pgn(0x0CF0_0400), 0xF004);
        assert_eq!(pgn(0x18F0_04FE | EXTENDED), 0xF004);
        // PDU1 (TSC1, PF 0): the destination byte isn't part of the PGN.
        assert_eq!(pgn(0x0C00_0003), 0);
        assert_eq!(pgn(0x0C00_2A03), 0);
        // Data page and extended data page bits are.
        assert_eq!(pgn(0x09F8_0110), 0x1_F801);
        assert_eq!(pgn(0x1BFE_F100), 0x3_FEF1);
    }

    #[test]
    fn matches_by_pgn_and_proprietary_by_source() {
        let eec1 = 0x8CF0_04FE;
        assert!(matches(eec1, 0x0CF0_0400 | EXTENDED));
        assert!(matches(eec1, 0x18F0_0417 | EXTENDED));
        assert!(!matches(eec1, 0x0CF0_0500 | EXTENDED));
        assert!(!matches(eec1, 0x0CF0_0400), "a standard frame has no PGN");

        let cluster_speed = 0x18FF_1D17 | EXTENDED;
        assert!(matches(cluster_speed, 0x0CFF_1D17 | EXTENDED));
        assert!(!matches(cluster_speed, 0x18FF_1D03 | EXTENDED));
        let proprietary_a = 0x18EF_0017 | EXTENDED;
        assert!(matches(proprietary_a, 0x18EF_2A17 | EXTENDED));
        assert!(!matches(proprietary_a, 0x18EF_0018 | EXTENDED));
    }
}
