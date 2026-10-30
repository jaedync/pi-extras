"""sc.py - voices, sampler, mix and master for a score written in code (from the Pointer scores A and B,
which the owner rated 7 and 8 of 10). wv sound score sets WV_SCORE_DURATION (the film's length) and
WV_MUSIC_KIT (sfizz_render and the sample sets, only for sampled parts; the synth voices need numpy and scipy).
Times in seconds, pitches as MIDI numbers, audio as float64 stereo (n, 2) at 48 kHz.
Sampled parts render through sfizz (SFZ + MIDI); synth parts are numpy."""
import math, os, shutil, subprocess, tempfile, json
import numpy as np, soundfile as sf, mido
from scipy import signal

SR = 48000
DUR = float(os.environ.get("WV_SCORE_DURATION", "30"))
N = int(DUR * SR)
MUSIC_KIT = os.environ.get("WV_MUSIC_KIT", os.path.expanduser("~/.cache/pi-walkthrough-video/music-kit"))
SFIZZ = os.environ.get("WV_SFIZZ") or next((p for p in (os.path.join(MUSIC_KIT, "bin", "sfizz_render"), os.path.join(MUSIC_KIT, "src/sfizz/build/library/bin/sfizz_render")) if os.path.exists(p)), "sfizz_render")
KIT = os.path.join(MUSIC_KIT, "samples/vcsl/")
PIANO = os.path.join(MUSIC_KIT, "samples/salamander/Salamander Grand Piano V3.sfz")
# No B or BARS here: a bar line follows one film's picture. Each score writes its own,
# from its own shots, so a new film cannot inherit another film's length.

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def rng(seed): return np.random.default_rng(seed)

# ---------------------------------------------------------------- buffers
def buf(): return np.zeros((N + SR * 4, 2))

def place(dst, x, t, gain=1.0, pan=0.0):
    """Add mono or stereo x into dst at time t (s). Equal-power pan."""
    if x.ndim == 1:
        a = (pan + 1) * math.pi / 4
        x = np.stack([x * math.cos(a), x * math.sin(a)], 1) * math.sqrt(2)
    s = int(round(t * SR))
    if s < 0: x = x[-s:]; s = 0
    n = min(len(x), len(dst) - s)
    if n > 0: dst[s:s + n] += x[:n] * gain

def trim(x): return x[:N]

# ---------------------------------------------------------------- sfizz
LAT_DIR = os.environ.get("WV_SCORE_CACHE", os.path.join(MUSIC_KIT, "latency"))

def attack_latency(sfz, pairs):
    """Measured attack latency (s) of each (note, vel) of an SFZ instrument: time from note-on to 25 % of
    the note's peak, rendered alone on silence. Cached per instrument. Sampled notes start late by their own
    attack (Salamander piano 9-17 ms, two VCSL glock samples about 10 ms), so a hit that must sit on a
    picture frame is played early by this amount."""
    import hashlib
    os.makedirs(LAT_DIR, exist_ok=True)
    cpath = os.path.join(LAT_DIR, hashlib.md5(sfz.encode()).hexdigest()[:10] + ".json")
    cache = json.load(open(cpath)) if os.path.exists(cpath) else {}
    todo = sorted({(int(m), int(v)) for m, v in pairs if f"{int(m)}:{int(v)}" not in cache})
    if todo:
        ev = [(1.0 + 0.6 * i, m, v, 0.2) for i, (m, v) in enumerate(todo)]
        x = sfz_render(sfz, ev, os.path.join(LAT_DIR, "probe.wav"), compensate=False, full=True)
        a = np.abs(x.mean(1))
        for i, (m, v) in enumerate(todo):
            s0 = int((1.0 + 0.6 * i) * SR); seg = a[s0 - 480:s0 + int(0.12 * SR)]
            j = int(np.argmax(seg > seg.max() * 0.25)) - 480
            cache[f"{m}:{v}"] = max(0.0, j / SR)
        json.dump(cache, open(cpath, "w"))
    return {k: cache[f"{int(k[0])}:{int(k[1])}"] for k in pairs}

