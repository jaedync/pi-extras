// Reads git history to measure how often files change and which files change together.
// Co-change with no import between the files is the classic sign of a hidden link
// (evolutionary coupling, Gall et al. 1998).
import { execFileSync } from "node:child_process";

// Commits that touch more files than this are mostly releases, renames and
// formatting runs: they say nothing about which pieces belong together.
export const DEFAULT_MAX_FILES_PER_COMMIT = 25;
const COMMIT_MARK = "\x01"; // git prints it from %x01; no path holds that byte

/**
 * File lists of the commits since `since`, newest first, paths relative to root.
 * Returns null when root is not in a git checkout.
 * @param {string} root @param {{ since?: string }} [options]
 * @returns {string[][] | null}
 */
export function readCommits(root, { since = "12 months ago" } = {}) {
	let prefix;
	try {
		prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
	const out = execFileSync(
		"git",
		["log", "--no-merges", "--no-renames", `--since=${since}`, "--format=format:%x01", "--name-only", "--", "."],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 },
	);
	return out
		.split(COMMIT_MARK)
		.map((block) => block.split("\n").map((l) => l.trim()).filter(Boolean))
		.filter((files) => files.length > 0)
		.map((files) => files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)));
}

/**
 * Number of commits that touched each file.
 * @param {string[][]} commits @param {Set<string>} [only] limit to these files
 */
export function churn(commits, only) {
	const counts = new Map();
	for (const files of commits) {
		for (const file of files) {
			if (!only || only.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * Pairs of files that change in the same commits.
 * confidence = shared commits / commits of the less-changed file of the pair.
 * @param {string[][]} commits
 * @param {{ only?: Set<string>, minShared?: number, minConfidence?: number, maxFilesPerCommit?: number }} [options]
 */
export function coChangePairs(commits, { only, minShared = 3, minConfidence = 0.5, maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT } = {}) {
	const usable = commits
		.map((files) => [...new Set(files.filter((f) => !only || only.has(f)))].sort())
		.filter((files) => files.length > 0 && files.length <= maxFilesPerCommit);
	const counts = churn(usable);
	const shared = new Map();
	for (const files of usable) {
		for (let i = 0; i < files.length; i++) {
			for (let j = i + 1; j < files.length; j++) {
				const key = `${files[i]}\n${files[j]}`;
				shared.set(key, (shared.get(key) ?? 0) + 1);
			}
		}
	}
	const pairs = [];
	for (const [key, count] of shared) {
		const [a, b] = key.split("\n");
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
