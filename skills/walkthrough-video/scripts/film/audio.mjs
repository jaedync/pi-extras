/**
 * Sound facts from ffmpeg, for wv check and wv measure: EBU R128 loudness
 * (integrated, range, true peak), momentary loudness, clipped samples, the
 * longest quiet gap and digital silence.
 */
import { failed, run } from "../lib/proc.mjs";

/** Runs ffmpeg through the tracked runner: a signal stops it, and its stderr is the report. */
async function ffmpegStderr(args, what, timeoutMs = 10 * 60_000) {
	// The audio cap is 256 MB: a long film's ebur128 report is large, and a truncated one gives wrong numbers.
	const r = await run("ffmpeg", ["-hide_banner", "-nostats", ...args], { timeoutMs, maxBuffer: 256 << 20 });
	const reason = failed(r, Math.max(1, Math.round(timeoutMs / 60_000)));
	if (reason) throw new Error(`ffmpeg ${what} failed: ${reason}`);
	return r.stderr;
}

/** Parses the summary that ebur128 prints at the end. */
export function parseEbur128(text) {
	const summary = text.slice(text.lastIndexOf("Summary:"));
	const pick = (re) => {
		const m = re.exec(summary);
		return m ? Number(m[1]) : null;
	};
	return { lufs: pick(/I:\s+(-?[0-9.]+|-inf) LUFS/), lra: pick(/LRA:\s+(-?[0-9.]+) LU/), truePeak: pick(/Peak:\s+(-?[0-9.]+|-inf) dBFS/) };
}

/** The momentary loudness (400 ms window) that ebur128 prints every 100 ms. */
export function parseMomentary(text) {
	return [...text.matchAll(/\bt:\s*([0-9.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[0-9.]+|-inf)/g)].map((m) => ({ t: Math.round(Number(m[1]) * 1000) / 1000, m: m[2] === "-inf" ? -120.7 : Number(m[2]) }));
}

/** Momentary loudness under this is room tone or less: the film sounds empty. */
export const QUIET_LUFS = -30;
/** Momentary loudness under this counts as -70, so silence does not inflate a jump. */
const FLOOR_LUFS = -70;

/**
 * The sound floor: the share of the film under QUIET_LUFS momentary, and the
 * largest rise of momentary loudness over the lowest level of the 3 s before
 * it (an end hit after near silence startles; over a bed it lands). The first
 * 0.4 s are skipped: the window is not full yet.
 */
export function soundFloor(points, { quietLufs = QUIET_LUFS, windowS = 3 } = {}) {
	const usable = points.filter((p) => p.t >= 0.4 - 1e-9);
	if (!usable.length) return { quietShare: 0, jumpLu: 0, jumpAt: null };
	const level = (p) => Math.max(FLOOR_LUFS, p.m);
	let jumpLu = 0;
	let jumpAt = null;
	for (const [i, p] of usable.entries()) {
		let floor = Infinity;
		for (let j = i - 1; j >= 0 && usable[j].t >= p.t - windowS - 1e-9; j--) floor = Math.min(floor, level(usable[j]));
		if (Number.isFinite(floor) && level(p) - floor > jumpLu) {
			jumpLu = level(p) - floor;
			jumpAt = p.t;
		}
	}
	const quiet = usable.filter((p) => p.m < quietLufs).length;
	return { quietShare: Math.round((quiet / usable.length) * 1000) / 1000, jumpLu: Math.round(jumpLu * 100) / 100, jumpAt };
}

/** Integrated loudness, loudness range, true peak and the momentary series of the first audio stream. */
export async function loudness(file, { timeoutMs = 10 * 60_000 } = {}) {
	const text = await ffmpegStderr(["-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], "ebur128", timeoutMs);
	return { ...parseEbur128(text), momentary: parseMomentary(text) };
}

/**
 * Samples at full scale: astats gives the peak level and how often a channel
 * reached it. A peak under -0.1 dBFS counts as no clipping.
 */
export async function clippedSamples(file) {
	const text = await ffmpegStderr(["-i", file, "-map", "0:a:0", "-af", "astats=measure_overall=Peak_level+Peak_count:measure_perchannel=none", "-f", "null", "-"], "astats");
	const level = Number(/Peak level dB:\s*(-?[0-9.]+|-inf)/.exec(text.slice(text.lastIndexOf("Overall")))?.[1] ?? "-inf");
	const count = Number(/Peak count:\s*([0-9.]+)/.exec(text.slice(text.lastIndexOf("Overall")))?.[1] ?? 0);
	return Number.isFinite(level) && level > -0.1 ? count : 0;
}

/** Digital silence: a window under this RMS level carries nothing a speaker plays. */
export const SILENCE_DB = -60;

/** Runs of windows under SILENCE_DB: [{ from, to }] in seconds. */
export function silenceRuns(levels, windowS = 0.1, threshold = SILENCE_DB) {
	const runs = [];
	let start = null;
	levels.forEach((level, i) => {
		if (level < threshold) start ??= i;
		else if (start !== null) {
			runs.push({ from: start * windowS, to: i * windowS });
			start = null;
		}
	});
	if (start !== null) runs.push({ from: start * windowS, to: levels.length * windowS });
	return runs;
}

/** RMS level of each 100 ms window, dBFS (-200 for digital zero). */
export async function windowLevels(file) {
	const text = await ffmpegStderr(["-i", file, "-map", "0:a:0", "-af", "aresample=8000,asetnsamples=800,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"], "astats windows");
	return [...text.matchAll(/RMS_level=(-?[0-9.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -200 : Number(m[1])));
}

/**
 * The longest run of 100 ms windows under -50 dBFS, in seconds, and their
 * share of the film; and the digital silence (under -60 dBFS): its share, its
 * longest run and the runs.
 */
export async function quietGaps(file, levels = null) {
	const windows = levels ?? (await windowLevels(file));
	let longest = 0;
	let run = 0;
	let quiet = 0;
	for (const level of windows) {
		if (level < -50) {
			run++;
			quiet++;
			longest = Math.max(longest, run);
		} else run = 0;
	}
	const silence = silenceRuns(windows);
	const silent = silence.reduce((sum, r) => sum + r.to - r.from, 0);
	return {
		longestS: longest * 0.1,
		share: windows.length ? quiet / windows.length : 0,
		silence,
		silenceShare: windows.length ? Math.round((silent / (windows.length * 0.1)) * 1000) / 1000 : 0,
		silenceLongestS: Math.round(Math.max(0, ...silence.map((r) => r.to - r.from)) * 1000) / 1000,
	};
}
