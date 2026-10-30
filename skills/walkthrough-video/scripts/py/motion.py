"""Frame to frame camera estimator for the walkthrough-video film kit.

Reads a rendered film and reports what the camera did inside each shot: the
magnification, the pan in frame widths, and the moves (start, end and the point
where the speed peaked). The model is a per-frame similarity from ORB matches
fitted with RANSAC, accumulated into one matrix per shot and reset at every cut.
A dense ECC translation fit over a scale search is the fallback for flat UI,
where ORB has too few matches. The magnification is read from the Jacobian of
the accumulated map at the frame centre, so a perspective frame gives a local
magnification instead of a fake average scale. A homography is fitted on the
same matches only to diagnose perspective.

Port of the calibrated reference instrument (motion3.py plus camera() from
final3.py), with the paths replaced by arguments.

Usage:
    python -I motion.py <video> --cuts <cuts.json> [--out <file>]

The cuts file holds {"fps": 60, "cuts": [120, 240]} where each number is the
first frame of a new shot; an empty list means one shot. Without --out the JSON
goes to stdout. Progress goes to stderr every 10 % of the frames.
"""
import argparse
import json
import sys

import cv2
import numpy as np

# The host has 20 cores; 6 keep one measure from starving a render.
cv2.setNumThreads(6)

ANALYSIS_WIDTH = 800

ORB = cv2.ORB_create(nfeatures=2500, fastThreshold=6, scaleFactor=1.2, nlevels=8)
MATCHER = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
RATIO = 0.8
ECC_CRITERIA = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 120, 1e-6)
ECC_WIDTH = 480
ECC_MIN_CORRELATION = 0.5

# Per-frame sanity limits. They are on the log scale, which a 0.5 s window would
# break but a single frame never does.
MIN_STEP_SCALE = 0.92
MAX_STEP_SCALE = 1.09
MAX_STEP_ROTATION_DEG = 1.5
MAX_STEP_SHIFT = 0.30
MIN_INLIERS = 30

# Move detector: a step counts as moving above these speeds per second.
PAN_THRESHOLD = 0.02
ZOOM_THRESHOLD = 0.05
MIN_MOVE_SECONDS = 0.20
MERGE_GAP_SECONDS = 0.25

# A shot whose corner scales spread by more than this is perspective, not a zoom.
PERSPECTIVE_LIMIT = 1.15
PERSPECTIVE_PROBES = ((0.1, 0.1), (0.9, 0.1), (0.1, 0.9), (0.9, 0.9))


def fail(message):
    print(f"motion: {message}", file=sys.stderr)
    raise SystemExit(2)


def jac_scale(H, x, y, eps=2.0):
    """sqrt(|det J|) of the plane map H at (x, y): the local length magnification."""
    def mapped(u, v):
        q = H @ np.array([u, v, 1.0])
        return q[0] / q[2], q[1] / q[2]

    x0, y0 = mapped(x - eps, y)
    x1, y1 = mapped(x + eps, y)
    u0, v0 = mapped(x, y - eps)
    u1, v1 = mapped(x, y + eps)
    J = np.array([[(x1 - x0) / (2 * eps), (u1 - u0) / (2 * eps)],
                  [(y1 - y0) / (2 * eps), (v1 - v0) / (2 * eps)]])
    return float(np.sqrt(abs(np.linalg.det(J))))


def perspective_spread(H, width, height):
    """Largest ratio between the corner magnifications of H, or None if unusable."""
    corner = jac_scale(H, width / 2.0, height / 2.0)
    probes = [jac_scale(H, px * width, py * height) for px, py in PERSPECTIVE_PROBES]
    if min(probes) <= 0 or abs(np.log(corner / np.median(probes))) >= 0.2:
        return None
    return max(probes) / min(probes)


