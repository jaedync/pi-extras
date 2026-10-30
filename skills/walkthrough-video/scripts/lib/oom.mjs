/**
 * Raise wv's own OOM score at start. Chromium, ffmpeg and the score's Python
 * inherit it, so when RAM runs out the kernel stops the render before the
 * user's editor, agent or model proxy. Raising needs no privilege; lowering
 * does, so a score that is already higher stays.
 */
import { readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_OOM_SCORE_ADJ = 500;
const OOM_FILE = "/proc/self/oom_score_adj";
const MAX_OOM_SCORE_ADJ = 1000;

function targetFrom(env) {
	const raw = env.WV_OOM_SCORE_ADJ;
	if (raw === undefined || raw === "") return { target: DEFAULT_OOM_SCORE_ADJ };
	if (raw === "off") return { target: null };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > MAX_OOM_SCORE_ADJ) {
		return { error: `WV_OOM_SCORE_ADJ must be "off" or an integer from 0 to ${MAX_OOM_SCORE_ADJ}, not "${raw}"` };
	}
	return { target: value };
}

export function raiseOomScore({
	platform = process.platform,
	env = process.env,
	read = () => readFileSync(OOM_FILE, "utf8"),
	write = (value) => writeFileSync(OOM_FILE, value),
} = {}) {
	if (platform !== "linux") return { changed: false };
	const { target, error } = targetFrom(env);
	if (error) return { changed: false, error };
	if (target === null) return { changed: false };
	try {
		const from = Number.parseInt(read().trim(), 10);
		if (Number.isFinite(from) && from >= target) return { changed: false, from, to: from };
		write(String(target));
		return { changed: true, from, to: target };
	} catch (cause) {
		return { changed: false, error: `could not raise the OOM score: ${cause?.message ?? cause}` };
	}
}
