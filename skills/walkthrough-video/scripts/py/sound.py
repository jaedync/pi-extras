"""
The measures and the mix behind `wv sound`, in the runtime venv: numpy and
soundfile only (no scipy, no librosa), with ffmpeg for resampling, loudness and
the limiter, and the rubberband CLI for a bed that must change tempo.

`wv sound` writes one job JSON and this script prints one answer JSON:

  tempo     the tempo without librosa (spectral flux, an 8-beat autocorrelation,
            a beat grid fitted to the onsets), the beat phase, the downbeats and
            the ranked lifts
  backtime  the offset into a bed where the film starts, so the biggest lift
            lands on the film second the author asked for
  mix       every cue cut into place at its attack and its own peak, the bed
            segment back-timed, stretched and faded, and the master

An error prints one "ERROR: <message>" line on stderr and exits 3, so the Node
side can repeat that message with the command name in front of it.
"""
import glob
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
import soundfile as sf

SR = 48000
# 10 ms hop and a 42.7 ms window: short enough for a click, long enough to see a kick.
HOP = 480
NFFT = 2048
# A cue lands on its attack: the first sample above half the file's peak. A
# 10 % onset put the hit of a recorded card landing, which slides in softly
# for 150 ms, that far behind its picture event.
ATTACK_FRACTION = 0.5
# A hit cut from a continuous take: 0.14 s, with the tail faded out.
HIT_SECONDS = 0.14
HIT_FADE_SECONDS = 0.08
HIT_THRESHOLD = 0.25
HIT_MINIMUM_GAP_SECONDS = 0.08
# The bed segment is brought to this loudness first, then the cue sheet's underCuesDb applies.
BED_LEVEL_LUFS = -12.0
LOUDNESS_TOLERANCE = 0.5
MASTER_ROUNDS = 3
# The most the limiter may take off the peaks. A sparse mix (cues, no bed) reaches
# the ceiling long before the loudness target; more limiting would crush its transients.
MAX_LIMIT_DB = 3.0
TEMPO_MIN_BPM = 60.0
TEMPO_MAX_BPM = 200.0
LIFT_WINDOW_SECONDS = 2.0
DOWNBEAT_BEATS = 4
# One beat, then two, four and eight: a lag whose multiples also repeat is the beat, not a bar.
LAG_MULTIPLES = ((1, 1.0), (2, 0.5), (4, 0.25), (8, 0.125))
# A tempo preference after Ellis (2007): film beds sit near 120 BPM, so when the
# autocorrelation cannot tell a beat from two beats, the beat near 120 wins.
REFERENCE_PERIOD_SECONDS = 0.5
PREFERENCE_OCTAVES = 0.9
# Spectral flux: log compression, so a quiet hat still counts next to a loud kick.
FLUX_COMPRESSION = 30.0
# The beat grid: look a fifth of a beat either side, refine three times, and let
# only the onsets that carry a quarter of the typical energy vote.
BEAT_WINDOW_SHARE = 0.2
GRID_ROUNDS = 3
QUIET_ONSET_SHARE = 0.25
# The beat phase is found to 1 ms, which is fine for a 2 s lift window.
PHASE_STEP_SECONDS = 0.001


class SoundError(Exception):
    """A message the author can act on: what was wrong, and what to change."""


def run_tool(command, what):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().split("\n")[-1]
        raise SoundError(f"{what} failed: {detail}")
    return result


class Loader:
    """Reads each sound once, at 48 kHz stereo float, resampled by ffmpeg when needed."""

    def __init__(self, tmp):
        self.tmp = tmp
        self.cache = {}

    def __call__(self, path):
        path = os.path.abspath(path)
        if path in self.cache:
            return self.cache[path]
        if not os.path.exists(path):
            raise SoundError(f"{path} does not exist")
        try:
            data, rate = sf.read(path, always_2d=True, dtype="float64")
        except Exception as error:
            raise SoundError(f"cannot read {path}: {error}")
        if rate != SR:
            converted = os.path.join(self.tmp, f"resampled-{len(self.cache)}-{os.path.basename(path)}")
            run_tool(["ffmpeg", "-v", "error", "-y", "-i", path, "-ar", str(SR), "-ac", "2", "-c:a", "pcm_f32le", converted], f"resampling {path} to 48 kHz")
            data, rate = sf.read(converted, always_2d=True, dtype="float64")
        if data.size == 0:
            raise SoundError(f"{path} holds no samples")
        data = np.ascontiguousarray(data)
        self.cache[path] = data
        return data


