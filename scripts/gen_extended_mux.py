"""Write a DBC with nested multiplexors (SG_MUL_VAL_) and a matching candump log, for
crosscheck_cantools.py. Needs only the standard library.

Usage:
    python scripts/gen_extended_mux.py OUT.log OUT.dbc [FRAMES]

Payloads are random apart from the multiplexors, which mostly take values that switch some
signal in. A few take values that switch nothing, which cantools refuses to decode, so the
crosscheck skips those frames. The output is the same on every run.
"""

import random
import sys

DBC = """VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 400 THREE_LEVELS: 8 ECU
 SG_ Mode M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Page m1M : 8|4@1+ (1,0) [0|15] "" Vector__XXX
 SG_ Sub m0M : 12|4@1+ (1,0) [0|15] "" Vector__XXX
 SG_ Speed m0 : 16|16@1+ (0.01,0) [0|655.35] "km/h" Vector__XXX
 SG_ Temp m0 : 32|8@1- (0.5,-40) [-104|23.5] "degC" Vector__XXX
 SG_ PageA m3 : 23|16@0- (0.1,0) [-3276.8|3276.7] "" Vector__XXX
 SG_ PageB m4 : 16|12@1+ (1,0) [0|4095] "" Vector__XXX
 SG_ Deep m1 : 32|24@1+ (1,0) [0|16777215] "" Vector__XXX
 SG_ DeepSigned m2 : 32|20@1- (0.25,10) [-131062|131081.75] "" Vector__XXX
 SG_ Plain : 56|8@1+ (1,0) [0|255] "" Vector__XXX

BO_ 2566870272 MOTOROLA_MUX: 8 ECU
 SG_ Sel M : 7|4@0+ (1,0) [0|15] "" Vector__XXX
 SG_ Inner m2M : 3|4@0+ (1,0) [0|15] "" Vector__XXX
 SG_ X m1 : 15|16@0+ (1,0) [0|65535] "" Vector__XXX
 SG_ Y m0 : 15|8@0- (2,-1) [-257|253] "" Vector__XXX
 SG_ Z m5 : 31|32@0+ (1,0) [0|4294967295] "" Vector__XXX

BO_ 768 FD_MUX: 64 ECU
 SG_ Kind M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Part m7M : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Far m0 : 320|64@1+ (1,0) [0|1.8446744073709552E+019] "" Vector__XXX
 SG_ Mid m1 : 400|32@1- (0.001,0) [-2147483.648|2147483.647] "" Vector__XXX
 SG_ Last m2 : 503|16@0+ (1,0) [0|65535] "" Vector__XXX

SG_MUL_VAL_ 400 Page Mode 1-2;
SG_MUL_VAL_ 400 Sub Page 0-3, 8-8;
SG_MUL_VAL_ 400 Speed Mode 0-0, 5-7;
SG_MUL_VAL_ 400 Temp Mode 0-0;
SG_MUL_VAL_ 400 PageA Page 3-3;
SG_MUL_VAL_ 400 PageB Page 4-6, 10-12;
SG_MUL_VAL_ 400 Deep Sub 1-1, 4-5;
SG_MUL_VAL_ 400 DeepSigned Sub 2-2;
SG_MUL_VAL_ 2566870272 Inner Sel 2-4;
SG_MUL_VAL_ 2566870272 X Inner 1-3;
SG_MUL_VAL_ 2566870272 Y Sel 0-1, 9-15;
SG_MUL_VAL_ 2566870272 Z Inner 5-15;
SG_MUL_VAL_ 768 Part Kind 7-9;
SG_MUL_VAL_ 768 Far Kind 0-6;
SG_MUL_VAL_ 768 Mid Part 1-1, 100-200;
SG_MUL_VAL_ 768 Last Part 2-99;
"""

# Message ID, candump ID, payload length, and per multiplexor: (start bit, size, Intel?, values
# that switch something in, values that switch nothing in). Multiplexors are set in this order.
MESSAGES = [
    (
        "190",
        8,
        [
            (0, 8, True, [0, 1, 2, 5, 6, 7], [3, 255]),
            (8, 4, True, [0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 12], [7, 15]),
            (12, 4, True, [1, 2, 4, 5], [0, 9]),
        ],
    ),
    (
        "18FF5500",
        8,
        [
            (7, 4, False, [0, 1, 2, 3, 4, 9, 15], [5]),
            (3, 4, False, [1, 2, 3, 5, 15], [0, 4]),
        ],
    ),
    (
        "300",
        64,
        [
            (0, 8, True, [0, 3, 6, 7, 8, 9], [10]),
            (8, 8, True, [1, 2, 50, 99, 100, 200], [0, 201]),
        ],
    ),
]


def set_bits(data, start, size, intel, value):
    """Writes `value` into a DBC bit field, numbered as in SG_ lines."""
    if intel:
        for k in range(size):
            bit = start + k
            mask = 1 << (bit % 8)
            data[bit // 8] = data[bit // 8] | mask if value >> k & 1 else data[bit // 8] & ~mask
        return
    # Motorola: `start` is the most significant bit; bits run down each byte, then on to bit 7
    # of the next byte.
    bit = start
    for k in reversed(range(size)):
        mask = 1 << (bit % 8)
        data[bit // 8] = data[bit // 8] | mask if value >> k & 1 else data[bit // 8] & ~mask
        bit = bit + 15 if bit % 8 == 0 else bit - 1


def main(log_path, dbc_path, frames="20000"):
    rng = random.Random(1939)
    with open(dbc_path, "w") as f:
        f.write(DBC)
    with open(log_path, "w") as f:
        for index in range(int(frames)):
            can_id, length, muxes = MESSAGES[index % len(MESSAGES)]
            data = bytearray(rng.randbytes(length))
            for start, size, intel, known, unknown in muxes:
                values = unknown if rng.random() < 0.03 else known
                set_bits(data, start, size, intel, rng.choice(values))
            separator = "##1" if length > 8 else "#"
            seconds, millis = divmod(index, 1000)
            f.write(f"({1_759_190_400 + seconds}.{millis:03d}000) can0 {can_id}{separator}{data.hex().upper()}\n")


if __name__ == "__main__":
    main(*sys.argv[1:])
