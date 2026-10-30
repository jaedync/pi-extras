"""A picture-locked score: copy this file into the film project, then write the music.
Run it with `wv sound score score.py --cues out/cues.json --out score/`: that renders score.wav,
the stems and render/<part>.wav, then checks every hit (within 10 ms) and the harmony.
Rules it follows (references/score.md): one bar plan from the shot list, every picture hit placed by
time (never by ear), each hit also written to a dry part in render/ (for the hit check), the hit plan
and every pitched note written to json, stems balanced by LUFS, one master to -16 LUFS / -1.2 dBTP."""
import sys, os, json
import numpy as np
from sc import *                                   # SR, N, DUR, buf, place, voices, filt, lufs, master, ...

OUT = sys.argv[1]
TMP = os.path.join(OUT, "render"); os.makedirs(TMP, exist_ok=True)
SHEET = json.load(open(os.environ["WV_SCORE_CUES"])) if os.environ.get("WV_SCORE_CUES") else {"cues": [], "music": {}}
BPM = SHEET.get("music", {}).get("bpm", 120)
BEAT = 60 / BPM

# 1. The picture: the moments the music must hit, in film seconds, and the dry part that plays each.
#    Start from the cue sheet (out/cues.json), then keep only the moments that matter: the claims, the key
#    action, the logo. Choose ONE biggest hit and write down why.
LIFT = SHEET.get("music", {}).get("liftAt", round(DUR * 0.7 / BEAT) * BEAT)
HITS = [("biggest hit", LIFT, "kick")]
# 2. The bar plan: bar starts in seconds. Give a short shot a short bar, so each hit falls on a downbeat.
BARS = list(np.arange(0, DUR, 4 * BEAT))
# 3. The chord chart: (start, name, length, voicing as MIDI notes). The harmony check reads it.
CH = [(b, "Fmaj7", (BARS + [DUR])[i + 1] - b, [41, 57, 60, 64, 67]) for i, b in enumerate(BARS)]

kick = buf(); kt = []
for name, t, part in HITS: place(kick, kick808(1.0), t); kt.append(t)
pad = buf()
for t0, name, ln, v in CH:
    for n in v[1:]: place(pad, supersaw2(n, ln, voices=5, attack=0.3, release=0.4, cutoff=1800, lfo_hz=0.2, lfo_depth=0.15), t0, gain=0.25)
bass = buf()
for t0, name, ln, v in CH: place(bass, drive(sub_bass(v[0], ln - 0.05, 0.8)), t0)

stems = dict(drums=kick, bass=filt(bass, "hp", 30) * duck_curve(kt, 0.4)[:, None],
             harmony=filt(pad, "hp", 150) * duck_curve(kt, 0.5)[:, None])
TARGET = dict(drums=-19.0, bass=-21.0, harmony=-22.0)                 # balance by loudness, not by gain guesses
for k in stems: stems[k] = stems[k] * 10 ** ((TARGET[k] - lufs(stems[k][:N])) / 20)
end = gain_ramp([(0, 0), (DUR - 1.5, 0), (DUR - 0.15, -60), (DUR + 4, -90)])[:, None]  # a clean tail before the end
for k in stems: stems[k] = stems[k] * end
mix = sum(stems.values())
write(f"{TMP}/kick.wav", kick[:N] * 0.5)                               # dry part of each hit, for the hit check
json.dump([list(h) for h in HITS], open(f"{OUT}/hit-plan.json", "w"))
json.dump(dict(chords=[(t, n, ln, v) for t, n, ln, v in CH], parts=dict()), open(f"{OUT}/notes.json", "w"))
write_stems(OUT, stems, 10 ** ((-16.0 - lufs(mix[:N])) / 20))
m = master(mix, -16.0, -1.2)
write(f"{OUT}/score.wav", m[:N])
print("score written", OUT, "lufs", round(lufs(m[:N]), 2), "tp", round(true_peak(m[:N]), 2))
