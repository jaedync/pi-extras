/**
 * Frame facts that wv check and wv measure read from a rendered film, with
 * ffmpeg doing the decoding:
 *
 * - `repeats`: which frames repeat the picture before them. This is ffmpeg's
 *   mpdecimate test (no 8x8 block changes visibly), the same instrument that
 *   measured the golden film, so a slow drift that moves less than the eye can
 *   see counts as a repeat and a small cursor move does not.
 * - `diffs`: the mean change of each frame from the one before it, on a small
 *   grey copy (0 to 255 levels).
 * - `blend`: whether one frame is a mix of its two neighbours (a ghost of the
 *   other shot that a motion-blur sampler draws across a cut).
 */
import { spawnSync } from "node:child_process";
import { failed, run, spawnChild } from "../lib/proc.mjs";

export const SMALL = { width: 320, height: 180 };

/** fps, frame count, size and whether there is an audio stream. */
export function probeVideo(file) {
	const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", file], { encoding: "utf8", timeout: 60000 });
	if (r.error || r.status !== 0) throw new Error(`ffprobe cannot read ${file}: ${(r.stderr || r.error?.message || "").trim()}`);
	const info = JSON.parse(r.stdout);
	const video = (info.streams ?? []).find((s) => s.codec_type === "video");
	if (!video) throw new Error(`${file} has no video stream`);
	const [num, den] = String(video.r_frame_rate).split("/").map(Number);
	const fps = den ? num / den : num;
	const duration = Number(info.format?.duration ?? 0);
	const frames = Number(video.nb_frames) || Math.round(duration * fps);
	return { fps, frames, width: video.width, height: video.height, duration, audio: (info.streams ?? []).some((s) => s.codec_type === "audio") };
}

/** Indices of the frames that mpdecimate drops: each one repeats the last frame it kept. */
export async function repeatedFrames(file, fps) {
	const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-v", "info", "-i", file, "-an", "-vf", "mpdecimate,showinfo", "-f", "null", "-"], { timeoutMs: 20 * 60_000 });
	const reason = failed(r, 20);
	if (reason) throw new Error(`ffmpeg mpdecimate failed on ${file}: ${reason}`);
	const kept = new Set();
	for (const match of r.stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([0-9.]+)/g)) kept.add(Math.round(Number(match[1]) * fps));
	return kept;
}

/** Streams the film as small grey frames; calls onFrame(index, pixels) in order. */
export function eachSmallFrame(file, onFrame, size = SMALL) {
	const bytes = size.width * size.height;
	return new Promise((resolve, reject) => {
		const ff = spawnChild("ffmpeg", ["-v", "error", "-i", file, "-an", "-vf", `scale=${size.width}:${size.height}:flags=area,format=gray`, "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "pipe"] });
		let pending = Buffer.alloc(0);
		let index = 0;
		let stderr = "";
		ff.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		ff.stdout.on("data", (chunk) => {
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			while (pending.length >= bytes) {
				onFrame(index++, new Uint8Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + bytes)));
				pending = pending.subarray(bytes);
			}
		});
		ff.on("error", reject);
		ff.on("close", (code) => (code === 0 ? resolve(index) : reject(new Error(`ffmpeg could not decode ${file}: ${stderr.trim().split("\n").pop()}`))));
	});
}

export function meanAbsDiff(a, b) {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / a.length;
}

/**
 * How well frame g is a mix of a and b: the best share `alpha` of a in
 * alpha*a + (1-alpha)*b, the mean error of that mix, and how far g is from b
 * (its own shot). A ghost frame has 0 < alpha < 1, a small mix error, and a
 * large distance from b.
 */
export function blend(a, g, b) {
	let num = 0;
	let den = 0;
	for (let i = 0; i < g.length; i++) {
		const ab = a[i] - b[i];
		num += (g[i] - b[i]) * ab;
		den += ab * ab;
	}
	const alpha = den > 0 ? num / den : 0;
	let err = 0;
	let far = 0;
	for (let i = 0; i < g.length; i++) {
		err += Math.abs(g[i] - (alpha * a[i] + (1 - alpha) * b[i]));
		far += Math.abs(g[i] - b[i]);
	}
	return { alpha, err: err / g.length, far: far / g.length, contrast: Math.sqrt(den / g.length) };
}

/**
 * One pass over the film: the per-frame diffs and the frames around each cut
 * (two before, two after) for the ghost test.
 */
export async function frameFacts(file, { cuts = [] } = {}) {
	const probe = probeVideo(file);
	const keep = new Set();
	for (const cut of cuts) for (let k = cut - 2; k <= cut + 1; k++) keep.add(k);
	const near = new Map();
	const diffs = [0];
	let previous = null;
	const count = await eachSmallFrame(file, (index, pixels) => {
		if (previous) diffs.push(meanAbsDiff(previous, pixels));
		previous = pixels;
		if (keep.has(index)) near.set(index, pixels);
	});
	const kept = await repeatedFrames(file, probe.fps);
	const repeats = Array.from({ length: count }, (_, i) => i > 0 && !kept.has(i));
	return { ...probe, frames: count, diffs, repeats, near };
}
