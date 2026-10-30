/**
 * The HyperFrames frame cache: where it lives, how large a render will make it,
 * and the folder one render owns. HyperFrames extracts every rendered frame to
 * `<tmpdir>/hyperframes-extract-cache-<uid>` and keeps it after the render. A 35 s
 * 1080p render is about 2000 frames, and a few of them fill a 20 GB tmpfs: the
 * render then fails with "Unknown system error -122" (EDQUOT) and no hint.
 *
 * Each render gets its own folder inside that cache, because the cache can be a
 * folder the user shares (the refusal asks for one on a disk with space), and a
 * render may delete only what it wrote.
 * Pure functions here, so the numbers, the cut-off and the folder are tested.
 */
import { existsSync, mkdirSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Filesystem names for "do not cache", as HyperFrames accepts them. */
const CACHE_OFF = ["off", "none", "false", "0", "no"];

/**
 * The extraction cache that HyperFrames will use: its environment override, or
 * its default for this user. Null when caching is turned off.
 */
export function extractCacheDir(env = process.env, tmp = tmpdir(), uid = process.getuid?.() ?? "u") {
	const set = env.HYPERFRAMES_EXTRACT_CACHE_DIR;
	if (typeof set === "string" && set.trim() !== "") {
		const value = set.trim();
		return CACHE_OFF.includes(value.toLowerCase()) ? null : value;
	}
	return join(tmp, `hyperframes-extract-cache-${uid}`);
}

/** Bytes a render will extract: one RGBA frame per frame of the composition. */
export function estimateCacheBytes(plan) {
	const fps = plan.fps ?? 60;
	const seconds = (plan.edit?.start ?? 0) + (plan.edit?.duration ?? 0) + (plan.outroS ?? 0);
	const frames = Math.ceil(seconds * fps);
	const output = plan.output ?? { width: 1920, height: 1080 };
	return frames * (output.width ?? 1920) * (output.height ?? 1080) * 4;
}

/**
 * Bytes a film render extracts: HyperFrames caches the frames of source
 * videos only (a film without clips caches nothing), as PNG. One byte a pixel
 * is above what UI captures measure (0.2 to 0.5), so the check stays safe
 * without refusing a small render. Each shot: { seconds, clip?: { width, height } }.
 */
export function estimateFilmCacheBytes({ fps, shots }) {
	return shots.reduce((sum, shot) => (shot.clip ? sum + (Math.ceil(shot.seconds * fps) + 1) * shot.clip.width * shot.clip.height : sum), 0);
}

export const formatGB = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The nearest folder that exists at or above `path`: the one whose filesystem holds it. */
export function nearestExisting(path) {
	let dir = path;
	while (dir && !existsSync(dir)) {
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return dir || tmpdir();
}

/** Free bytes on the filesystem that holds `path`, or the nearest parent that exists. */
export function freeBytes(path) {
	const stats = statfsSync(nearestExisting(path));
	return stats.bavail * stats.bsize;
}

/**
 * The refusal for a render whose frame cache does not fit, or null when it does.
 * The numbers and the path are the whole point: an agent cannot free space it
 * cannot name.
 */
export function spaceRefusal({ needed, free, cacheDir, tmp = tmpdir() }) {
	if (needed <= free) return null;
	// Name the filesystem that holds the cache, not the temp folder: the user may have moved it.
	const where = nearestExisting(cacheDir || tmp);
	return (
		`${where} is full: ${formatGB(needed)} needed, ${formatGB(free)} free. ` +
		`HyperFrames extracts every rendered frame to ${cacheDir}. ` +
		"Fix: run the command again with TMPDIR=<a folder on a disk with space> (for example TMPDIR=/var/tmp/wv-tmp; create it first), or set HYPERFRAMES_EXTRACT_CACHE_DIR to such a folder."
	);
}

/**
 * The cache folder one render owns, inside the cache the user chose:
 * `wv-<pid>-<start time>`. Two renders never share it, so a cleanup can never
 * take another render's frames or another program's files.
 */
export function makeRenderCacheDir(base, { pid = process.pid, now = Date.now() } = {}) {
	if (!base) return null;
	const dir = join(base, `wv-${pid}-${now}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Removes one render's own folder, and nothing beside it. */
export function removeRenderCacheDir(dir) {
	if (!dir) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}
