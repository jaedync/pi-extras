"""hit_timing.py WAV t1 t2 ... - measure the onset of each planned hit in a WAV.
The WAV is split into three bands (30-200 Hz, 200-2000 Hz, 2-12 kHz); each hit is measured in the band
where it rises most, so a kick under a cymbal swell or a marimba note over a ringing chord still shows.
Envelope: RMS over 1 ms, step 0.25 ms. The band only finds the event; the onset time is then read on the
broadband peak envelope (0.25 ms steps, no filter delay): the first step that is 3 dB above the level 6 to
25 ms before and at least a quarter of the peak in the next 30 ms. In a +-25 ms window around the planned time, find the steepest
rise (level 4 ms after minus level 1 ms before), then the onset is the first step where the level is
6 dB above the level 3 to 15 ms before that rise. Prints planned time, measured onset, error (ms),
rise (dB) and the frame number at the rate the caller gives (60 fps by default). A hit passes when |error| <= 10 ms and rise >= 3 dB."""
import sys, json, numpy as np, soundfile as sf
from scipy import signal
def measure(path, times):
    x, sr = sf.read(path, always_2d=True); m0 = x.mean(1)
    hop = sr // 4000; win = sr // 1000
    ms = lambda v: int(round(v * 4))
    curves = []
    for name, lo_hz, hi_hz in (("low", 30, 200), ("mid", 200, 2000), ("high", 2000, 12000)):
        sos = signal.butter(4, [lo_hz, hi_hz], "bandpass", fs=sr, output="sos")
        m = signal.sosfiltfilt(sos, m0)
        p = np.convolve(m ** 2, np.ones(win) / win, "same")[::hop]
        curves.append((name, p, 10 * np.log10(p + 1e-14)))
    pk = np.abs(m0)[:len(m0) // hop * hop].reshape(-1, hop).max(1)
    rows = []
    for t in times:
      best = None
      for bname, p, db in curves:
        c = int(round(t * 4000)); lo, hi = c - ms(25), c + ms(25)
        if lo - ms(25) < 0 or hi + ms(30) > len(db):
            # A negative index reads from the end of the array, so an edge hit would be measured
            # against the wrong audio: refuse it and say where the hit must sit.
            raise ValueError(f"the hit at {t} s is too near the start or end of {path} to measure: keep it 30 ms inside the file")
        rise = [db[i + ms(4)] - db[i - ms(1)] for i in range(lo, hi)]
        i0 = lo + int(np.argmax(rise))
        pre = 10 * np.log10(np.mean(p[i0 - ms(15):i0 - ms(3)]) + 1e-14)
        j = i0 - ms(5)
        while j < i0 + ms(10) and db[j] < pre + 3: j += 1
        on = j / 4000.0
        post = 10 * np.log10(np.mean(p[j:j + ms(30)]) + 1e-14)
        pre_bb = np.percentile(pk[i0 - ms(25):i0 - ms(6)], 95); peak = pk[i0 - ms(2):i0 + ms(30)].max()
        thr = max(1.41 * pre_bb, 0.25 * peak); j = i0 - ms(10)
        while j < i0 + ms(10) and pk[j] < thr: j += 1
        on = j / 4000.0
        r = dict(planned=t, onset=round(on, 4), err_ms=round((on - t) * 1000, 2), rise_db=round(post - pre, 1),
                 band=bname, frame=round(t * 60), ok=bool(abs(on - t) <= 0.010 and post - pre >= 3))
        if best is None or r["rise_db"] > best["rise_db"]: best = r
      rows.append(best)
    return rows
if __name__ == "__main__":
    rows = measure(sys.argv[1], [float(a) for a in sys.argv[2:]])
    for r in rows: print("%7.3f s  frame %4d  onset %8.4f  err %6.2f ms  rise %5.1f dB  %-4s %s" % (r["planned"], r["frame"], r["onset"], r["err_ms"], r["rise_db"], r["band"], "PASS" if r["ok"] else "FAIL"))
    print(json.dumps(rows))
