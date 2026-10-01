"""Cross-check our DBC decoder against cantools, an independent implementation.

Usage:
    cargo run --release -p sample-gen -- decode LOG DBC N > ours.csv
    python scripts/crosscheck_cantools.py LOG DBC ours.csv N

Frames are read here with a minimal candump line splitter, so only the decoder is compared.
Exits non-zero on any mismatch or on signals that one side decodes and the other doesn't.

cantools refuses to decode a frame whose multiplexor has a value that switches in no signal
(or a frame too short for the message), where ours decodes the signals that are there. Such
frames are counted and left out of the comparison.
"""

import csv
import math
import sys

import cantools


def frames(path, limit):
    with open(path) as f:
        for index, line in enumerate(f):
            if index >= limit:
                return
            _ts, _chan, frame = line.split()[:3]
            can_id, body = frame.split("#", 1)
            if body.startswith("#"):
                body = body[2:]  # CAN FD: drop the flags digit
            yield index, int(can_id, 16), bytes.fromhex(body)


def not_available(message, signal, raw):
    """Mirrors MessageDef::decode: a byte-sized unsigned J1939 value whose top byte is above 0xFA
    means error or not available (SAE J1939-71), so our decoder leaves it out."""
    return (
        message.protocol == "j1939"
        and message.is_extended_frame
        and not signal.is_signed
        and not signal.is_float
        and signal.length % 8 == 0
        and raw >= 0xFB << (signal.length - 8)
    )


def main(log, dbc, ours_csv, limit):
    db = cantools.database.load_file(dbc)
    expected = {}
    skipped = set()
    for index, frame_id, data in frames(log, int(limit)):
        try:
            message = db.get_message_by_frame_id(frame_id)
        except KeyError:
            continue
        try:
            raw = message.decode(data, decode_choices=False, scaling=False)
        except cantools.database.DecodeError:
            skipped.add(index)
            continue
        for name, value in message.decode(data, decode_choices=False).items():
            if not not_available(message, message.get_signal_by_name(name), raw[name]):
                expected[(index, message.name, name)] = float(value)

    actual = {}
    with open(ours_csv) as f:
        for row in csv.DictReader(f):
            if int(row["frame"]) in skipped:
                continue
            actual[(int(row["frame"]), row["message"], row["signal"])] = float(row["value"])

    missing = expected.keys() - actual.keys()
    extra = actual.keys() - expected.keys()
    wrong = [
        (k, expected[k], actual[k])
        for k in expected.keys() & actual.keys()
        if not math.isclose(expected[k], actual[k], rel_tol=1e-9, abs_tol=1e-9)
    ]
    print(f"{len(expected)} values from cantools, {len(actual)} from ours")
    if skipped:
        print(f"{len(skipped)} frames cantools would not decode were left out")
    for label, items in (("missing from ours", missing), ("extra in ours", extra), ("mismatched", wrong)):
        if items:
            print(f"{len(items)} {label}, e.g. {sorted(items)[:5]}")
    sys.exit(1 if missing or extra or wrong else 0)


if __name__ == "__main__":
    main(*sys.argv[1:])
