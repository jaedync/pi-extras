"""hit_check.py SCOREDIR - prove that each planned hit sits on its picture time in the final score.wav.
1. Onset in the dry part that plays the hit (render/<part>.wav, no reverb, no other parts): the steepest
   rise in a +-25 ms window, read on the broadband peak envelope (see hit_timing.py).
2. Offset of that part inside score.wav: cross-correlation of the dry part with the full score in a 70 ms
   window that starts 5 ms before the planned time (both high-passed at 150 Hz), lag searched over +-25 ms.
   This finds the hit even when other notes on the same beat mask a plain onset detector.
Onset in score.wav = dry onset + lag. Pass: |error| <= 10 ms. Writes SCOREDIR/hit-table.md.
The hit list comes from SCOREDIR/hit-plan.json. Exit code 1 when a hit misses."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, soundfile as sf
from scipy import signal
from hit_timing import measure
d = sys.argv[1].rstrip("/")
# The frame column is read against the film's own rate: 60 fps is only the default.
FPS = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
if not 1 <= FPS <= 240:
    print(f"ERROR: fps {FPS} is not a film rate: give 1 to 240"); sys.exit(2)
if not os.path.exists(f"{d}/hit-plan.json"):
    print(f"ERROR: {d}/hit-plan.json is missing: the score must write its hit plan, [[name, time_s, part], ...]"); sys.exit(2)
HITS = [tuple(h) for h in json.load(open(f"{d}/hit-plan.json"))]
mix, sr = sf.read(f"{d}/score.wav", always_2d=True); mm = mix.mean(1)
sos = signal.butter(2, 150, "highpass", fs=sr, output="sos")
mh = signal.sosfilt(sos, mm)
rows = [f"| moment | picture time (s) | frame ({FPS:g} fps) | part | onset in part (s) | lag in score.wav (ms) | onset in score.wav (s) | error (ms) | pass |",
        "|---|---|---|---|---|---|---|---|---|"]
allok = True; cache = {}
for name, t, part in HITS:
    p = f"{d}/render/{part}.wav"
    if not os.path.exists(p):
        print(f"ERROR: {p} is missing: the score must render each part to render/<part>.wav"); sys.exit(2)
    try:
        on = measure(p, [t])[0]
    except ValueError as error:
        print(f"ERROR: {error}"); sys.exit(2)
    if part not in cache:
        x, _ = sf.read(p, always_2d=True); cache[part] = signal.sosfilt(sos, x.mean(1))
    ph = cache[part]
    a, b = int((t - 0.005) * sr), int((t + 0.065) * sr); L = int(0.025 * sr)
    # A negative index reads from the end of the array, so an edge hit would compare the wrong audio.
    if a - L - 5 < 0 or b + L + 5 > min(len(mh), len(ph)):
        print(f"ERROR: the hit at {t} s is too near the start or end of score.wav to search for it"); sys.exit(2)
    seg = ph[a:b]
    best, lag = -2, 0
    for k in range(-L, L + 1, 4):
        y = mh[a + k:b + k]
        c = np.dot(seg, y) / (np.linalg.norm(seg) * np.linalg.norm(y) + 1e-12)
        if c > best: best, lag = c, k
    for k in range(lag - 4, lag + 5):   # refine to one sample
        y = mh[a + k:b + k]; c = np.dot(seg, y) / (np.linalg.norm(seg) * np.linalg.norm(y) + 1e-12)
        if c > best: best, lag = c, k
    onm = on["onset"] + lag / sr; err = (onm - t) * 1000; ok = abs(err) <= 10 and abs(on["err_ms"]) <= 10
    allok &= ok
    rows.append(f"| {name} | {t:.3f} | {round(t * FPS)} | {part} | {on['onset']:.4f} | {lag / sr * 1000:+.2f} (r={best:.2f}) | {onm:.4f} | {err:+.2f} | {'yes' if ok else 'NO'} |")
txt = "\n".join(rows) + f"\n\nAll {len(HITS)} hits within 10 ms of the picture: {'yes' if allok else 'NO'}\n"
open(f"{d}/hit-table.md", "w").write(txt); print(txt)
sys.exit(0 if allok else 1)