def require_kit(sfz):
    """A sampled part needs the music kit: name the fix, not just the missing file."""
    sfizz = os.path.exists(SFIZZ) or (not os.path.isabs(SFIZZ) and shutil.which(SFIZZ))
    if not sfizz or not os.path.exists(sfz):
        raise SystemExit(f"wv sound score: this score plays a sampled part, and the music kit is not installed at {MUSIC_KIT}. "
                         f"Run `wv setup --music` (about 1 GB, 10 min), then run the score again. "
                         f"A score with only synth voices needs no kit.")

def sfz_render(sfz, notes, path, seed=0, compensate=None, full=False):
    """notes: list of (t, midi, vel, dur). Writes MIDI, renders with sfizz, returns stereo.
    compensate: start each note early by its measured attack latency (attack_latency), capped at 25 ms.
    Default: on for pitched instruments, off for the drum kit (its round robins make one probe per note
    unreliable: the VCSL shaker 'shake' samples swell for up to 74 ms, the kick and snare start in < 6 ms)."""
    require_kit(sfz)
    ppq = 960; tpb = ppq * 2  # ticks per second at 120 BPM
    if compensate is None: compensate = not sfz.endswith("kit.sfz")
    if compensate:
        vels = [(int(m), int(max(1, min(127, v)))) for t, m, v, d in notes]
        lat = attack_latency(sfz, vels)
        notes = [(max(0.0, t - min(0.025, lat[(int(m), int(max(1, min(127, v))))])), m, v, d) for t, m, v, d in notes]
    ev = []
    for t, m, v, d in notes:
        ev.append((int(round(t * tpb)), 1, m, int(max(1, min(127, v)))))
        ev.append((int(round((t + d) * tpb)), 0, m, 0))
    ev.sort(key=lambda e: (e[0], e[1]))
    mid = mido.MidiFile(type=0, ticks_per_beat=ppq); tr = mido.MidiTrack(); mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    last = 0
    for tk, on, m, v in ev:
        tr.append(mido.Message("note_on" if on else "note_off", note=m, velocity=v, time=tk - last)); last = tk
    tr.append(mido.MetaMessage("end_of_track", time=SR // 10))
    mpath = path[:-4] + ".mid"; mid.save(mpath)
    subprocess.run([SFIZZ, "--sfz", sfz, "--midi", mpath, "--wav", path, "-s", str(SR), "-q", "3"],
                   check=True, capture_output=True)
    x, r = sf.read(path, always_2d=True); assert r == SR
    if full: return x[:, :2]
    out = buf(); n = min(len(x), len(out)); out[:n] = x[:n, :2]
    return out

def load_sample(name):
    x, r = sf.read(KIT + "kit/" + name, always_2d=True)
    if r != SR: x = signal.resample_poly(x, SR, r, axis=0)
    return x.mean(1) if x.shape[1] > 1 else x[:, 0]

# ---------------------------------------------------------------- filters
def biquad(kind, f, q, sr=SR, gain_db=0.0):
    w = 2 * math.pi * min(f, sr * 0.45) / sr; c = math.cos(w); al = math.sin(w) / (2 * q)
    if kind == "lp": b = [(1 - c) / 2, 1 - c, (1 - c) / 2]; a = [1 + al, -2 * c, 1 - al]
    elif kind == "hp": b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]; a = [1 + al, -2 * c, 1 - al]
    elif kind == "bp": b = [al, 0, -al]; a = [1 + al, -2 * c, 1 - al]
    elif kind == "peak":
        A = 10 ** (gain_db / 40); b = [1 + al * A, -2 * c, 1 - al * A]; a = [1 + al / A, -2 * c, 1 - al / A]
    b = np.array(b) / a[0]; a = np.array(a) / a[0]
    return b, a

def filt(x, kind, f, q=0.707, gain_db=0.0):
    b, a = biquad(kind, f, q, gain_db=gain_db)
    return signal.lfilter(b, a, x, axis=0)

def tv_filter(x, kind, cutoff, q=0.707, block=128):
    """Time-varying biquad. cutoff: array (len x) or callable of time. Mono or stereo."""
    mono = x.ndim == 1
    X = x[:, None] if mono else x
    y = np.zeros_like(X)
    zi = np.zeros((2, X.shape[1]))
    for s in range(0, len(X), block):
        f = cutoff[min(s + block // 2, len(cutoff) - 1)]
        b, a = biquad(kind, max(20.0, f), q)
        y[s:s + block], zi = signal.lfilter(b, a, X[s:s + block], axis=0, zi=zi)
    return y[:, 0] if mono else y

def onepole_lp(x, f):
    a = math.exp(-2 * math.pi * f / SR)
    return signal.lfilter([1 - a], [1, -a], x, axis=0)

# ---------------------------------------------------------------- oscillators
def saw(freq, n, phase0=0.0):
    """PolyBLEP band-limited saw. freq: scalar or array."""
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    dt = f / SR
    ph = (phase0 + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    m = ph < dt; t = ph[m] / dt[m]; y[m] -= t + t - t * t - 1
    m = ph > 1 - dt; t = (ph[m] - 1) / dt[m]; y[m] -= t * t + t + t + 1
    return y

def sine(freq, n, phase0=0.0):
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    return np.sin(2 * math.pi * (phase0 + np.cumsum(f) / SR))

def adsr(n, a, d, s, r, dur):
    """Envelope of n samples; note held for dur s, then release r."""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6) * 3))
    rel = t > dur
    if rel.any():
        lvl = np.interp(dur, t, e) if dur < t[-1] else e[-1]
        e = np.where(rel, lvl * np.exp(-(t - dur) / max(r, 1e-6) * 4.6), e)
    return e

def fade_tail(x, ms=6.0):
    k = min(len(x), int(ms * SR / 1000)); x = x.copy(); x[-k:] *= np.linspace(1, 0, k)[:, None] if x.ndim == 2 else np.linspace(1, 0, k)
    return x

# ---------------------------------------------------------------- voices
def wood_bass(m, dur, vel=1.0, bright=1.0, seed=0):
    """Round plucked bass: additive partials, higher ones decay faster (a string-like low-pass)."""
    n = int((dur + 0.35) * SR); t = np.arange(n) / SR; f0 = hz(m)
    y = np.zeros(n); r = rng(seed)
    for k in range(1, 14):
        if f0 * k > 5000: break
        amp = (1.0 / k ** 1.25) * (1.0 if k == 1 else 0.85 * bright)
        dec = 0.9 + 2.6 * (k - 1) * (0.7 / bright)
        y += amp * np.exp(-t * dec) * np.sin(2 * math.pi * f0 * k * t * (1 + 0.0004 * k * k) + r.uniform(0, 6.28))
    y += 0.35 * np.sin(2 * math.pi * f0 * t) * np.exp(-t * 0.6)  # body that sustains
    att = np.minimum(1, t / 0.006)
    rel = np.where(t > dur, np.exp(-(t - dur) / 0.08), 1.0)
    y = np.tanh(1.4 * y * att * rel) / np.tanh(1.4)
    return y * vel

def sub_bass(m, dur, vel=1.0, glide_from=None):
    n = int((dur + 0.15) * SR); t = np.arange(n) / SR
    f = np.full(n, hz(m))
    if glide_from is not None:
        g = np.minimum(1, t / 0.06); f = hz(glide_from) * (1 - g) + hz(m) * g
    y = sine(f, n) + 0.18 * sine(2 * f, n)
    e = np.minimum(1, t / 0.004) * np.where(t > dur, np.exp(-(t - dur) / 0.04), 1.0)
    return np.tanh(1.6 * y * e) * vel

def saw_bass(m, dur, vel=1.0, cutoff=900.0, env_amt=1800.0, decay=0.12):
    n = int((dur + 0.12) * SR); t = np.arange(n) / SR
    y = 0.6 * saw(hz(m), n, 0.0) + 0.4 * saw(hz(m) * 1.003, n, 0.5)
    cut = cutoff + env_amt * np.exp(-t / decay)
    y = tv_filter(y, "lp", cut, q=1.1, block=64)
    e = np.minimum(1, t / 0.003) * np.where(t > dur, np.exp(-(t - dur) / 0.03), 1.0)
    return y * e * vel

def supersaw(m, dur, voices=6, detune=0.11, seed=0, attack=0.25, release=0.5, cutoff=2600.0):
    """Stereo detuned saw stack, static low-pass."""
    n = int((dur + release + 0.1) * SR); r = rng(seed)
    L = np.zeros(n); R = np.zeros(n)
    for i in range(voices):
        cents = (i - (voices - 1) / 2) / ((voices - 1) / 2) * detune * 100
        y = saw(hz(m) * 2 ** (cents / 1200), n, r.uniform())
        p = (i / (voices - 1)) * 2 - 1
        L += y * math.cos((p + 1) * math.pi / 4); R += y * math.sin((p + 1) * math.pi / 4)
    x = np.stack([L, R], 1) / voices * 1.6
    x = filt(x, "lp", cutoff, 0.6)
    e = adsr(n, attack, 0.6, 0.85, release, dur)
    return x * e[:, None]

def soft_pad(m, dur, seed=0, attack=0.8, release=0.9, cutoff=1500.0, voices=3):
    return supersaw(m, dur, voices=voices, detune=0.07, seed=seed, attack=attack, release=release, cutoff=cutoff)

def pluck(m, dur=0.25, vel=1.0, bright=1.0, seed=0):
    """Synth pluck: two saws + square-ish, fast filter envelope."""
    n = int((dur + 0.4) * SR); t = np.arange(n) / SR; r = rng(seed)
    y = saw(hz(m), n, r.uniform()) * 0.6 + saw(hz(m) * 1.006, n, r.uniform()) * 0.4
    cut = 300 + 5200 * bright * np.exp(-t / 0.09)
    y = tv_filter(y, "lp", cut, q=1.2, block=64)
    e = np.minimum(1, t / 0.002) * np.exp(-t / (0.18 + 0.3 * dur))
    return y * e * vel

def kick808(vel=1.0, f0=160.0, f1=46.0, dur=0.42, click=0.5):
    n = int(dur * SR); t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.035)
    y = np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)
    c = rng(3).standard_normal(n) * np.exp(-t / 0.004) * click
    c = filt(c, "hp", 1200)
    y = np.tanh(1.8 * (y + c)) / np.tanh(1.8)
    return fade_tail(y * vel)

