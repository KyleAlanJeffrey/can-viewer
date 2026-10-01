//! Number parsing shared by the text formats.

const HEX: [u8; 256] = {
    let mut table = [0xFF; 256];
    let mut i = 0;
    while i < 10 {
        table[b'0' as usize + i] = i as u8;
        i += 1;
    }
    let mut i = 0;
    while i < 6 {
        table[b'a' as usize + i] = 10 + i as u8;
        table[b'A' as usize + i] = 10 + i as u8;
        i += 1;
    }
    table
};

pub(crate) fn hex_value(c: u8) -> Option<u8> {
    let v = HEX[usize::from(c)];
    (v != 0xFF).then_some(v)
}

/// One to eight hex digits.
pub(crate) fn parse_hex_u32(s: &[u8]) -> Option<u32> {
    if s.is_empty() || s.len() > 8 {
        return None;
    }
    s.iter().try_fold(0u32, |acc, &c| {
        hex_value(c).map(|v| (acc << 4) | u32::from(v))
    })
}

/// One to eighteen decimal digits.
pub(crate) fn parse_decimal(s: &[u8]) -> Option<i64> {
    if s.is_empty() || s.len() > 18 {
        return None;
    }
    s.iter().try_fold(0i64, |acc, &c| {
        c.is_ascii_digit().then(|| acc * 10 + i64::from(c - b'0'))
    })
}

/// `12.345678` in a unit of `10^unit_exp` nanoseconds (9 for seconds, 6 for milliseconds,
/// 3 for microseconds), as nanoseconds. Digits finer than a nanosecond are dropped.
pub(crate) fn parse_decimal_ns(s: &[u8], unit_exp: u32) -> Option<i64> {
    let (int, frac) = match memchr::memchr(b'.', s) {
        Some(dot) => (&s[..dot], &s[dot + 1..]),
        None => (s, &[][..]),
    };
    let frac = &frac[..frac.len().min(unit_exp as usize)];
    let units = parse_decimal(int)?;
    let mut nanos = if frac.is_empty() {
        0
    } else {
        parse_decimal(frac)?
    };
    for _ in frac.len()..unit_exp as usize {
        nanos *= 10;
    }
    units.checked_mul(10i64.pow(unit_exp))?.checked_add(nanos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_ns_scales_by_unit() {
        assert_eq!(parse_decimal_ns(b"1.5", 9), Some(1_500_000_000));
        assert_eq!(parse_decimal_ns(b"1059.9", 6), Some(1_059_900_000));
        assert_eq!(parse_decimal_ns(b"7", 3), Some(7_000));
        assert_eq!(parse_decimal_ns(b"0.1234567891", 9), Some(123_456_789));
        assert_eq!(parse_decimal_ns(b"", 9), None);
        assert_eq!(parse_decimal_ns(b".5", 9), None);
        assert_eq!(parse_decimal_ns(b"1.x", 9), None);
        assert_eq!(parse_decimal_ns(b"9999999999999", 9), None);
    }
}
