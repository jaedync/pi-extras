"""harmony_lint.py SCOREDIR - check every pitched note against the chord that sounds at its onset.
A note is flagged when its pitch class is a half step above a chord tone of the root triad (an 'avoid
note': the 4th over a major chord, the b9 or b13 over a minor one) and it is not in the written voicing,
or when it is a half step from the bass note under it and lasts 0.3 s or more. Reads SCOREDIR/notes.json.
Exit code 1 when a note is flagged."""
import sys, json
d = json.load(open(sys.argv[1].rstrip("/") + "/notes.json"))
CH = d["chords"]
def chord_at(t):
    c = CH[0]
    for e in CH:
        if e[0] <= t + 0.02: c = e          # 20 ms: humanized notes may lead the bar line
    return c
bass = sorted(d["parts"].get("bass", []))
def bass_at(t):
    b = None
    for e in bass:
        if e[0] <= t + 1e-6 and t < e[0] + e[3]: b = e[1]
    return b
flags = 0
for part, notes in d["parts"].items():
    if part == "bass": continue
    for t, m, v, dur in notes:
        t0, name, ln, voicing = chord_at(t)
        pcs = {n % 12 for n in voicing}; root = min(voicing) % 12
        tri = sorted(pcs)
        # root triad tones: the lowest voicing note, plus the 3rd and 5th that exist in the voicing
        third = [p for p in pcs if (p - root) % 12 in (3, 4)]; fifth = [p for p in pcs if (p - root) % 12 == 7]
        core = {root, *third, *fifth}
        avoid = {(c + 1) % 12 for c in core} - pcs
        b = bass_at(t)
        why = []
        if m % 12 in avoid and dur >= 0.25: why.append("avoid note over " + name)
        if b is not None and (m - b) % 12 in (1, 11) and dur >= 0.3 and m % 12 not in pcs: why.append("half step from bass %d" % b)
        if why:
            flags += 1; print("%-8s t=%6.3f note %3d dur %.2f  %s" % (part, t, m, dur, "; ".join(why)))
print("flags:", flags)
sys.exit(1 if flags else 0)