def noise(n, seed=0): return rng(seed).standard_normal(n)

def riser(dur, f_lo=300.0, f_hi=9000.0, seed=0, curve=2.0):
    n = int(dur * SR); t = np.arange(n) / SR; p = (t / dur) ** curve
    x = np.stack([noise(n, seed), noise(n, seed + 1)], 1)
    cut = f_lo * (f_hi / f_lo) ** p
    x = tv_filter(x, "bp", cut, q=1.6, block=128) * 2.2
    return x * (0.08 + 0.92 * p)[:, None] ** 1.5

def reverse_swell(x, dur):
    """Reverse a mono/stereo hit and crop it so it ends at its loudest point; length dur."""
    y = x[::-1]
    pk = int(np.argmax(np.abs(y if y.ndim == 1 else y.mean(1))))
    y = y[max(0, pk - int(dur * SR)):pk]
    return y

def impact(dur=2.6, root=29, seed=5):
    n = int(dur * SR); t = np.arange(n) / SR
    f = hz(root) + hz(root + 12) * 1.2 * np.exp(-t / 0.05)
    boom = np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / 0.55)
    nz = filt(noise(n, seed), "lp", 2500) * np.exp(-t / 0.12) * 0.5
    y = np.tanh(1.5 * (boom + nz))
    return fade_tail(y)

