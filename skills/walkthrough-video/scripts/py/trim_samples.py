"""Remove the leading silence of a sample folder, in place.

Why: a recorded sample can have 3 to 9 ms of silence before the first audible
sample. In a film cue that delay moves the hit off the frame. This script trims
each file at its first sample above a threshold and writes it back in the same
format. The SFZ file needs no change: it still points at the same paths.

`wv setup --music` runs this on the Salamander piano samples with
--threshold-db -66 --max-ms 15. The hand-built kit used the same values, which
moved a piano hit from 7.7 ms late to 3.8 ms.

The threshold must be low enough to keep the softest layer. The cap stops the
script from cutting a long deliberate silence.
"""

import argparse
import glob
import os
import sys

import numpy as np
import soundfile as sf


def trim(path, threshold_db, max_ms, dry_run):
    info = sf.info(path)
    sr = info.samplerate
    max_trim = int(max_ms * sr / 1000.0)
    x, _ = sf.read(path, dtype="float32", always_2d=True)
    mono = np.abs(x).max(axis=1)
    thr = 10 ** (threshold_db / 20.0)
    above = np.nonzero(mono > thr)[0]
    if above.size == 0:
        return None
    idx = int(above[0])
    if idx > max_trim:
        idx = max_trim
    if idx == 0:
        return 0
    if not dry_run:
        sf.write(path, x[idx:], sr, subtype=info.subtype, format=info.format)
    return idx


def main():
    ap = argparse.ArgumentParser(description="Remove leading silence from a sample folder.")
    ap.add_argument("folder")
    ap.add_argument("--ext", default="flac,wav")
    ap.add_argument("--threshold-db", type=float, default=-66.0)
    ap.add_argument("--max-ms", type=float, default=15.0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    exts = tuple("." + e.strip().lstrip(".") for e in args.ext.split(","))
    files = sorted(f for f in glob.glob(os.path.join(args.folder, "*"))
                   if f.lower().endswith(exts))
    trims = []
    for f in files:
        t = trim(f, args.threshold_db, args.max_ms, args.dry_run)
        if t:
            trims.append((t, f))
    if not trims:
        print("nothing to trim in", args.folder)
        return 0
    vals = np.array([t for t, _ in trims], dtype=float)
    rates = {sf.info(f).samplerate for _, f in trims}
    sr = max(rates)
    print(f"files: {len(files)}, trimmed: {len(trims)}, "
          f"{'DRY RUN' if args.dry_run else 'WRITTEN'}")
    print(f"trim samples: min {int(vals.min())}, median {int(np.median(vals))}, "
          f"max {int(vals.max())}  (at {sr} Hz: "
          f"{1000*vals.min()/sr:.2f} to {1000*vals.max()/sr:.2f} ms)")
    print(f"total samples removed: {int(vals.sum())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