def to_stereo(data):
    """Mono becomes two equal channels; more than two channels keep the first two."""
    if data.shape[1] == 1:
        return np.repeat(data, 2, axis=1)
    if data.shape[1] > 2:
        return data[:, :2]
    return data


def envelope(data):
    """The per-sample peak across channels: what a listener hears as the level."""
    return np.abs(data).max(axis=1)


def attack_sample(data):
    """The first sample where the envelope passes half of the file's peak."""
    level = float(envelope(data).max())
    if level <= 0:
        raise SoundError("this sound is silent, so it cannot be placed")
    return int(np.argmax(envelope(data) > level * ATTACK_FRACTION))


def read_48k(loader, path):
    return to_stereo(loader(path))


def flux_envelope(signal, rate):
    """Spectral flux on an STFT written here: the onset strength envelope and its times."""
    signal = np.asarray(signal, dtype="float64")
    if len(signal) < NFFT:
        signal = np.pad(signal, (0, NFFT - len(signal)))
    frames = 1 + (len(signal) - NFFT) // HOP
    window = np.hanning(NFFT)
    index = HOP * np.arange(frames)[:, None] + np.arange(NFFT)[None, :]
    magnitudes = np.abs(np.fft.rfft(signal[index] * window, axis=1))
    # Log compression, so a quiet hat counts next to a loud kick.
    rise = np.maximum(np.diff(np.log1p(FLUX_COMPRESSION * magnitudes), axis=0), 0.0)
    strength = rise.sum(axis=1)
    # Flux[i] is the change into frame i + 1, so it belongs to that frame's centre.
    times = (np.arange(1, frames) * HOP + NFFT / 2.0) / rate
    return times, strength


def autocorrelation(strength):
    """Normalised autocorrelation of the onset envelope, by FFT."""
    centred = strength - strength.mean()
    size = 1 << (2 * len(centred) - 1).bit_length()
    spectrum = np.fft.rfft(centred, size)
    correlation = np.fft.irfft(spectrum * np.conj(spectrum), size)[: len(centred)]
    return correlation / (correlation[0] + 1e-12)


def comb_score(correlation, lag):
    """The autocorrelation at one beat lag and at 2, 4 and 8 beats: a beat repeats a bar."""
    total = 0.0
    weight = 0.0
    for multiple, share in LAG_MULTIPLES:
        at = lag * multiple
        if at >= len(correlation) - 1:
            continue
        total += share * float(np.interp(at, np.arange(len(correlation)), correlation))
        weight += share
    return total / weight if weight else 0.0


def tempo_preference(period):
    """A log-Gaussian weight around 120 BPM, after Ellis: it breaks the beat/double-beat tie."""
    if period <= 0:
        return 0.0
    return math.exp(-0.5 * (math.log2(period / REFERENCE_PERIOD_SECONDS) / PREFERENCE_OCTAVES) ** 2)


def coarse_period(correlation, hop_seconds):
    """The lag from 60 to 200 BPM that repeats best, refined by a parabola on the score."""
    low = (60.0 / TEMPO_MAX_BPM) / hop_seconds
    high = (60.0 / TEMPO_MIN_BPM) / hop_seconds
    lags = np.arange(low, high, 0.05)
    if len(lags) < 3:
        raise SoundError("this file is too short to measure a tempo")
    scores = np.array([comb_score(correlation, lag) * tempo_preference(lag * hop_seconds) for lag in lags])
    best = int(np.argmax(scores))
    lag = lags[best]
    if 0 < best < len(lags) - 1:
        before, at, after = scores[best - 1], scores[best], scores[best + 1]
        curvature = before - 2 * at + after
        if abs(curvature) > 1e-12:
            lag += 0.5 * (before - after) / curvature * (lags[1] - lags[0])
    return float(lag) * hop_seconds


def strength_at(times, strength, moment):
    """The onset strength at one moment, or at an array of them."""
    values = np.interp(moment, times, strength, left=0.0, right=0.0)
    return float(values) if np.ndim(values) == 0 else values