# ---------------------------------------------------------------- dynamics
def duck_curve(times, depth, attack=0.004, release=0.18, shape=1.6):
    """Gain curve (N+4s,) that dips by `depth` (0..1) at each time. Pumps like a sidechain."""
    g = np.ones(N + SR * 4)
    for t0 in times:
        s = int(t0 * SR); a = int(attack * SR); r = int(release * SR * 2.5)
        seg = np.concatenate([np.linspace(1, 1 - depth, max(a, 1)),
                              1 - depth * (1 - (np.linspace(0, 1, r) ** (1 / shape)))])
        s0 = max(0, s - a); e = min(len(g), s0 + len(seg))
        g[s0:e] = np.minimum(g[s0:e], seg[:e - s0])
    return g

def gain_ramp(points):
    """points: [(t, dB), ...] piecewise linear in dB -> linear gain curve."""
    t = np.arange(N + SR * 4) / SR
    ts, ds = zip(*points)
    return 10 ** (np.interp(t, ts, ds) / 20)

# ---------------------------------------------------------------- space
def make_ir(seconds=2.2, predelay=0.02, damp=6000.0, seed=21, early=True):
    n = int(seconds * SR); t = np.arange(n) / SR; r = rng(seed); ch = []
    for c in range(2):
        x = r.standard_normal(n) * np.exp(-t * 6.9 / seconds)
        # damping grows with time: blend a low-passed copy in over the tail
        lp = onepole_lp(x, damp * 0.35)
        w = np.minimum(1, t / (seconds * 0.5))
        x = onepole_lp(x, damp) * (1 - w) + lp * w
        if early:
            for d, g in [(0.011, .6), (0.017, .45), (0.023 + .004 * c, .4), (0.037, .3), (0.053, .2)]:
                x[int(d * SR)] += g * 3
        x[:int(predelay * SR)] = 0
        ch.append(x / np.sqrt((x ** 2).sum()))
    return np.stack(ch, 1)