def estimate(ga, gb):
    """Return (H, inliers, persp) with H the similarity that maps ga onto gb.

    inliers is -1 for the ECC fallback. persp stays 1.0 when no homography could
    be trusted.
    """
    persp = 1.0
    k1, d1 = ORB.detectAndCompute(ga, None)
    k2, d2 = ORB.detectAndCompute(gb, None)
    if d1 is not None and d2 is not None and len(k1) > 20 and len(k2) > 20:
        pairs = MATCHER.knnMatch(d1, d2, k=2)
        good = [m for m, n in (q for q in pairs if len(q) == 2) if m.distance < RATIO * n.distance]
        if len(good) >= 12:
            p1 = np.float32([k1[m.queryIdx].pt for m in good])
            p2 = np.float32([k2[m.trainIdx].pt for m in good])
            S, mask = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC,
                                                 ransacReprojThreshold=2.5, maxIters=4000, confidence=0.999)
            if S is not None and mask is not None and int(mask.sum()) >= 20:
                H, _hm = cv2.findHomography(p1, p2, cv2.RANSAC, 2.5, maxIters=2000, confidence=0.99)
                if H is not None:
                    spread = perspective_spread(H, ga.shape[1], ga.shape[0])
                    if spread is not None:
                        persp = spread
                return np.vstack([S, [0, 0, 1]]), int(mask.sum()), float(persp)
    # Fallback for flat UI: search the scale that maximises a translation-only fit.
    try:
        h, w = ga.shape
        hp, wp = int(h * float(ECC_WIDTH) / w), ECC_WIDTH
        a4 = cv2.resize(ga, (wp, hp), interpolation=cv2.INTER_AREA).astype(np.float32)
        b4 = cv2.resize(gb, (wp, hp), interpolation=cv2.INTER_AREA).astype(np.float32)
        best = None
        for sc in np.arange(0.985, 1.016, 0.0025):
            M = cv2.getRotationMatrix2D((wp / 2.0, hp / 2.0), 0, sc)
            ar = cv2.warpAffine(a4, M, (wp, hp), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
            w2 = np.eye(2, 3, dtype=np.float32)
            try:
                cc, w2 = cv2.findTransformECC(ar, b4, w2, cv2.MOTION_TRANSLATION, ECC_CRITERIA, None, 3)
            except cv2.error:
                continue
            if best is None or cc > best[0]:
                best = (cc, sc, w2)
        if best is not None and best[0] > ECC_MIN_CORRELATION:
            _cc, sc, w2 = best
            # Map the 480 px fit back to the analysis width. Kept as the
            # reference instrument had it, so the numbers stay comparable.
            k = ANALYSIS_WIDTH / float(wp)
            H = np.array([[sc, 0, w2[0, 2] / k], [0, sc, w2[1, 2] / k], [0, 0, 1]], dtype=np.float64)
            return H, -1, 1.0
    except cv2.error:
        pass
    return None, 0, 1.0


def read_cuts(path):
    """(cut frames, fps) from the cuts file; the fps is None when it is not a number."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as error:
        fail(f"cannot read the cuts file {path}: {error.strerror}")
    except json.JSONDecodeError as error:
        fail(f"the cuts file {path} is not JSON: {error}")
    raw = data.get("cuts") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        fail(f'the cuts file {path} needs {{"fps": <number>, "cuts": [<frame>, ...]}}')
    for value in raw:
        if not isinstance(value, int) or isinstance(value, bool):
            fail(f'the cuts file {path} has {json.dumps(value)}, which is not a whole frame number')
    cut_fps = data.get("fps")
    return sorted(set(raw)), cut_fps if isinstance(cut_fps, (int, float)) and not isinstance(cut_fps, bool) else None


def shot_bounds(cut_frames, frames):
    """[start, end) frame pairs. A cut on frame 0 or past the end is not a cut."""
    edges = [0] + [c for c in cut_frames if 0 < c < frames] + [frames]
    return list(zip(edges, edges[1:]))


def analyse(video, cut_frames):
    """(per-frame series, frame count, fps) of the film."""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        fail(f"cannot open the video {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    expected = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    series = []
    C = np.eye(3)
    prev = None
    cut_set = set(cut_frames)
    index = 0
    next_percent = 10
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        height = int(round(frame.shape[0] * ANALYSIS_WIDTH / frame.shape[1]))
        grey = cv2.cvtColor(cv2.resize(frame, (ANALYSIS_WIDTH, height)), cv2.COLOR_BGR2GRAY)
        height = grey.shape[0]
        cx, cy = ANALYSIS_WIDTH / 2.0, height / 2.0
        t = index / fps
        if index in cut_set:
            C = np.eye(3)  # no accumulation across a cut
        if prev is None or index in cut_set:
            series.append((index, t, 1.0, 0.0, 0.0, 1, 1.0))
        else:
            H, inliers, persp = estimate(prev, grey)
            valid = 0
            if H is not None:
                scale = float(np.hypot(H[0, 0], H[1, 0]))
                angle = abs(np.degrees(np.arctan2(H[1, 0], H[0, 0])))
                tx, ty = abs(H[0, 2]) / ANALYSIS_WIDTH, abs(H[1, 2]) / height
                sane = (MIN_STEP_SCALE < scale < MAX_STEP_SCALE and angle < MAX_STEP_ROTATION_DEG
                        and tx < MAX_STEP_SHIFT and ty < MAX_STEP_SHIFT
                        and (inliers >= MIN_INLIERS or inliers == -1))
                if sane:
                    C = C @ np.linalg.inv(H)
                    valid = 1
            else:
                persp = 1.0
            zoom = 1.0 / max(jac_scale(C, cx, cy), 1e-9)
            q = C @ np.array([cx, cy, 1.0])
            series.append((index, t, zoom, (q[0] / q[2] - cx) / ANALYSIS_WIDTH,
                           (q[1] / q[2] - cy) / ANALYSIS_WIDTH, valid, persp))
        prev = grey
        index += 1
        total = expected if expected > 0 else 0
        if total:
            while index * 100 >= next_percent * total:
                print(f"  motion {min(next_percent, 100)}% ({index}/{total} frames)", file=sys.stderr)
                next_percent += 10
    cap.release()
    if index == 0:
        fail(f"the video {video} has no readable frames")
    return series, index, float(fps)


def shot_steps(rows):
    """(times, pan widths/s, |log zoom|/s) for each frame step inside one shot.

    The pan speed is the speed at which the camera's distance from its position
    at the shot start grows, as in the reference instrument (motion3.py: the
    radial distance, hypot(dx, dy)). The signed vertical offset alone reads a
    sideways pan as no motion and an upward pan as a negative one.
    """
    steps = []
    if not rows:
        empty = np.zeros(0)
        return empty, empty, empty
    x0, y0 = rows[0][3], rows[0][4]
    for before, after in zip(rows, rows[1:]):
        dt = after[1] - before[1]
        if dt <= 0:
            continue
        moved = (np.hypot(after[3] - x0, after[4] - y0)
                 - np.hypot(before[3] - x0, before[4] - y0)) / dt
        steps.append((after[1], float(moved),
                      abs(np.log(after[2] / max(before[2], 1e-9))) / dt))
    return (np.array([s[0] for s in steps]), np.array([s[1] for s in steps]),
            np.array([s[2] for s in steps]))


def shot_moves(times, pan, zoom):
    """(moves, moving steps) of one shot: moves are [{start, end, peak_at}] in seconds."""
    moving = (pan > PAN_THRESHOLD) | (zoom > ZOOM_THRESHOLD)
    runs = []
    i = 0
    while i < len(moving):
        if moving[i]:
            j = i
            while j + 1 < len(moving) and moving[j + 1]:
                j += 1
            runs.append((i, j))
            i = j + 1
        else:
            i += 1
    merged = []
    for a, b in runs:
        if merged and times[a] - times[merged[-1][1]] < MERGE_GAP_SECONDS:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    moves = []
    for a, b in merged:
        if times[b] - times[a] < MIN_MOVE_SECONDS:
            continue
        peak_at = None
        window = np.maximum(pan[a:b + 1] / PAN_THRESHOLD, zoom[a:b + 1] / ZOOM_THRESHOLD)
        if len(window) >= 3:
            peak_at = round(float(np.argmax(window)) / (len(window) - 1), 3)
        moves.append({"start": round(float(times[a]), 3), "end": round(float(times[b]), 3), "peak_at": peak_at})
    return moves, int(moving.sum()), len(moving)


def measure(video, cut_frames):
    """The whole measure: shots, their motion, the moves and the film totals."""
    series, frames, fps = analyse(video, cut_frames)
    shots = []
    moves = []
    moving_steps = 0
    all_steps = 0
    for start, end in shot_bounds(cut_frames, frames):
        rows = [row for row in series if start <= row[0] < end]
        if not rows:
            continue
        z0, x0, y0 = rows[0][2], rows[0][3], rows[0][4]
        zooms = [row[2] / z0 for row in rows]
        pans = [float(np.hypot(row[3] - x0, row[4] - y0)) for row in rows]
        times, pan_speeds, zoom_speeds = shot_steps(rows)
        moves_of_shot, moving, steps = shot_moves(times, pan_speeds, zoom_speeds)
        shot = {
            "start": round(start / fps, 3),
            "end": round(end / fps, 3),
            "valid_frac": round(sum(row[5] for row in rows) / len(rows), 3),
            "zoom_max": round(max(zooms), 3),
            "zoom_min": round(min(zooms), 3),
            "pan_max": round(max(pans), 3),
            "persp_median": round(float(np.median([row[6] for row in rows])), 3),
            "moves": moves_of_shot,
        }
        shots.append(shot)
        moves.extend(moves_of_shot)
        moving_steps += moving
        all_steps += steps
    durations = [move["end"] - move["start"] for move in moves]
    peaks = [move["peak_at"] for move in moves if move["peak_at"] is not None]
    return {
        "fps": round(fps, 3),
        "duration": round(frames / fps, 3),
        "frames": frames,
        "shots": shots,
        "moves_n": len(moves),
        "time_in_move_share": round(moving_steps / all_steps, 3) if all_steps else 0,
        "move_dur_median_s": round(float(np.median(durations)), 2) if durations else 0,
        "move_dur_p90_s": round(float(np.percentile(durations, 90)), 2) if durations else 0,
        "ease_peak_median": round(float(np.median(peaks)), 3) if peaks else None,
        "zoom_max_in_shot": round(max((shot["zoom_max"] for shot in shots), default=1), 3),
        "pan_max_in_shot_widths": round(max((shot["pan_max"] for shot in shots), default=0), 3),
        "perspective_flagged": any(shot["persp_median"] > PERSPECTIVE_LIMIT for shot in shots),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Measure the camera motion of a rendered film.")
    parser.add_argument("video", help="the film to measure")
    parser.add_argument("--cuts", required=True, help='JSON file: {"fps": 60, "cuts": [120, 240]}')
    parser.add_argument("--out", help="write the JSON here instead of stdout")
    args = parser.parse_args(argv)
    cut_frames, cut_fps = read_cuts(args.cuts)
    result = measure(args.video, cut_frames)
    if cut_fps is not None and abs(cut_fps - result["fps"]) > 0.005 * result["fps"]:
        print(f"  motion: the cuts file says {cut_fps} fps, the video is {result['fps']} fps; frames are used as given",
              file=sys.stderr)
    text = json.dumps(result, indent=1)
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
        except OSError as error:
            fail(f"cannot write {args.out}: {error.strerror}")
    else:
        print(text)


if __name__ == "__main__":
    main()
