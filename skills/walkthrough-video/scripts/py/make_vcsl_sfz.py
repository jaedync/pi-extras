"""Build the drum kit and mallet SFZ instruments from the VCSL samples.

`wv setup --music` runs this on a fresh VCSL checkout. The output is byte for
byte the hand-built kit's maps (2026-10-29), so a score sounds the same on both.

VCSL (Versilian Community Sample Library) is CC0 1.0: no attribution required.
Source: https://github.com/sgossner/VCSL

    python make_vcsl_sfz.py --src <VCSL checkout> --out <music-kit>/samples/vcsl

Writes kit/ (flattened, safe file names), kit.sfz (GM drum map: 36, 37, 38, 39,
42, 46, 49, 50, 54, 82), marimba.sfz and glock.sfz (pitched, nearest sample).
"""

import argparse
import os
import re
import sys

SRC = ""
OUT = ""
KIT = ""

NOTE_NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_to_midi(name):
    m = re.match(r"([A-G])([#b]?)(-?[0-9]+)", name)
    if not m:
        return None
    letter, acc, octv = m.groups()
    v = 12 * (int(octv) + 1) + NOTE_NAMES[letter]
    v += {"#": 1, "b": -1, "": 0}[acc]
    return v


def vel_from_name(name):
    """Turn v2/v5/v9, or soft/medium/loud, into a velocity band 1..127."""
    m = re.search(r"_v([0-9]+)_", name)
    if m:
        v = min(int(m.group(1)), 10)
        return int(round(v / 10 * 127))
    if re.search(r"\bsoft\b|_soft_", name):
        return 50
    if re.search(r"\bmedium\b|_med_", name):
        return 85
    if re.search(r"\bloud\b", name):
        return 118
    if "pp" in name:
        return 45
    if "mp" in name:
        return 70
    if "mf" in name:
        return 90
    if "ff" in name:
        return 115
    return 100


def copy(src_rel, dst_name, normalize=0.0):
    """Copy a sample into the flat kit folder.

    normalize > 0 scales the file so its sample peak equals that value.
    The VCSL pitched samples are recorded low (-19 dBFS peak), so normalizing
    keeps the SFZ velocity response usable.
    """
    import numpy as _np
    import soundfile as _sf
    src = os.path.join(SRC, src_rel)
    if not os.path.exists(src):
        print("MISSING", src)
        return None
    dst = os.path.join(KIT, dst_name)
    x, sr = _sf.read(src, dtype="float32", always_2d=True)
    # trim leading silence: a hit must start at sample 0 of its note event
    mono = _np.abs(x).max(axis=1)
    idx = int(_np.argmax(mono > 0.002)) if mono.size else 0
    x = x[idx:]
    # drop trailing silence below -60 dB (keeps SFZ tails short and predictable)
    keep = _np.where(mono[idx:] > 0.001)[0]
    end = int(keep[-1]) + 1 if keep.size else len(x)
    x = x[:end]
    if normalize > 0:
        pk = float(_np.max(_np.abs(x))) or 1.0
        x = x * (normalize / pk)
    _sf.write(dst, x, sr, subtype="PCM_24")
    return dst_name