def reverb(x, ir, hp=200.0, lp=9000.0):
    x = filt(filt(x, "hp", hp), "lp", lp)
    y = np.stack([signal.fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1)
    return y

def delay(x, t_l, t_r, fb=0.35, mix=1.0, lp=4000.0, taps=6):
    y = np.zeros_like(x)
    for c, dt in enumerate((t_l, t_r)):
        d = int(dt * SR); src = x[:, c].copy()
        for k in range(1, taps + 1):
            src = onepole_lp(src, lp)
            if d * k < len(x): y[d * k:, c] += src[:len(x) - d * k] * fb ** (k - 1)
    return y * mix

def widen(x, amount=0.2):
    M = (x[:, 0] + x[:, 1]) / 2; S = (x[:, 0] - x[:, 1]) / 2 * (1 + amount)
    return np.stack([M + S, M - S], 1)

def haas(mono, ms=11.0, pan=0.0):
    d = int(ms * SR / 1000); y = np.zeros((len(mono), 2))
    y[:, 0] = mono; y[d:, 1] = mono[:-d]
    return y

# ---------------------------------------------------------------- loudness, io
def lufs(x):
    """BS.1770 integrated loudness (gated), numpy."""
    def kw(y):
        b, a = biquad("peak", 1681.97, 0.7071, gain_db=3.99984)
        # use the standard pre-filter coefficients for 48 kHz
        b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]; a1 = [1, -1.69065929318241, 0.73248077421585]
        b2 = [1.0, -2.0, 1.0]; a2 = [1, -1.99004745483398, 0.99007225036621]
        return signal.lfilter(b2, a2, signal.lfilter(b1, a1, y, axis=0), axis=0)
    y = kw(x); blk = int(0.4 * SR); hop = int(0.1 * SR)
    ms = np.array([(y[i:i + blk] ** 2).mean(0).sum() for i in range(0, len(y) - blk, hop)])
    l = -0.691 + 10 * np.log10(ms + 1e-20)
    g = ms[l > -70]; rel = -0.691 + 10 * np.log10(g.mean()) - 10
    g2 = g[(-0.691 + 10 * np.log10(g)) > rel]
    return -0.691 + 10 * np.log10(g2.mean())

