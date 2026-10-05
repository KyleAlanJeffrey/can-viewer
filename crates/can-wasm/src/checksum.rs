//! Checksum recognition for Suggested signals: does one payload byte follow a known checksum rule
//! over the message's other bytes?

/// A frame of this many bytes or fewer is checked whole; longer ones are not checked.
const MAX_CHECKED_LEN: usize = 64;

/// A rule whose result is compared with the candidate byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    /// Non-reflected CRC-8 with this polynomial, start value 0 and no final XOR.
    Crc(u8),
    Xor,
    Sum,
}

/// How the rule's result relates to the byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Relation {
    /// The byte equals the rule's result XOR a fixed value, which for a CRC also covers any start
    /// value, final XOR or fixed data ID ahead of the bytes: a CRC of a fixed length is affine.
    XorConstant,
    /// The byte equals the result plus a fixed value, modulo 256.
    PlusConstant,
    /// The byte plus the result is a fixed value, modulo 256: a complemented sum.
    Complement,
}

struct Check {
    rule: Rule,
    relation: Relation,
}

const CHECKS: [Check; 7] = [
    Check {
        rule: Rule::Crc(0x1D),
        relation: Relation::XorConstant,
    },
    Check {
        rule: Rule::Crc(0x2F),
        relation: Relation::XorConstant,
    },
    Check {
        rule: Rule::Crc(0x07),
        relation: Relation::XorConstant,
    },
    Check {
        rule: Rule::Crc(0x9B),
        relation: Relation::XorConstant,
    },
    Check {
        rule: Rule::Xor,
        relation: Relation::XorConstant,
    },
    Check {
        rule: Rule::Sum,
        relation: Relation::PlusConstant,
    },
    Check {
        rule: Rule::Sum,
        relation: Relation::Complement,
    },
];

const fn crc_table(poly: u8) -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ poly
            } else {
                crc << 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

const CRC_1D: [u8; 256] = crc_table(0x1D);
const CRC_2F: [u8; 256] = crc_table(0x2F);
const CRC_07: [u8; 256] = crc_table(0x07);
const CRC_9B: [u8; 256] = crc_table(0x9B);

fn crc(table: &[u8; 256], init: u8, bytes: impl Iterator<Item = u8>) -> u8 {
    bytes.fold(init, |crc, b| table[usize::from(crc ^ b)])
}

fn table(poly: u8) -> &'static [u8; 256] {
    match poly {
        0x1D => &CRC_1D,
        0x2F => &CRC_2F,
        0x07 => &CRC_07,
        _ => &CRC_9B,
    }
}

impl Rule {
    fn apply(self, bytes: impl Iterator<Item = u8>) -> u8 {
        match self {
            Rule::Crc(poly) => crc(table(poly), 0, bytes),
            Rule::Xor => bytes.fold(0, |a, b| a ^ b),
            Rule::Sum => bytes.fold(0, u8::wrapping_add),
        }
    }
}

impl Relation {
    fn key(self, byte: u8, result: u8) -> u8 {
        match self {
            Relation::XorConstant => byte ^ result,
            Relation::PlusConstant => byte.wrapping_sub(result),
            Relation::Complement => byte.wrapping_add(result),
        }
    }
}

/// A checksum rule the byte follows, and on what share of frames.
#[derive(Debug, Clone, PartialEq)]
pub struct ChecksumMatch {
    /// The rule, as a person would name it, such as `CRC-8 SAE J1850` or `a sum checksum`.
    pub name: String,
    /// The share of frames, 0 to 1, on which the byte follows the rule.
    pub share: f64,
}

/// The fixed value a standard CRC-8 has for `len` bytes, against a start value of 0 and no
/// final XOR: `CRC(init, xorout)(data) = CRC0(data) ^ CRC(init, xorout)(zeros)`.
fn standard_constant(poly: u8, init: u8, xor_out: u8, len: usize) -> u8 {
    crc(table(poly), init, std::iter::repeat_n(0, len)) ^ xor_out
}

fn describe(check: &Check, constant: u8, len: usize) -> String {
    match (check.rule, check.relation) {
        (Rule::Crc(0x1D), _) if constant == standard_constant(0x1D, 0xFF, 0xFF, len) => {
            "CRC-8 SAE J1850".into()
        }
        (Rule::Crc(0x2F), _) if constant == standard_constant(0x2F, 0xFF, 0xFF, len) => {
            "CRC-8 AUTOSAR".into()
        }
        (Rule::Crc(0x07), _) if constant == 0 => "CRC-8 (poly 0x07)".into(),
        (Rule::Crc(poly), _) => format!("CRC-8 (poly 0x{poly:02X}) with a fixed start value"),
        (Rule::Xor, _) if constant == 0 => "an XOR checksum".into(),
        (Rule::Xor, _) => format!("an XOR checksum with 0x{constant:02X}"),
        (Rule::Sum, Relation::PlusConstant) if constant == 0 => "a sum checksum".into(),
        (Rule::Sum, Relation::PlusConstant) => format!("a sum checksum plus 0x{constant:02X}"),
        (Rule::Sum, _) => "a complemented sum checksum".into(),
    }
}

