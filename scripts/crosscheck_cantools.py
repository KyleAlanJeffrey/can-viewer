"""Cross-check our DBC decoder against cantools, an independent implementation.

Usage:
    cargo run --release -p sample-gen -- decode LOG DBC N > ours.csv
    python scripts/crosscheck_cantools.py LOG DBC ours.csv N

Frames are read here with a minimal candump line splitter, so only the decoder is compared.
Exits non-zero on any mismatch or on signals that one side decodes and the other doesn't.
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


def main(log, dbc, ours_csv, limit):
    db = cantools.database.load_file(dbc)
    expected = {}
    for index, frame_id, data in frames(log, int(limit)):
        try:
            message = db.get_message_by_frame_id(frame_id)
        except KeyError:
            continue
        for name, value in message.decode(data, decode_choices=False).items():
            expected[(index, message.name, name)] = float(value)

    actual = {}
    with open(ours_csv) as f:
        for row in csv.DictReader(f):
            actual[(int(row["frame"]), row["message"], row["signal"])] = float(row["value"])

    missing = expected.keys() - actual.keys()
    extra = actual.keys() - expected.keys()
    wrong = [
        (k, expected[k], actual[k])
        for k in expected.keys() & actual.keys()
        if not math.isclose(expected[k], actual[k], rel_tol=1e-9, abs_tol=1e-9)
    ]
    print(f"{len(expected)} values from cantools, {len(actual)} from ours")
    for label, items in (("missing from ours", missing), ("extra in ours", extra), ("mismatched", wrong)):
        if items:
            print(f"{len(items)} {label}, e.g. {sorted(items)[:5]}")
    sys.exit(1 if missing or extra or wrong else 0)


if __name__ == "__main__":
    main(*sys.argv[1:])