def true_peak(x):
    y = signal.resample_poly(x, 4, 1, axis=0)
    return 20 * np.log10(np.abs(y).max() + 1e-12)

def write(path, x, bits=24):
    sf.write(path, np.clip(x, -1, 1).astype(np.float32), SR, subtype="PCM_24" if bits == 24 else "FLOAT")

def master(x, target_lufs=-16.0, tp_ceiling=-1.2, hp=30.0, comp=True, air_db=0.0):
    """Bus: high-pass, optional air shelf (8 kHz), gentle glue comp, gain to target,
    look-ahead peak limiter with 4x oversampled detection."""
    import pedalboard as pb
    y = filt(x, "hp", hp, 0.6)
    if air_db:
        y = np.asarray(pb.HighShelfFilter(cutoff_frequency_hz=8000, gain_db=air_db)(y.astype(np.float32), SR), float)
    if comp:
        y = np.asarray(pb.Compressor(threshold_db=-20, ratio=1.8, attack_ms=25, release_ms=200)(y.astype(np.float32), SR), float)
    for _ in range(3):
        y = y * 10 ** ((target_lufs - lufs(y)) / 20)
        y = limiter(y, tp_ceiling)
    return y

def limiter(x, ceiling_db=-1.2, look=0.003, release=0.08):
    """Look-ahead brickwall limiter on 4x-oversampled peaks (so true peak stays under the ceiling)."""
    c = 10 ** (ceiling_db / 20)
    up = signal.resample_poly(x, 4, 1, axis=0)
    pk = np.abs(up).max(1).reshape(-1, 4).max(1)[:len(x)]
    if len(pk) < len(x): pk = np.pad(pk, (0, len(x) - len(pk)))
    need = np.minimum(1, c / np.maximum(pk, 1e-9))
    L = int(look * SR)
    # min over look-ahead window, then smooth release
    from scipy.ndimage import minimum_filter1d
    g = minimum_filter1d(need, size=2 * L + 1, origin=0)
    a = math.exp(-1 / (release * SR))
    # release smoothing: gain may only rise slowly
    g2 = signal.lfilter([1 - a], [1, -a], g - 1) + 1
    g = np.minimum(g, g2)
    g = signal.lfilter(np.ones(L) / L, [1], np.concatenate([g, np.ones(L)]))[L:]  # smooth attack
    g = np.minimum(g, minimum_filter1d(need, size=2 * L + 1))
    return x * g[:, None]

def narrow(x, side=0.4, pan=0.0):
    """Shrink the side signal of a spaced-pair sample (mono-safe), then pan the result (equal power)."""
    M = (x[:, 0] + x[:, 1]) / 2; S = (x[:, 0] - x[:, 1]) / 2 * side
    L, Rr = M + S, M - S
    a = (pan + 1) * math.pi / 4
    return np.stack([L * math.cos(a) * math.sqrt(2), Rr * math.sin(a) * math.sqrt(2)], 1)