def peak_near(times, strength, moment, radius):
    """The strongest onset within radius of moment, refined by a parabola: (time, strength)."""
    low = int(np.searchsorted(times, moment - radius))
    high = int(np.searchsorted(times, moment + radius))
    if high <= low:
        return None, 0.0
    segment = strength[low:high]
    best = int(np.argmax(segment)) + low
    before = strength[best - 1] if best > 0 else strength[best]
    at = strength[best]
    after = strength[best + 1] if best + 1 < len(strength) else strength[best]
    curvature = before - 2 * at + after
    shift = 0.5 * (before - after) / curvature if abs(curvature) > 1e-12 else 0.0
    step = times[1] - times[0]
    return float(times[best] + np.clip(shift, -0.5, 0.5) * step), float(at)


def fit_beat_grid(times, strength, period, phase, rounds=GRID_ROUNDS):
    """
    Least squares through the onsets nearest the beats: t = phase + k * period.
    The onset envelope resolves 10 ms, but the fit over hundreds of beats reads
    the period to a hundredth of a BPM.
    """
    duration = float(times[-1])
    for _ in range(rounds):
        radius = BEAT_WINDOW_SHARE * period
        indices = []
        moments = []
        weights = []
        first = int(math.floor((times[0] - phase) / period))
        last = int(math.ceil((duration - phase) / period))
        for k in range(first, last + 1):
            beat = phase + k * period
            if beat - radius < 0 or beat + radius > duration:
                continue
            found, weight = peak_near(times, strength, beat, radius)
            if found is None:
                continue
            indices.append(k)
            moments.append(found)
            weights.append(weight)
        if len(indices) < 8:
            break
        indices = np.array(indices, dtype="float64")
        moments = np.array(moments)
        weights = np.array(weights)
        # A silent stretch has no onset; only the peaks that carry energy may vote.
        keep = weights > QUIET_ONSET_SHARE * np.percentile(weights, 75)
        if keep.sum() >= 8:
            indices, moments, weights = indices[keep], moments[keep], weights[keep]
        design = np.vstack([np.ones_like(indices), indices]).T
        root = np.sqrt(weights / weights.max())
        solution, *_ = np.linalg.lstsq(design * root[:, None], moments * root, rcond=None)
        phase, period = float(solution[0]), float(solution[1])
    return period, phase


def best_phase(times, strength, period):
    """The beat phase that collects the most onset strength, to 1 ms."""
    best = 0.0
    best_sum = -1.0
    for phase in np.arange(0.0, period, PHASE_STEP_SECONDS):
        beats = phase + np.arange(int(math.ceil((times[-1] - phase) / period))) * period
        total = float(strength_at(times, strength, beats).sum())
        if total > best_sum:
            best_sum = total
            best = float(phase)
    return best


def rms_db(signal, rate, start, end):
    """RMS level in dBFS over a window clamped to the file, or None if too little is left."""
    begin = max(0.0, start)
    finish = min(len(signal) / rate, end)
    if finish - begin < 0.2:
        return None
    chunk = signal[int(begin * rate) : int(finish * rate)]
    if len(chunk) == 0:
        return None
    return float(20 * np.log10(np.sqrt(np.mean(chunk**2)) + 1e-12))


def rank_lifts(signal, rate, downbeats):
    """For every downbeat, the loudness rise in dB from the 2 s before it to the 2 s after."""
    rows = []
    for downbeat in downbeats:
        before = rms_db(signal, rate, downbeat - LIFT_WINDOW_SECONDS, downbeat)
        after = rms_db(signal, rate, downbeat, downbeat + LIFT_WINDOW_SECONDS)
        if before is None or after is None:
            continue
        rows.append({"downbeat_s": round(downbeat, 3), "rise_db": round(after - before, 2), "level_after_db": round(after, 2)})
    rows.sort(key=lambda row: -row["rise_db"])
    return rows


def analyze(signal, rate):
    """Tempo, beat phase, downbeats and the ranked lifts of one bed."""
    times, strength = flux_envelope(signal.mean(axis=1) if signal.ndim > 1 else signal, rate)
    period = coarse_period(autocorrelation(strength), HOP / rate)
    period, phase = fit_beat_grid(times, strength, period, best_phase(times, strength, period))
    bpm = 60.0 / period
    beats = []
    k = int(math.ceil((times[0] - phase) / period))
    while True:
        moment = phase + k * period
        if moment > times[-1]:
            break
        beats.append((k, moment))
        k += 1
    # Every fourth beat is a downbeat; the phase of four whose beats carry the most onset wins.
    by_phase = [sum(strength_at(times, strength, moment) for k, moment in beats if k % DOWNBEAT_BEATS == index) for index in range(DOWNBEAT_BEATS)]
    chosen = int(np.argmax(by_phase)) if beats else 0
    downbeats = [moment for k, moment in beats if k % DOWNBEAT_BEATS == chosen]
    return {
        "bpm": round(bpm, 2),
        "bpm_exact": bpm,
        "period_s": round(period, 6),
        "first_beat_s": round(phase % period, 3),
        "beats": [round(moment, 3) for k, moment in beats],
        "downbeats": [round(moment, 3) for moment in downbeats],
        "lifts": rank_lifts(signal.mean(axis=1) if signal.ndim > 1 else signal, rate, downbeats),
    }


