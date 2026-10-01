//! Signal bit extraction and insertion using DBC start-bit conventions.
//!
//! Intel (little-endian) signals give the start bit of their LSB, numbered `byte * 8 + bit`.
//! Motorola (big-endian) signals give the start bit of their MSB in the same "sawtooth" numbering
//! (7..0 | 15..8 | ...), then continue towards less significant bits and later bytes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ByteOrder {
    Intel,
    Motorola,
}

/// Where a signal's bits sit in a payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    first_byte: usize,
    last_byte: usize,
    /// Distance of the signal's LSB from the least significant end of the loaded bytes.
    shift: usize,
}

fn span(start_bit: u16, size: u16, order: ByteOrder) -> Option<Span> {
    let (start, size) = (usize::from(start_bit), usize::from(size));
    if size == 0 || size > 64 {
        return None;
    }
    Some(match order {
        ByteOrder::Intel => Span {
            first_byte: start / 8,
            last_byte: (start + size - 1) / 8,
            shift: start % 8,
        },
        ByteOrder::Motorola => {
            // Position counted from the MSB of byte 0, which makes big-endian bits contiguous.
            let msb = (start / 8) * 8 + (7 - start % 8);
            let lsb = msb + size - 1;
            let last_byte = lsb / 8;
            Span {
                first_byte: msb / 8,
                last_byte,
                shift: (last_byte + 1) * 8 - 1 - lsb,
            }
        }
    })
}

fn load(bytes: &[u8], order: ByteOrder) -> u128 {
    match order {
        ByteOrder::Intel => bytes
            .iter()
            .rev()
            .fold(0u128, |acc, &b| (acc << 8) | u128::from(b)),
        ByteOrder::Motorola => bytes
            .iter()
            .fold(0u128, |acc, &b| (acc << 8) | u128::from(b)),
    }
}

fn store(bytes: &mut [u8], order: ByteOrder, mut acc: u128) {
    let n = bytes.len();
    for k in 0..n {
        let i = match order {
            ByteOrder::Intel => k,
            ByteOrder::Motorola => n - 1 - k,
        };
        bytes[i] = acc as u8;
        acc >>= 8;
    }
}

fn mask(size: u16) -> u128 {
    (1u128 << size) - 1
}

/// Raw unsigned value of the field, or `None` if it doesn't fit in `data`.
#[must_use]
pub fn extract(data: &[u8], start_bit: u16, size: u16, order: ByteOrder) -> Option<u64> {
    let s = span(start_bit, size, order)?;
    let bytes = data.get(s.first_byte..=s.last_byte)?;
    Some(((load(bytes, order) >> s.shift) & mask(size)) as u64)
}

/// Write the low `size` bits of `raw` into the field. Returns `None` if it doesn't fit in `data`.
pub fn insert(
    data: &mut [u8],
    start_bit: u16,
    size: u16,
    order: ByteOrder,
    raw: u64,
) -> Option<()> {
    let s = span(start_bit, size, order)?;
    let bytes = data.get_mut(s.first_byte..=s.last_byte)?;
    let field = mask(size) << s.shift;
    let acc = (load(bytes, order) & !field) | ((u128::from(raw) << s.shift) & field);
    store(bytes, order, acc);
    Some(())
}

#[must_use]
pub fn sign_extend(raw: u64, size: u16) -> i64 {
    if size == 0 || size >= 64 {
        return raw as i64;
    }
    let unused = 64 - u32::from(size);
    ((raw << unused) as i64) >> unused
}

#[cfg(test)]
mod tests {
    use super::*;
    use ByteOrder::{Intel, Motorola};

    #[test]
    fn intel_fields() {
        let data = [0x34, 0x12, 0xF0, 0, 0, 0, 0, 0x80];
        assert_eq!(extract(&data, 0, 16, Intel), Some(0x1234));
        assert_eq!(extract(&data, 4, 8, Intel), Some(0x23));
        assert_eq!(extract(&data, 20, 4, Intel), Some(0xF));
        assert_eq!(extract(&data, 63, 1, Intel), Some(1));
        assert_eq!(extract(&data, 0, 64, Intel), Some(0x8000_0000_00F0_1234));
    }

    #[test]
    fn motorola_fields() {
        let data = [0x12, 0x34, 0xA5, 0, 0, 0, 0, 0x01];
        // MSB at byte 0 bit 7, 16 bits -> bytes 0..1 big-endian.
        assert_eq!(extract(&data, 7, 16, Motorola), Some(0x1234));
        // Low nibble of byte 0.
        assert_eq!(extract(&data, 3, 4, Motorola), Some(0x2));
        // Byte 1 bits 4..0 then byte 2 bits 7..5: 0b10100 then 0b101.
        assert_eq!(extract(&data, 12, 8, Motorola), Some(0b1010_0101));
        assert_eq!(extract(&data, 56, 1, Motorola), Some(1));
        assert_eq!(extract(&data, 7, 64, Motorola), Some(0x1234_A500_0000_0001));
    }

    #[test]
    fn out_of_range_fields() {
        assert_eq!(extract(&[0; 2], 8, 16, Intel), None);
        assert_eq!(extract(&[0; 2], 15, 16, Motorola), None);
        assert_eq!(extract(&[0; 8], 0, 0, Intel), None);
        assert_eq!(extract(&[0; 8], 0, 65, Intel), None);
    }

    #[test]
    fn insert_round_trips_and_preserves_neighbours() {
        let mut rng = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        for order in [Intel, Motorola] {
            for _ in 0..20_000 {
                let len = [8usize, 16, 64][(next() % 3) as usize];
                let size = (next() % 64 + 1) as u16;
                let start = (next() % (len as u64 * 8)) as u16;
                let raw = next() & ((1u128 << size) - 1) as u64;
                let before: Vec<u8> = (0..len).map(|_| next() as u8).collect();
                let mut data = before.clone();
                if insert(&mut data, start, size, order, raw).is_none() {
                    assert_eq!(extract(&before, start, size, order), None);
                    continue;
                }
                assert_eq!(extract(&data, start, size, order), Some(raw));
                // Clearing the field in both buffers must leave them identical.
                let mut a = before.clone();
                insert(&mut a, start, size, order, 0).unwrap();
                insert(&mut data, start, size, order, 0).unwrap();
                assert_eq!(a, data);
            }
        }
    }

    #[test]
    fn sign_extension() {
        assert_eq!(sign_extend(0xFF, 8), -1);
        assert_eq!(sign_extend(0x7F, 8), 127);
        assert_eq!(sign_extend(0b100, 3), -4);
        assert_eq!(sign_extend(u64::MAX, 64), -1);
    }
}