def space_for_cues(mus, cue_times, broad_db=2.5, high_db=6.0, split_hz=1000.0):
    """Make room for the sound cues: dip the whole music bed by broad_db, and its part above split_hz by
    high_db more (a dynamic-EQ dip, like a 'track spacer'), 25 ms before each cue, about 0.2 s release.
    The split is complementary (high = x - zero-phase low-pass), so with no dip the bed is unchanged."""
    from scipy.signal import butter, sosfiltfilt
    sos = butter(2, split_hz, "lowpass", fs=SR, output="sos")
    low = sosfiltfilt(sos, mus, axis=0); high = mus - low
    n = len(mus); ts = [t - 0.025 for t in cue_times]
    gb = duck_curve(ts, 1 - 10 ** (-broad_db / 20), attack=0.02, release=0.09)[:n, None]
    gh = duck_curve(ts, 1 - 10 ** (-high_db / 20), attack=0.015, release=0.08)[:n, None]
    return (low + high * gh) * gb

# ---------------------------------------------------------------- extra VCSL samples (CC0), downloaded to dl/
EXT = os.path.join(MUSIC_KIT, "samples/vcsl-extra/")
# measured pitch (MIDI) of each bowed vibraphone sample; VCSL names them one octave low (file E3 = E4, 329 Hz)
VIBES_BOWED = {57: "Vibes_bowed_A2_rr1_Main.wav", 64: "Vibes_bowed_E3_rr1_Main.wav", 67: "Vibes_bowed_G3_rr1_Main.wav",
               74: "Vibes_bowed_D4_rr1_Main.wav", 81: "Vibes_bowed_A4_rr1_Main.wav", 88: "Vibes_bowed_E5_rr1_Main.wav"}
_ext_cache = {}
def load_ext(name):
    if name not in _ext_cache:
        x, r = sf.read(EXT + name, always_2d=True)
        if r != SR: x = signal.resample_poly(x, SR, r, axis=0)
        _ext_cache[name] = x[:, :2]
    return _ext_cache[name]

def repitch(x, semis):
    """Resample a sample by a pitch ratio (it also changes its length, as a sampler does)."""
    from fractions import Fraction
    if abs(semis) < 1e-6: return x
    fr = Fraction(2 ** (-semis / 12)).limit_denominator(400)
    return signal.resample_poly(x, fr.numerator, fr.denominator, axis=0)

def bowed_vibes(m, dur, offset=None, fade_in=0.08, release=0.8):
    """One bowed vibraphone note. offset=None plays the natural bowed swell from the start of the sample;
    a number (s) starts inside the sustain, so the tone is present on the beat."""
    root = min(VIBES_BOWED, key=lambda k: abs(k - m))
    src = load_ext(VIBES_BOWED[root])
    w = int(0.05 * SR); e = np.sqrt(np.convolve(src.mean(1) ** 2, np.ones(w) / w, "same"))
    sus = np.median(e[int(2 * SR):int(6 * SR)])
    src = src * (10 ** (-30 / 20) / sus)                       # every note to the same sustain level
    if offset == "sustain": offset = float(np.argmax(e > sus * 0.7)) / SR   # where the bow has reached the tone
    x = repitch(src, m - root)
    if offset is not None: x = x[int(offset * SR * 2 ** (-(m - root) / 12)):]
    n = min(len(x), int((dur + release) * SR)); x = x[:n].copy()
    t = np.arange(n) / SR
    env = np.minimum(1, t / fade_in) if offset is not None else np.ones(n)
    env = env * np.where(t > dur, np.exp(-(t - dur) / (release / 4.6)), 1.0)
    return x * env[:, None]

def timpani(m, which="Timpani1_Hit_v4_rr1_Sum.wav", base=41.6):
    return repitch(load_ext(which), m - base)

def write_stems(out, stems, gain):
    """Write stems at one common gain: the score's gain, lowered as needed so no stem peaks above -1 dBFS.
    stems.json records the trim, so the sum of the stems plus trim_db equals the mix before the master bus."""
    peak = max(np.abs(x[:N]).max() for x in stems.values()) * gain
    trim = min(1.0, 10 ** (-1 / 20) / peak)
    for k, x in stems.items(): write(f"{out}/stem_{k}.wav", x[:N] * gain * trim)
    json.dump({"stems": sorted(stems), "trim_db": round(-20 * math.log10(trim), 2),
               "note": "sum the stems, add trim_db, then the master bus (sc.master) gives score.wav"},
              open(f"{out}/stems.json", "w"), indent=1)

