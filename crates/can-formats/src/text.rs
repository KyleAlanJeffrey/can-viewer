//! Number and field parsing shared by the text formats.

/// The whitespace-separated fields of a line.
pub(crate) fn fields(line: &[u8]) -> impl Iterator<Item = &[u8]> {
    line.split(|&b| b == b' ' || b == b'\t')
        .filter(|f| !f.is_empty())
}

pub(crate) fn starts_with_ignore_case(s: &[u8], prefix: &[u8]) -> bool {
    s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

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

/// Decimal digits, as long as their value fits an `i64`.
pub(crate) fn parse_decimal(s: &[u8]) -> Option<i64> {
    if s.is_empty() {
        return None;
    }
    s.iter().try_fold(0i64, |acc, &c| {
        if !c.is_ascii_digit() {
            return None;
        }
        acc.checked_mul(10)?.checked_add(i64::from(c - b'0'))
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

/// Days from 1970-01-01 to a proleptic Gregorian date; negative before it.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_from_march = (i64::from(month) + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// A UTC date and time of day as nanoseconds since the Unix epoch. Years outside 1678 to
/// 2262 (where the nanoseconds run out) give `None`, as a broken field. Years before 1970 are
/// kept, since the export of a log with times before the epoch starts in one.
pub(crate) fn unix_ns(year: i64, month: u32, day: u32, ns_of_day: i64) -> Option<i64> {
    if !(1678..=2262).contains(&year) {
        return None;
    }
    days_from_civil(year, month, day)
        .checked_mul(86_400_000_000_000)?
        .checked_add(ns_of_day)
}

/// Payload length for a CAN FD DLC code.
pub(crate) fn dlc_to_len(dlc: u8) -> usize {
    match dlc {
        0..=8 => usize::from(dlc),
        9 => 12,
        10 => 16,
        11 => 20,
        12 => 24,
        13 => 32,
        14 => 48,
        _ => 64,
    }
}

/// A bus name `can<number>` built without allocating, for formats that number their buses.
pub(crate) struct ChannelName {
    buf: [u8; 24],
    len: usize,
}

impl ChannelName {
    pub(crate) fn new(number: u64) -> Self {
        let mut buf = [0u8; 24];
        buf[..3].copy_from_slice(b"can");
        let mut digits = [0u8; 20];
        let mut count = 0;
        let mut n = number;
        loop {
            digits[count] = b'0' + (n % 10) as u8;
            count += 1;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        for i in 0..count {
            buf[3 + i] = digits[count - 1 - i];
        }
        Self {
            buf,
            len: 3 + count,
        }
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_days_match_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2025, 9, 30), 20_361);
        assert_eq!(days_from_civil(1899, 12, 30), -25_569);
    }

    #[test]
    fn unix_ns_is_checked() {
        assert_eq!(unix_ns(1970, 1, 1, 5), Some(5));
        assert_eq!(unix_ns(2025, 9, 30, 0), Some(1_759_190_400_000_000_000));
        assert_eq!(unix_ns(2262, 4, 11, 0), Some(9_223_286_400_000_000_000));
        assert_eq!(unix_ns(2262, 12, 31, 0), None);
        assert_eq!(unix_ns(1969, 12, 31, 0), Some(-86_400_000_000_000));
        assert_eq!(unix_ns(1678, 1, 1, 0), Some(-9_214_560_000_000_000_000));
        assert_eq!(unix_ns(1677, 12, 31, 0), None);
        assert_eq!(unix_ns(i64::MAX, 1, 1, 0), None);
    }

    #[test]
    fn decimals_up_to_the_largest_i64() {
        assert_eq!(parse_decimal(b"0000000000000000000000042"), Some(42));
        assert_eq!(
            parse_decimal(b"1759190400123456789"),
            Some(1_759_190_400_123_456_789)
        );
        assert_eq!(parse_decimal(b"9223372036854775807"), Some(i64::MAX));
        assert_eq!(parse_decimal(b"9223372036854775808"), None);
        assert_eq!(parse_decimal(b"12a"), None);
    }

    #[test]
    fn channel_names_are_decimal() {
        assert_eq!(ChannelName::new(0).as_bytes(), b"can0");
        assert_eq!(ChannelName::new(17).as_bytes(), b"can17");
        assert_eq!(
            ChannelName::new(u64::MAX).as_bytes(),
            b"can18446744073709551615"
        );
    }

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
