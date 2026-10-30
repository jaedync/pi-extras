/**
 * The review sheets, built from plan.json alone: one beat sheet, one phone sheet
 * and exactly one seam sheet per shot cut. HyperFrames' own `snapshot --review`
 * treats every caption and every beat marker as a scene, so a 7-shot video got 26
 * seam sheets and two minutes of work. Here the cut list is the shot list, so a
 * shot is one idea and a cut is one cut. The stills come from one `snapshot --at`
 * call; the sheets are ffmpeg tiles, which is fast and needs no image library.
 */

/** A beat shows the shot just after it starts, so a move has landed. */
export const BEAT_SETTLE_S = 0.3;
/** A second beat at the middle of a shot only when it is far enough from the first. */
export const BEAT_MID_GAP_S = 0.5;
/** The five frames across a cut: two before, the cut, two after. */
export const SEAM_OFFSETS = [-0.2, -0.1, 0, 0.1, 0.2];
/** Two times closer than this are the same moment. */
export const SAME_TIME_S = 0.05;
export const BEAT_PAGE = 16;
export const BEAT_COLS = 4;
export const BEAT_CELL_PX = 480;
export const PHONE_CELL_PX = 360;
export const PHONE_COLS = 3;
export const SEAM_CELL_PX = 384;

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The times a shot list asks for: beats in every shot, and one seam per shot cut. */
export function reviewTimes(plan) {
	const start = plan.edit?.start ?? 0;
	const total = start + (plan.edit?.duration ?? 0) + (plan.outroS ?? 0);
	const last = Math.max(0.02, total - 0.02);
	const at = (t) => clamp(round3(t), 0, last);
	const shots = Array.isArray(plan.shots) && plan.shots.length
		? plan.shots.map((shot) => ({ start: shot.start, end: shot.end }))
		: (plan.beats ?? []).map((beat, i) => ({ start: beat.t, end: plan.beats[i + 1]?.t ?? total }));
	const beats = [];
	const seams = [];
	shots.forEach((shot, i) => {
		const label = `shot ${i + 1}`;
		const settled = at(shot.start + BEAT_SETTLE_S);
		beats.push({ t: settled, label });
		const mid = at((shot.start + shot.end) / 2);
		if (mid - settled >= BEAT_MID_GAP_S) beats.push({ t: mid, label: `${label} mid` });
	});
	const cuts = [{ t: shots[0]?.start ?? start, from: "intro", to: "shot 1" }];
	shots.slice(1).forEach((shot, i) => cuts.push({ t: shot.start, from: `shot ${i + 1}`, to: `shot ${i + 2}` }));
	const outro = start + (plan.edit?.duration ?? 0);
	if (plan.outroS > 0) cuts.push({ t: outro, from: `shot ${shots.length}`, to: "outro" });
	for (const cut of cuts) {
		const t = at(cut.t);
		if (t <= start + SAME_TIME_S || t >= last - SAME_TIME_S) continue;
		seams.push({ ...cut, t, times: SEAM_OFFSETS.map((offset) => at(t + offset)) });
	}
	// One capture per distinct moment: a beat that lands on a seam offset is captured once.
	const times = [];
	const add = (t, what) => {
		if (times.some((time) => Math.abs(time - t) < SAME_TIME_S)) return;
		times.push(t);
	};
	for (const beat of beats) add(beat.t, beat.label);
	for (const seam of seams) for (const t of seam.times) add(t, "seam");
	return { start, total, beats, seams, times: times.sort((a, b) => a - b) };
}

/** The ffmpeg arguments that scale one still to a cell width and burn its time in. */
export function labelArgs({ src, out, label, cellWidth }) {
	return ["-v", "error", "-y", "-i", src, "-vf", `scale=${cellWidth}:-2,drawtext=text='${label}':x=10:y=10:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6`, out];
}

/** The ffmpeg arguments that tile a numbered PNG sequence into one sheet. */
export function tileArgs({ dir, count, cols, out }) {
	const rows = Math.max(1, Math.ceil(count / cols));
	return ["-v", "error", "-y", "-framerate", "1", "-i", `${dir}/cell-%03d.png`, "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=black`, "-frames:v", "1", out];
}

/** Splits the beats into sheet pages: [{items, name}] with `name` = review-beats-1, ... */
export function beatPages(beats, page = BEAT_PAGE) {
	const pages = [];
	for (let i = 0; i < beats.length; i += page) pages.push({ items: beats.slice(i, i + page), number: pages.length + 1 });
	return pages.map((entry) => ({ ...entry, name: pages.length > 1 ? `review-beats-${entry.number}` : "review-beats" }));
}

/** The time label of a still: one decimal, no trailing zero ("2.5s", "0s"). */
export function timeLabel(t) {
	const value = Number(t.toFixed(1));
	return `${value}s`;
}