/// The rule `byte` best follows over the other bytes of `frames`, all of length `len`, or `None`
/// when no rule holds on at least `min_share` of them. Rules are tried in order, so with a tie
/// the commoner CRCs win over a plain XOR or sum.
#[must_use]
pub fn detect(frames: &[&[u8]], byte: usize, len: usize, min_share: f64) -> Option<ChecksumMatch> {
    if frames.is_empty() || byte >= len || !(2..=MAX_CHECKED_LEN).contains(&len) {
        return None;
    }
    let others = |data: &[u8]| -> [u8; MAX_CHECKED_LEN] {
        let mut out = [0u8; MAX_CHECKED_LEN];
        let mut n = 0;
        for (i, &b) in data[..len].iter().enumerate() {
            if i != byte {
                out[n] = b;
                n += 1;
            }
        }
        out
    };
    let mut best: Option<ChecksumMatch> = None;
    for check in &CHECKS {
        let mut counts = [0usize; 256];
        for data in frames {
            let rest = others(data);
            let result = check.rule.apply(rest[..len - 1].iter().copied());
            counts[usize::from(check.relation.key(data[byte], result))] += 1;
        }
        let (constant, hits) = counts
            .iter()
            .enumerate()
            .max_by_key(|&(k, &n)| (n, std::cmp::Reverse(k)))
            .expect("256 counts");
        let share = *hits as f64 / frames.len() as f64;
        if share >= min_share && best.as_ref().is_none_or(|b| share > b.share) {
            best = Some(ChecksumMatch {
                name: describe(check, constant as u8, len - 1),
                share,
            });
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CRC-8 SAE J1850 the long way: polynomial 0x1D, start 0xFF, final XOR 0xFF.
    fn j1850(bytes: &[u8]) -> u8 {
        let mut crc = 0xFFu8;
        for &b in bytes {
            crc ^= b;
            for _ in 0..8 {
                crc = if crc & 0x80 != 0 {
                    (crc << 1) ^ 0x1D
                } else {
                    crc << 1
                };
            }
        }
        crc ^ 0xFF
    }

    fn frames(n: usize, checksum_at: usize, rule: impl Fn(&[u8]) -> u8) -> Vec<Vec<u8>> {
        let mut rng = 0x2545_F491_4F6C_DD1Du64;
        (0..n)
            .map(|i| {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                let mut data = vec![
                    i as u8,
                    (rng >> 8) as u8,
                    0x12,
                    (rng >> 20) as u8,
                    0,
                    0,
                    0,
                    0,
                ];
                let rest: Vec<u8> = data
                    .iter()
                    .enumerate()
                    .filter(|&(k, _)| k != checksum_at)
                    .map(|(_, &b)| b)
                    .collect();
                data[checksum_at] = rule(&rest);
                data
            })
            .collect()
    }

    fn found(frames: &[Vec<u8>], byte: usize) -> Option<ChecksumMatch> {
        let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
        detect(&refs, byte, 8, 0.9)
    }

    #[test]
    fn the_check_value_of_the_standard_crcs() {
        // The catalogued check values for "123456789".
        assert_eq!(j1850(b"123456789"), 0x4B);
        let constant = standard_constant(0x1D, 0xFF, 0xFF, 9);
        assert_eq!(
            crc(&CRC_1D, 0, b"123456789".iter().copied()) ^ constant,
            0x4B
        );
        let autosar = standard_constant(0x2F, 0xFF, 0xFF, 9);
        assert_eq!(
            crc(&CRC_2F, 0, b"123456789".iter().copied()) ^ autosar,
            0xDF
        );
        assert_eq!(crc(&CRC_07, 0, b"123456789".iter().copied()), 0xF4);
    }

    #[test]
    fn recognises_crc8_sae_j1850_in_the_last_byte() {
        let frames = frames(500, 7, j1850);
        let m = found(&frames, 7).unwrap();
        assert_eq!(m.name, "CRC-8 SAE J1850");
        assert_eq!(m.share, 1.0);
        assert!(found(&frames, 1).is_none(), "a data byte is no checksum");
    }

    #[test]
    fn recognises_a_crc_with_another_start_value_in_the_first_byte() {
        let frames = frames(500, 0, |rest| crc(&CRC_2F, 0x5A, rest.iter().copied()));
        let m = found(&frames, 0).unwrap();
        assert_eq!(m.name, "CRC-8 (poly 0x2F) with a fixed start value");
    }

    #[test]
    fn recognises_sums_and_xors() {
        let sum = frames(300, 7, |rest| {
            rest.iter().fold(0, |a: u8, &b| a.wrapping_add(b))
        });
        assert_eq!(found(&sum, 7).unwrap().name, "a sum checksum");
        let plus = frames(300, 7, |rest| {
            rest.iter().fold(0x10, |a: u8, &b| a.wrapping_add(b))
        });
        assert_eq!(found(&plus, 7).unwrap().name, "a sum checksum plus 0x10");
        let complement = frames(300, 7, |rest| {
            0xFFu8.wrapping_sub(rest.iter().fold(0, |a: u8, &b| a.wrapping_add(b)))
        });
        assert_eq!(
            found(&complement, 7).unwrap().name,
            "a complemented sum checksum"
        );
        let xor = frames(300, 7, |rest| rest.iter().fold(0, |a, &b| a ^ b));
        assert_eq!(found(&xor, 7).unwrap().name, "an XOR checksum");
    }

    #[test]
    fn a_rule_that_holds_on_most_frames_reports_its_share() {
        let mut frames = frames(200, 7, j1850);
        for f in frames.iter_mut().step_by(20) {
            f[7] ^= 0x55;
        }
        let m = found(&frames, 7).unwrap();
        assert_eq!(m.name, "CRC-8 SAE J1850");
        assert!((m.share - 0.95).abs() < 1e-9, "{}", m.share);
    }

    #[test]
    fn random_bytes_follow_no_rule() {
        let frames = frames(500, 7, |rest| {
            rest[0].wrapping_mul(97) ^ rest[3].rotate_left(3)
        });
        assert!(found(&frames, 7).is_none());
        assert!(detect(&[], 7, 8, 0.9).is_none());
    }
}
