// Reads git history to measure how often files change and which files change together.
// Co-change with no import between the files is the classic sign of a hidden link
// (evolutionary coupling, Gall et al. 1998).
import { execFileSync } from "node:child_process";

// Commits that touch more files than this are mostly releases, renames and
// formatting runs: they say nothing about which pieces belong together.
export const DEFAULT_MAX_FILES_PER_COMMIT = 25;
const COMMIT_MARK = "\x01"; // git prints it from %x01; no path holds that byte
const DAY = 86400;

/** @typedef {{ time: number, size: number, files: string[] }} Commit */

/** @param {string} cwd @param {string[]} args */
function gitText(cwd, args) {
	return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
		cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024,
	});
}

/**
 * Where root sits in its git checkout. Null when root is not in a checkout or
 * the checkout has no commit yet.
 * @param {string} root
 */
export function gitPlace(root) {
	try {
		const top = gitText(root, ["rev-parse", "--show-toplevel"]).trim();
		const prefix = gitText(root, ["rev-parse", "--show-prefix"]).trim();
		const head = gitText(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
		return { top, prefix, head };
	} catch {
		return null; // not a checkout, or no commit: the caller skips history
	}
}

/**
 * Commits since `since`, newest first. `size` counts every file of the commit in
 * the whole repository; `files` holds only the files under root, relative to root.
 * @param {string} root @param {{ since?: string }} [options]
 * @returns {{ head: string, prefix: string, top: string, commits: Commit[] } | null}
 */
export function readHistory(root, { since = "12 months ago" } = {}) {
	const place = gitPlace(root);
	if (!place) return null;
	const out = gitText(place.top, ["log", "--no-merges", "--no-renames", `--since=${since}`, "--format=format:%x01%ct", "--name-only"]);
	const commits = out
		.split(COMMIT_MARK)
		.map((block) => block.split("\n").map((l) => l.trim()).filter(Boolean))
		.filter((lines) => lines.length > 0)
		.map(([time, ...all]) => ({
			time: Number(time),
			size: all.length,
			files: all.filter((f) => f.startsWith(place.prefix)).map((f) => f.slice(place.prefix.length)),
		}));
	return { ...place, commits };
}

/**
 * The time each file under root was first added, from the whole history, not
 * only the window: a file that has not changed for years is old, not unknown.
 * @param {{ top: string, prefix: string }} place
 * @returns {Map<string, number>} paths relative to root
 */
export function firstAdded({ top, prefix }) {
	const out = gitText(top, ["log", "--diff-filter=A", "--no-renames", "--format=format:%x01%ct", "--name-only", "--", prefix || "."]);
	const born = new Map();
	for (const block of out.split(COMMIT_MARK)) {
		const [time, ...files] = block.split("\n").map((l) => l.trim()).filter(Boolean);
		for (const file of files) {
			if (!file.startsWith(prefix)) continue;
			const key = file.slice(prefix.length);
			born.set(key, Math.min(born.get(key) ?? Infinity, Number(time)));
		}
	}
	return born;
}

/**
 * Number of commits that touched each file, and the time of its first commit in the window.
 * @param {Commit[]} commits @param {(file: string) => string | null} [keyOf] map a file to a module, or to null to leave it out
 */
export function churn(commits, keyOf = (f) => f) {
	const counts = new Map();
	const first = new Map();
	for (const { time, files } of commits) {
		for (const key of new Set(files.map(keyOf))) {
			if (key === null) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
			first.set(key, Math.min(first.get(key) ?? Infinity, time));
		}
	}
	return { counts, first };
}

/**
 * Changes per 30 days over the part of the window in which the file existed.
 * A span under one month counts as one month, so a new file is not called
 * stable for having few changes.
 * @param {number} changes in the window @param {number} born first added
 * @param {number} windowStart time of the oldest commit in the window @param {number} now seconds
 */
export function changeRate(changes, born, windowStart, now) {
	return changes / Math.max((now - Math.max(born, windowStart)) / (30 * DAY), 1);
}

/** @param {number} firstTime @param {number} now */
export function ageDays(firstTime, now) {
	return (now - firstTime) / DAY;
}

/**
 * Pairs of files that change in the same commits.
 * confidence = shared commits / commits of the less-changed file of the pair.
 * @param {Commit[]} commits
 * @param {{ keyOf?: (file: string) => string | null, minShared?: number, minConfidence?: number, maxFilesPerCommit?: number }} [options]
 *   keyOf maps a file to its module, or to null to leave it out
 */
export function coChangePairs(commits, { keyOf = (f) => f, minShared = 3, minConfidence = 0.5, maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT } = {}) {
	const usable = commits
		.filter((c) => c.size <= maxFilesPerCommit)
		.map((c) => [...new Set(c.files.map(keyOf).filter((k) => k !== null))].sort())
		.filter((keys) => keys.length > 0);
	const counts = new Map();
	const shared = new Map();
	for (const keys of usable) {
		for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
		for (let i = 0; i < keys.length; i++) {
			for (let j = i + 1; j < keys.length; j++) {
				const pair = `${keys[i]}\n${keys[j]}`;
				shared.set(pair, (shared.get(pair) ?? 0) + 1);
			}
		}
	}
	const pairs = [];
	for (const [pair, count] of shared) {
		const [a, b] = pair.split("\n");
		const confidence = count / Math.min(counts.get(a), counts.get(b));
		if (count >= minShared && confidence >= minConfidence) {
			pairs.push({ a, b, shared: count, changesA: counts.get(a), changesB: counts.get(b), confidence: round(confidence) });
		}
	}
	return pairs.sort((x, y) => y.shared - x.shared || y.confidence - x.confidence || x.a.localeCompare(y.a));
}

/** @param {number} n */
export function round(n) {
	return Math.round(n * 100) / 100;
}