# ---------------------------------------------------------------- v2 voices (score B revisions; the v1 voices stay unchanged)
def drift(n, cents=3.0, rate=0.4, seed=0):
    """Slow random pitch drift (ratio array), like an analog oscillator: low-passed noise, +-cents."""
    d = onepole_lp(rng(seed).standard_normal(n + SR), rate)[SR:]
    d = d / (np.abs(d).max() + 1e-12) * cents
    return 2 ** (d / 1200)

def drive(x, amt=1.5):
    """Soft saturation (tanh), level-matched at low level: adds harmonics, rounds the peaks."""
    return np.tanh(amt * x) / amt

def supersaw2(m, dur, voices=7, detune=0.12, seed=0, attack=0.25, release=0.5, cutoff=2600.0,
              env_amt=0.0, env_decay=0.25, lfo_hz=0.0, lfo_depth=0.0, sat=1.4, sub=0.0):
    """Detuned saw stack with life: each voice drifts slowly (+-4 cents), unequal voice levels (center loud),
    a filter envelope (cutoff * (1 + env_amt * exp(-t/env_decay))), an optional slow filter LFO,
    soft saturation after the filter, and an optional sine an octave down (sub) for body."""
    n = int((dur + release + 0.1) * SR); r = rng(seed); t = np.arange(n) / SR
    L = np.zeros(n); R = np.zeros(n); wsum = 0
    for i in range(voices):
        c = (i - (voices - 1) / 2) / ((voices - 1) / 2)
        cents = c * detune * 100 * (0.85 + 0.3 * r.uniform())
        w = 1.0 - 0.45 * abs(c)
        y = saw(hz(m) * 2 ** (cents / 1200) * drift(n, 4.0, 0.3 + 0.4 * r.uniform(), seed * 31 + i), n, r.uniform()) * w
        p = c * 0.9
        L += y * math.cos((p + 1) * math.pi / 4); R += y * math.sin((p + 1) * math.pi / 4); wsum += w
    x = np.stack([L, R], 1) / wsum * 2.2
    if sub: x += (sine(hz(m - 12), n, r.uniform()) * sub)[:, None]
    cut = cutoff * (1 + env_amt * np.exp(-t / env_decay))
    if lfo_depth: cut = cut * (1 + lfo_depth * np.sin(2 * math.pi * lfo_hz * t + r.uniform() * 6.28))
    x = tv_filter(x, "lp", np.clip(cut, 60, 18000), q=0.7, block=128)
    x = drive(x, sat)
    e = adsr(n, attack, 0.6, 0.85, release, dur)
    return x * e[:, None]

def pluck2(m, dur=0.25, vel=1.0, bright=1.0, seed=0):
    """Pluck with body: v1 pluck plus a short noise 'pick', a sine an octave down, slight detune drift, saturation."""
    n = int((dur + 0.4) * SR); t = np.arange(n) / SR; r = rng(seed)
    dr = drift(n, 3.0, 0.5, seed + 7)
    y = saw(hz(m) * dr, n, r.uniform()) * 0.55 + saw(hz(m) * 1.007 * dr, n, r.uniform()) * 0.35 \
        + sine(hz(m) * 0.5, n, r.uniform()) * 0.25
    cut = 280 + 4800 * bright * np.exp(-t / 0.08)
    y = tv_filter(y, "lp", cut, q=1.4, block=64)
    pick = filt(r.standard_normal(n) * np.exp(-t / 0.003), "bp", 3000, 0.8) * 0.15 * bright
    e = np.minimum(1, t / 0.0015) * np.exp(-t / (0.16 + 0.3 * dur))
    return drive((y + pick) * e * vel, 1.3)