def loudness(path):
    """Integrated loudness in LUFS and true peak in dBTP, measured by ffmpeg."""
    result = run_tool(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"], f"measuring {path}")
    loudness_values = re.findall(r"I:\s+(-?[0-9.]+) LUFS", result.stderr)
    peak_values = re.findall(r"Peak:\s+(-?[0-9.]+) dBFS", result.stderr)
    if not loudness_values or not peak_values:
        raise SoundError(f"{path} is silent or too short, so ffmpeg ebur128 has no loudness to report")
    return float(loudness_values[-1]), float(peak_values[-1])


def write_wav(path, data):
    sf.write(path, data, SR, subtype="FLOAT")


def segment_loudness(data, tmp, name):
    path = os.path.join(tmp, f"{name}.wav")
    write_wav(path, data)
    lufs, _ = loudness(path)
    return lufs


def stretch_bed(source, measured_bpm, target_bpm, loader, tmp):
    """rubberband changes the tempo from the measured rate to the rate the film wants."""
    flat = os.path.join(tmp, "bed-48k.wav")
    write_wav(flat, loader(source))
    stretched = os.path.join(tmp, "bed-tempo.wav")
    run_tool(["rubberband", "--tempo", f"{measured_bpm:.3f}:{target_bpm:.3f}", flat, stretched], f"stretching {os.path.basename(source)} from {measured_bpm:.2f} to {target_bpm:.2f} BPM")
    return stretched


def cut_hits(data, rate):
    """Single hits from one continuous take, each 0.14 s with the tail faded out."""
    levels = envelope(data)
    peak = float(levels.max())
    if peak <= 0:
        return []
    threshold = peak * HIT_THRESHOLD
    minimum_gap = int(HIT_MINIMUM_GAP_SECONDS * rate)
    length = int(round(HIT_SECONDS * rate))
    fade = min(int(round(HIT_FADE_SECONDS * rate)), length)
    curve = (np.linspace(1, 0, fade) ** 2)[:, None]
    hits = []
    sample = 1
    while sample < len(levels):
        if levels[sample] > threshold and levels[sample - 1] <= threshold:
            hit = data[sample : sample + length]
            if len(hit) < length:
                hit = np.concatenate([hit, np.zeros((length - len(hit),) + hit.shape[1:])])
            hit = hit.copy()
            hit[-fade:] *= curve
            hits.append(hit)
            sample += minimum_gap
        else:
            sample += 1
    return hits


class CuePicker:
    """A family name gives the next file in round robin, or the next hit cut from a take."""

    def __init__(self, folder, loader):
        self.folder = folder
        self.loader = loader
        self.sets = {}

    def pick(self, name):
        """Returns (audio, label) for one cue; label goes in the report."""
        # A sheet is data: a name with a path in it must not read a file outside the sfx folder.
        if os.path.isabs(name) or name.startswith(".") or "/" in name or os.sep in name or (os.altsep and os.altsep in name):
            raise SoundError(f'cue sound "{name}": name a file or family in the sfx folder, without a path')
        if name.lower().endswith(".wav"):
            path = os.path.join(self.folder, name)
            if not os.path.exists(path):
                raise SoundError(f'cue sound "{name}": {path} does not exist')
            return self.loader(path), name
        entry = self.sets.get(name)
        if entry is None:
            files = sorted(glob.glob(os.path.join(self.folder, f"{name}-[0-9][0-9].wav")))
            if files:
                entry = {"audio": [self.loader(path) for path in files], "labels": [os.path.basename(path) for path in files]}
            else:
                takes = sorted(glob.glob(os.path.join(self.folder, f"{name}-take-*.wav")))
                single = os.path.join(self.folder, f"{name}.wav")
                if not takes and os.path.exists(single):
                    # A one-file sound (end-hit.wav) is named by its stem, like a family.
                    return self.pick(f"{name}.wav")
                if not takes:
                    raise SoundError(f'unknown sound "{name}": no {name}-NN.wav, {name}-take-NN.wav or {name}.wav in {self.folder}. Check the family name or the --sfx folder.')
                audio = []
                labels = []
                for take in takes:
                    for index, hit in enumerate(cut_hits(self.loader(take), SR)):
                        audio.append(hit)
                        labels.append(f"{os.path.basename(take)}#{index + 1}")
                if not audio:
                    raise SoundError(f"{name}-take-*.wav in {self.folder} holds no hits to cut")
                entry = {"audio": audio, "labels": labels}
            entry["index"] = 0
            self.sets[name] = entry
        index = entry["index"] % len(entry["audio"])
        entry["index"] += 1
        return entry["audio"][index], entry["labels"][index]


def place_cues(sheet, folder, total, rate, loader):
    """Every cue at its attack and its own peak, in order, so a family goes round robin."""
    picker = CuePicker(folder, loader)
    track = np.zeros((total, 2))
    rows = []
    for number, cue in enumerate(sheet["cues"], start=1):
        if cue["t"] >= sheet["duration"] - 1e-9:
            raise SoundError(f"cue {number} at {cue['t']} s is outside the film, which is {sheet['duration']} s long")
        audio, label = picker.pick(cue["sound"])
        peak = float(envelope(audio).max())
        if peak <= 0:
            raise SoundError(f"{label} is silent, so cue {number} has nothing to place")
        gain = 10 ** (cue["peak"] / 20.0) / peak
        placed = audio * gain
        start = int(round(cue["t"] * rate)) - attack_sample(audio)
        from_sample = 0
        if start < 0:
            from_sample = -start
            start = 0
        count = min(len(placed) - from_sample, total - start)
        if count > 0:
            track[start : start + count] += placed[from_sample : from_sample + count]
        rows.append({"t": cue["t"], "sound": cue["sound"], "file": label, "peak": cue["peak"], "peak_out": round(float(20 * np.log10(np.abs(placed).max())), 2)})
    return track, rows


def place_bed(sheet, path, total, rate, loader, tmp):
    """Back-time the biggest lift to music.liftAt, stretch to the film tempo, fade and level it."""
    music = sheet["music"]
    audio = read_48k(loader, path)
    if music.get("placeAt") is not None:
        # A composed score is rendered to the film's cue sheet: it starts with the film.
        return level_bed(audio, music, total, rate, tmp, music["placeAt"], {
            "file": os.path.basename(path), "placed": "score", "bpm_measured": None, "bpm_target": music.get("bpm"),
            "stretch_ratio": 1, "lift_in_bed_s": None,
        })
    measured = analyze(audio, rate)
    target = music.get("bpm") or measured["bpm_exact"]
    ratio = 1.0
    analysis = measured
    if abs(measured["bpm_exact"] - target) > 0.3:
        stretched = stretch_bed(path, measured["bpm_exact"], target, loader, tmp)
        audio = to_stereo(sf.read(stretched, always_2d=True, dtype="float64")[0])
        analysis = analyze(audio, rate)
        ratio = measured["bpm_exact"] / target
    if not analysis["lifts"]:
        raise SoundError(f"cannot find a lift in {path}: it has no downbeat with 2 s on both sides")
    lift = analysis["lifts"][0]["downbeat_s"]
    offset = lift - music["liftAt"]
    bed_duration = len(audio) / rate
    label = os.path.basename(path)
    if offset < -1e-9:
        raise SoundError(f"the biggest lift in {label} is at {lift:.3f} s, so it cannot land at {music['liftAt']:.3f} s of the film: the film would start {-offset:.1f} s before the bed does. Give a music.liftAt of at least {lift:.1f} s, or use a bed whose lift comes later.")
    if offset + sheet["duration"] > bed_duration + 1e-9:
        shortfall = offset + sheet["duration"] - bed_duration
        raise SoundError(f"the bed is {shortfall:.1f} s too short: the film needs {sheet['duration']:.1f} s from {offset:.1f} s in {label}, which is {bed_duration:.1f} s long. Use a longer bed or a later music.liftAt.")
    return level_bed(audio, music, total, rate, tmp, offset, {
        "file": label,
        "bpm_measured": round(measured["bpm_exact"], 2),
        "bpm_target": round(target, 2),
        "stretch_ratio": round(ratio, 4),
        "lift_in_bed_s": lift,
    })


def level_bed(audio, music, total, rate, tmp, offset, info):
    """Cut the bed from offset for the film's length, fade it and set it under the cues."""
    start = int(round(offset * rate))
    segment = audio[start : start + total].copy()
    if len(segment) < total:
        segment = np.vstack([segment, np.zeros((total - len(segment), 2))])
    fade_in = min(int(round(music["fadeIn"] * rate)), total)
    fade_out = min(int(round(music["fadeOut"] * rate)), total - fade_in)
    if fade_in > 0:
        segment[:fade_in] *= (np.linspace(0, 1, fade_in) ** 2)[:, None]
    if fade_out > 0:
        segment[-fade_out:] *= (np.linspace(1, 0, fade_out) ** 2)[:, None]
    before = segment_loudness(segment, tmp, "bed-segment")
    gain_db = BED_LEVEL_LUFS + music["underCuesDb"] - before
    info = {
        **info,
        "offset_s": round(offset, 3),
        "lufs_before_fader": round(before, 1),
        "lufs_after_fader": round(BED_LEVEL_LUFS + music["underCuesDb"], 1),
        "gain_db": round(gain_db, 2),
    }
    return segment * 10 ** (gain_db / 20.0), info


# ffmpeg's alimiter refuses a limit under 0.0625 (-24 dB), so a deeper reduction
# would fail inside ffmpeg instead of protecting the ceiling.
LIMITER_MIN = 0.0625


def deeper_limit(limit, over_db):
    """A lower limiter threshold for a peak that is over_db above the ceiling, never under ffmpeg's minimum."""
    return max(limit * 10 ** (-over_db / 20.0), LIMITER_MIN)


def write_master(premaster, out, gain_db, limit):
    """Gain, then a limiter that oversamples, so the true peak stays under the ceiling."""
    filter_chain = f"volume={gain_db:.3f}dB,aresample=192000,alimiter=limit={limit:.6f}:attack=1:release=60:level=false:latency=true,aresample={SR}"
    run_tool(["ffmpeg", "-v", "error", "-y", "-i", premaster, "-af", filter_chain, "-ar", str(SR), "-c:a", "pcm_s24le", out], f"writing the master {out}")


def master_to_target(premaster, out, target, ceiling, before, before_peak):
    """
    Gain to the loudness target under the true peak ceiling. The limiter spends
    part of every gain step, and the measured loudness says how much, so each
    round asks for the gain that lands on the target with the same spend. Three
    rounds are enough; a last render protects the ceiling if it is still over.
    The gain never asks the limiter for more than MAX_LIMIT_DB: a mix that
    cannot reach the target then is peak-bound and stays under it.
    """
    gain_cap = ceiling - before_peak + MAX_LIMIT_DB
    gain_db = min(target - before, gain_cap)
    limit = 10 ** (ceiling / 20.0)
    lufs = before
    peak = before
    rounds = 0
    for rounds in range(1, MASTER_ROUNDS + 1):
        write_master(premaster, out, gain_db, limit)
        lufs, peak = loudness(out)
        if peak <= ceiling + 1e-9 and (abs(lufs - target) <= LOUDNESS_TOLERANCE or (gain_db >= gain_cap - 1e-9 and lufs < target)):
            break
        # What the limiter took out of this gain step: the loudness fell short of it.
        spent = max(before + gain_db - lufs, 0.0)
        if peak > ceiling:
            limit = deeper_limit(limit, peak - ceiling + 0.05)
        gain_db = min(max(target - before + spent, -30.0), 40.0, gain_cap)
    guarded = False
    if peak > ceiling + 1e-9:
        # The ceiling wins: a mix never leaves above the delivery limit.
        limit = deeper_limit(limit, peak - ceiling + 0.1)
        write_master(premaster, out, gain_db, limit)
        lufs, peak = loudness(out)
        guarded = True
    peak_bound = gain_db >= gain_cap - 1e-9 and lufs < target - LOUDNESS_TOLERANCE
    limiter_db = max(before_peak + gain_db - peak, 0.0)
    return {"gain_db": gain_db, "lufs": lufs, "peak": peak, "rounds": rounds, "guarded": guarded, "peak_bound": peak_bound, "limiter_db": limiter_db}


def job_tempo(job):
    loader = Loader(job["tmp"])
    audio = read_48k(loader, job["file"])
    analysis = analyze(audio, SR)
    analysis.pop("bpm_exact")
    return {"file": os.path.abspath(job["file"]), "duration_s": round(len(audio) / SR, 3), **analysis}


def job_backtime(job):
    loader = Loader(job["tmp"])
    audio = read_48k(loader, job["file"])
    analysis = analyze(audio, SR)
    bed_duration = len(audio) / SR
    if not analysis["lifts"]:
        raise SoundError(f"cannot find a lift in {job['file']}: it has no downbeat with 2 s on both sides")
    lift = analysis["lifts"][0]["downbeat_s"]
    offset = lift - job["lift_at"]
    label = os.path.basename(job["file"])
    if offset < -1e-9:
        raise SoundError(f"the biggest lift is at {lift:.3f} s, so it cannot land at {job['lift_at']:.1f} s of the film: the film would start {-offset:.1f} s before {label} does. Give a later --lift-at, or a bed whose lift comes later.")
    if offset + job["duration"] > bed_duration + 1e-9:
        shortfall = offset + job["duration"] - bed_duration
        raise SoundError(f"the bed is {shortfall:.1f} s too short: the film needs {job['duration']:.1f} s from {offset:.1f} s in {label}, which is {bed_duration:.1f} s long. Use a longer bed or a later --lift-at.")
    return {
        "file": os.path.abspath(job["file"]),
        "bed_duration_s": round(bed_duration, 3),
        "lift_in_bed_s": lift,
        "lift_at_s": job["lift_at"],
        "offset_s": round(offset, 3),
        "duration_s": job["duration"],
        "fits": True,
    }


def job_mix(job):
    sheet = job["sheet"]
    tmp = job["tmp"]
    loader = Loader(tmp)
    total = int(round(sheet["duration"] * SR))
    fx, rows = place_cues(sheet, job["sfx"], total, SR, loader)
    sf.write(f"{job['out']}.fx.wav", fx, SR, subtype="FLOAT")
    bed = np.zeros((total, 2))
    bed_info = None
    if job["bed"]:
        bed, bed_info = place_bed(sheet, job["bed"], total, SR, loader, tmp)
    premaster = fx + bed
    if float(envelope(premaster).max()) <= 0:
        raise SoundError("the mix is silent: the cue sheet has no cues and no --bed was given, so there is nothing to master")
    pre_path = os.path.join(tmp, "premaster.wav")
    write_wav(pre_path, premaster)
    before, before_peak = loudness(pre_path)
    master = master_to_target(pre_path, job["out"], job["target"], job["true_peak"], before, before_peak)
    measured_lufs = master["lufs"]
    measured_peak = master["peak"]
    gain_db = master["gain_db"]
    rounds = master["rounds"]
    report = {
        "out": os.path.abspath(job["out"]),
        "fx": os.path.abspath(f"{job['out']}.fx.wav"),
        "duration_s": sheet["duration"],
        "target_lufs": job["target"],
        "ceiling_dbtp": job["true_peak"],
        "premaster_lufs": round(before, 2),
        "premaster_true_peak": round(before_peak, 2),
        "gain_db": round(gain_db, 2),
        "limit_rounds": rounds,
        "master_lufs": round(measured_lufs, 2),
        "master_true_peak": round(measured_peak, 2),
        "within_tolerance": measured_peak <= job["true_peak"] + 1e-9 and abs(measured_lufs - job["target"]) <= LOUDNESS_TOLERANCE,
        "ceiling_guard_render": master["guarded"],
        "peak_bound": master["peak_bound"],
        "limiter_db": round(master["limiter_db"], 2),
        "bed": bed_info,
        "cues": rows,
    }
    with open(f"{job['out']}.report.json", "w") as handle:
        json.dump(report, handle, indent=1)
        handle.write("\n")
    return report


COMMANDS = {"tempo": job_tempo, "backtime": job_backtime, "mix": job_mix}


def main(argv):
    if not argv:
        print("ERROR: sound.py needs the path of a job JSON file", file=sys.stderr)
        return 3
    try:
        with open(argv[0]) as handle:
            job = json.load(handle)
        command = COMMANDS.get(job.get("command"))
        if command is None:
            raise SoundError(f'unknown job "{job.get("command")}": use tempo, backtime or mix')
        result = command(job)
    except SoundError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 3
    except (KeyError, ValueError, TypeError) as error:
        print(f"ERROR: the job is incomplete: {error}", file=sys.stderr)
        return 3
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
