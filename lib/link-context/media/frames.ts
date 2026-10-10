/**
 * Frames for the model to look at. A few frames come back one by one at a
 * readable size; more are tiled into contact sheets of up to 12, each frame
 * stamped with its time, so a minute of video costs one image. ffmpeg only
 * cuts the frames; the helper stamps and tiles them with Pillow, whose
 * built-in font works on hosts without system fonts. Every frame is also
 * saved unstamped at full size for a closer look with the read tool.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../text.ts";
import type { ImageBlock } from "../types.ts";

export const MAX_FRAMES = 48;
export const SHEET_SIZE = 12;
const SINGLE_LIMIT = 4;
const SINGLE_WIDTH = 1280;
const FULL_WIDTH = 1280;
const TILE_WIDTH = 384;

export interface ComposeRequest {
	readonly mode: "singles" | "sheet";
	readonly frames: readonly { path: string; label: string; out?: string }[];
	readonly width: number;
	readonly columns?: number;
	readonly out?: string;
}

export type Compose = (request: ComposeRequest) => Promise<unknown>;

/** Evenly spaced sample times inside [start, end), centred in each slot so the first is not a fade-in. */
export function sampleTimes(start: number, end: number, count: number): number[] {
	const span = Math.max(0, end - start);
	const n = Math.max(1, Math.min(count, MAX_FRAMES));
	if (span <= 0) return [start];
	return Array.from({ length: n }, (_, i) => Math.round((start + ((i + 0.5) * span) / n) * 100) / 100);
}

/** Columns for a sheet: square-ish for few frames, four wide from seven up. */
export function sheetColumns(count: number): number {
	return count <= 4 ? count : count <= 6 ? 3 : 4;
}

function ffmpeg(binary: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"], signal });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() ?? code}`))));
	});
}

export interface FrameResult {
	readonly images: ImageBlock[];
	readonly files: string[];
	readonly caption: string;
}

const image = (file: string): ImageBlock => ({ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/jpeg" });

/** One frame: `at` is the time in the original video; `video` starts at `offset` in it (a clip, or 0 for the whole file). */
export interface FrameSource {
	readonly video: string;
	readonly at: number;
	readonly offset: number;
}

export async function extractFrames(binary: string, sources: readonly FrameSource[], dir: string, compose: Compose, signal?: AbortSignal): Promise<FrameResult> {
	mkdirSync(dir, { recursive: true });
	const files: string[] = [];
	const times = sources.map((source) => source.at);
	for (const [i, source] of sources.entries()) {
		const file = join(dir, `frame-${String(i + 1).padStart(2, "0")}-${clock(source.at).replace(/:/g, "m")}s.jpg`);
		await ffmpeg(binary, ["-ss", String(Math.max(0, source.at - source.offset)), "-protocol_whitelist", "file", "-i", source.video, "-frames:v", "1", "-q:v", "3", "-vf", `scale='min(${FULL_WIDTH},iw)':-2`, file], signal);
		files.push(file);
	}
	const labelled = files.map((path, i) => ({ path, label: clock(times[i]) }));
	if (files.length <= SINGLE_LIMIT) {
		const frames = labelled.map((frame, i) => ({ ...frame, out: join(dir, `.stamped-${i + 1}.jpg`) }));
		await compose({ mode: "singles", frames, width: SINGLE_WIDTH });
		return { images: frames.map((frame) => image(frame.out)), files, caption: `${files.length} frame${files.length === 1 ? "" : "s"} at ${times.map(clock).join(", ")}` };
	}
	const images: ImageBlock[] = [];
	const lines: string[] = [];
	for (let sheet = 0; sheet * SHEET_SIZE < labelled.length; sheet++) {
		const group = labelled.slice(sheet * SHEET_SIZE, (sheet + 1) * SHEET_SIZE);
		const columns = sheetColumns(group.length);
		const out = join(dir, `sheet-${sheet + 1}.jpg`);
		await compose({ mode: "sheet", frames: group, width: TILE_WIDTH, columns, out });
		images.push(image(out));
		const rows = Math.ceil(group.length / columns);
		lines.push(`sheet ${sheet + 1}: ${group.length} frames in ${rows} row${rows === 1 ? "" : "s"} of ${columns}, read left to right, top to bottom, at ${group.map((frame) => frame.label).join(", ")}`);
	}
	return { images, files, caption: lines.join("\n") };
}