def main():
    global SRC, OUT, KIT
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", required=True, help="the VCSL checkout (its root folder)")
    ap.add_argument("--out", required=True, help="the samples/vcsl folder to write")
    args = ap.parse_args()
    SRC, OUT = args.src, args.out
    KIT = os.path.join(OUT, "kit")
    os.makedirs(KIT, exist_ok=True)
    regions = []  # (key, lo, hi, sample)

    def add_layered(prefix, src_dir, files, key, key_center=None, normalize=0.8):
        """One velocity layer per vN value; round robins use seq_position.

        Velocity bands are contiguous from 1 to 127 so no velocity plays
        silence, and only one round robin sounds per hit.
        """
        by_vel = {}
        for f in sorted(files):
            if not f.endswith(".wav"):
                continue
            by_vel.setdefault(vel_from_name(f), []).append(f)
        vels = sorted(by_vel)
        n = len(vels)
        for i, vel in enumerate(vels):
            if n <= 3:
                # few layers: split the velocity range evenly, so a two-layer
                # instrument still uses soft below 64 and loud above it
                lo = 1 if i == 0 else int(round(i * 127 / n)) + 1
                hi = 127 if i == n - 1 else int(round((i + 1) * 127 / n))
            else:
                lo = 1 if i == 0 else (vels[i - 1] + vel) // 2 + 1
                hi = 127 if i == n - 1 else (vel + vels[i + 1]) // 2
            rr = by_vel[vel]
            # keep the recorded dynamic steps: soft layers are quieter than
            # loud layers, so velocity keeps a real dynamic range (about 6 dB
            # across layers) on top of the SFZ velocity tracking.
            target = 0.30 + 0.50 * (vel / 127.0)
            for j, f in enumerate(rr):
                dst = prefix + "__" + re.sub(r"[^A-Za-z0-9._-]", "_", f)
                if copy(os.path.join(src_dir, f), dst, normalize=target):
                    regions.append((key, lo, hi, dst, key_center or key,
                                    len(rr), j + 1))

    # --- 36 kick -----------------------------------------------------------
    add_layered("bd", "Membranophones/Struck Membranophones/Bass Drum 1",
                [f for f in os.listdir(os.path.join(SRC, "Membranophones/Struck Membranophones/Bass Drum 1"))
                 if f.endswith(".wav") and "_rr" in f], 36)

    # --- 38 snare (HitSN = snare wires on) --------------------------------
    snare_dir = "Membranophones/Struck Membranophones/Snare Drum, Modern 1"
    add_layered("sn", snare_dir,
                [f for f in os.listdir(os.path.join(SRC, snare_dir))
                 if f.endswith(".wav") and "HitSN_" in f], 38)

    # --- 37 rim / stick ---------------------------------------------------
    add_layered("rim", snare_dir,
                [f for f in os.listdir(os.path.join(SRC, snare_dir))
                 if f.endswith(".wav") and "stick_" in f], 37)

    # --- 39 clap ----------------------------------------------------------
    add_layered("clap", "Idiophones/Struck Idiophones/Claps",
                [f for f in os.listdir(os.path.join(SRC, "Idiophones/Struck Idiophones/Claps"))
                 if f.startswith("Clap_rr")], 39)

    # --- 42 closed hat ----------------------------------------------------
    hh_dir = "Idiophones/Struck Idiophones/Hi-Hat Cymbal"
    add_layered("hh", hh_dir,
                [f for f in os.listdir(os.path.join(SRC, hh_dir))
                 if f.endswith(".wav") and ("HitC_" in f or "Close_" in f)], 42)

    # --- 46 open hat ------------------------------------------------------
    add_layered("hho", hh_dir,
                [f for f in os.listdir(os.path.join(SRC, hh_dir))
                 if f.endswith(".wav") and "HitO" in f], 46)

    # --- 49 crash ---------------------------------------------------------
    sus_dir = "Idiophones/Struck Idiophones/Suspended Cymbal 1"
    add_layered("crash", sus_dir,
                [f for f in os.listdir(os.path.join(SRC, sus_dir))
                 if f.startswith("susCymb1_hit_f") or f.startswith("susCymb1_hit_mp")
                 or f.startswith("susCymb1_hit_pp")], 49)

    # --- 82 shaker: six articulations rotate as round robins -------------
    sh_dir = "Idiophones/Struck Idiophones/Shaker, Large"
    sh_files = sorted(f for f in os.listdir(os.path.join(SRC, sh_dir))
                      if f.endswith(".wav"))
    target = 0.55
    n_sh = 0
    for f in sh_files:
        dst = "sh__" + re.sub(r"[^A-Za-z0-9._-]", "_", f)
        if copy(os.path.join(sh_dir, f), dst, normalize=target):
            n_sh += 1
            regions.append((82, 1, 127, dst, 82, n_sh, n_sh))
    # fix seq_length to the real count now that it is known
    for i, r in enumerate(regions):
        if r[0] == 82:
            regions[i] = (r[0], r[1], r[2], r[3], r[4], n_sh, r[6])

    # --- 54 tambourine: two velocity layers ------------------------------
    add_layered("tamb", "Idiophones/Struck Idiophones/Tambourine 1",
                [f for f in os.listdir(os.path.join(SRC, "Idiophones/Struck Idiophones/Tambourine 1"))
                 if f.endswith(".wav") and "_Hit_" in f], 54, normalize=0.6)

    # --- 50 tom -----------------------------------------------------------
    tom_dir = "Membranophones/Struck Membranophones/Tom 1/Stick"
    add_layered("tom", tom_dir,
                [f for f in os.listdir(os.path.join(SRC, tom_dir))
                 if "HitS_" in f], 50)

    with open(os.path.join(OUT, "kit.sfz"), "w") as fh:
        fh.write("// VCSL drum kit, generated by make_vcsl_sfz.py\n")
        fh.write("// Samples: Versilian Community Sample Library, CC0 1.0\n")
        fh.write("<control>\ndefault_path=kit/\n")
        fh.write("<global>\nvolume=3\namp_veltrack=55\nloop_mode=one_shot\n")
        fh.write("ampeg_attack=0.0005\nampeg_release=0.35\n")
        for key, lo, hi, dst, kc, nrr, pos in regions:
            rr = f" seq_length={nrr} seq_position={pos}" if nrr > 1 else ""
            fh.write(f"<region> sample={dst} key={key} lovel={lo} hivel={hi} "
                     f"pitch_keycenter={kc}{rr}\n")

    # --- pitched instruments: marimba, glock -----------------------------
    def pitched(instrument, out_name, min_key, max_key, release=0.5):
        d = os.path.join(SRC, "Idiophones/Struck Idiophones", instrument)
        entries = []
        for f in sorted(os.listdir(d)):
            if not f.endswith(".wav"):
                continue
            m = re.search(r"([A-G]#?[0-9])", f)
            if not m:
                continue
            note = note_to_midi(m.group(1))
            if note is None:
                continue
            dst = instrument.lower() + "__" + re.sub(r"[^A-Za-z0-9._-]", "_", f)
            if copy(os.path.join("Idiophones/Struck Idiophones", instrument, f), dst,
                    normalize=0.70):
                entries.append((note, vel_from_name(f), dst))
        if not entries:
            return
        notes = sorted({e[0] for e in entries})
        # nearest sample wins for every MIDI key in [min_key, max_key]
        bounds = {}
        for k in range(min_key, max_key + 1):
            best = min(notes, key=lambda n: abs(n - k))
            bounds.setdefault(best, [k, k])
            bounds[best][0] = min(bounds[best][0], k)
            bounds[best][1] = max(bounds[best][1], k)
        with open(os.path.join(OUT, out_name), "w") as fh:
            fh.write(f"// VCSL {instrument}, generated. CC0 1.0.\n")
            fh.write("<control>\ndefault_path=kit/\n")
            fh.write(f"<global>\namp_veltrack=55\nloop_mode=one_shot\n"
                     f"ampeg_attack=0.0005\nampeg_release={release}\n")
            for note in notes:
                lo, hi = bounds[note]
                layers = sorted([e for e in entries if e[0] == note], key=lambda e: e[1])
                for i, (n, vel, dst) in enumerate(layers):
                    vlo = 1 if i == 0 else (layers[i - 1][1] + vel) // 2 + 1
                    vhi = 127 if i == len(layers) - 1 else (vel + layers[i + 1][1]) // 2
                    fh.write(f"<region> sample={dst} key={note} lovel={vlo} hivel={vhi} "
                             f"pitch_keycenter={note} lokey={lo} hikey={hi}\n")
        print(out_name, "notes:", notes)

    pitched("Marimba", "marimba.sfz", 24, 96)
    pitched("Glockenspiel", "glock.sfz", 55, 100)

    print("kit regions:", len(regions))
    print("samples:", len(os.listdir(KIT)),
          "size MB:", int(sum(os.path.getsize(os.path.join(KIT, f))
                              for f in os.listdir(KIT)) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
