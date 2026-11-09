/**
 * Mines fix commits for slop patterns: each changed file is scanned before and after the fix with the catalog,
 * and a rule whose sites a fix removed (or added) is evidence that the pattern takes part in real bugs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scan } from "./ast-grep.mjs";

export const SOURCE_EXTENSIONS = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|py)$/;
export const FIX_SUBJECT = "^(fix|bugfix|hotfix)(\\([^)]*\\))?!?:";
const MAX_BLOB = 2 * 1024 * 1024;

/** @param {string} root @param {string[]} args @param {string} [input] */
function git(root, args, input) {
	const result = spawnSync("git", ["-C", root, ...args], { input, maxBuffer: 1024 * 1024 * 1024, timeout: 5 * 60_000 });
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.toString().trim() || result.error?.message}`);
	return result.stdout;
}

/**
 * @param {string} root
 * @param {number} limit
 * @returns {{ sha: string, subject: string, foundBy: string[] }[]}
 */
export function fixCommits(root, limit) {
	const out = git(root, ["log", "--no-merges", "-E", "-i", `--grep=${FIX_SUBJECT}`, `-n${limit}`,
		"--format=%H%x1f%s%x1f%(trailers:key=Found-by,valueonly,separator=%x2c)%x1e"]).toString();
	return out.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
		const [sha, subject, trailers] = record.split("\x1f");
		return { sha, subject, foundBy: (trailers ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean) };
	}).filter(({ subject }) => new RegExp(FIX_SUBJECT, "i").test(subject));
}

/**
 * Reads many blobs in one `git cat-file --batch` call.
 * @param {string} root
 * @param {string[]} specs `<rev>:<path>` names
 * @returns {(Buffer | null)[]}
 */
export function readBlobs(root, specs) {
	if (!specs.length) return [];
	const out = git(root, ["cat-file", "--batch"], `${specs.join("\n")}\n`);
	/** @type {(Buffer | null)[]} */
	const blobs = [];
	let at = 0;
	for (let i = 0; i < specs.length; i++) {
		const end = out.indexOf(0x0a, at);
		const header = out.subarray(at, end).toString();
		at = end + 1;
		const match = /^\S+ (\w+) (\d+)$/.exec(header);
		if (!match) { blobs.push(null); continue; }
		const size = Number(match[2]);
		blobs.push(match[1] === "blob" && size <= MAX_BLOB ? out.subarray(at, at + size) : null);
		at += size + 1;
	}
	return blobs;
}

/** @param {string} root @param {string} sha */
function changedFiles(root, sha) {
	const out = git(root, ["diff-tree", "--no-commit-id", "-r", "--root", "--no-renames", "--name-only", sha]).toString();
	return out.split("\n").filter((path) => SOURCE_EXTENSIONS.test(path));
}

/**
 * @param {{ command: string, args: string[] }} tool
 * @param {{ root: string, config: string, limit: number }} options
 */
export function mineHistory(tool, { root, config, limit }) {
	const commits = fixCommits(root, limit);
	const work = mkdtempSync(join(tmpdir(), "code-slop-history-"));
	try {
		/** @type {{ side: "before" | "after", sha: string, path: string, spec: string }[]} */
		const wanted = [];
		for (const { sha } of commits) {
			for (const path of changedFiles(root, sha)) {
				wanted.push({ side: "before", sha, path, spec: `${sha}^:${path}` }, { side: "after", sha, path, spec: `${sha}:${path}` });
			}
		}
		const blobs = readBlobs(root, wanted.map(({ spec }) => spec));
		wanted.forEach(({ side, sha, path }, i) => {
			const blob = blobs[i];
			if (!blob) return;
			const target = join(work, side, sha, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, blob);
		});
		mkdirSync(join(work, "before"), { recursive: true });
		mkdirSync(join(work, "after"), { recursive: true });
		const { findings } = scan(tool, { config, cwd: work, paths: ["before", "after"] });
		return summarize(commits, findings);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {{ sha: string, subject: string, foundBy: string[] }[]} commits
 * @param {{ ruleId: string, file: string }[]} findings files as `<before|after>/<sha>/<path>`
 */
export function summarize(commits, findings) {
	/** @type {Map<string, { before: number, after: number }>} */
	const sites = new Map();
	for (const { ruleId, file } of findings) {
		const [side, sha, ...rest] = file.split("/");
		const key = `${ruleId}\0${sha}\0${rest.join("/")}`;
		const entry = sites.get(key) ?? { before: 0, after: 0 };
		if (side === "before") entry.before++; else entry.after++;
		sites.set(key, entry);
	}
	const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
	/** @type {Record<string, { removedIn: Set<string>, addedIn: Set<string>, sitesRemoved: number, sitesAdded: number }>} */
	const rules = {};
	for (const [key, { before, after }] of sites) {
		const [ruleId, sha] = key.split("\0");
		const rule = (rules[ruleId] ??= { removedIn: new Set(), addedIn: new Set(), sitesRemoved: 0, sitesAdded: 0 });
		if (before > after) { rule.removedIn.add(sha); rule.sitesRemoved += before - after; }
		if (after > before) { rule.addedIn.add(sha); rule.sitesAdded += after - before; }
	}
	/** @param {Set<string>} shas */
	const foundBy = (shas) => {
		/** @type {Record<string, number>} */
		const counts = {};
		for (const sha of shas) for (const value of bySha.get(sha)?.foundBy.length ? bySha.get(sha)?.foundBy ?? [] : ["none"]) counts[value] = (counts[value] ?? 0) + 1;
		return counts;
	};
	return {
		commits: commits.length,
		withFoundBy: commits.filter((commit) => commit.foundBy.length).length,
		rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, rule]) => [id, {
			fixesRemoving: rule.removedIn.size, sitesRemoved: rule.sitesRemoved, removingFoundBy: foundBy(rule.removedIn),
			fixesAdding: rule.addedIn.size, sitesAdded: rule.sitesAdded,
			examples: [...rule.removedIn].slice(0, 3).map((sha) => `${sha.slice(0, 7)} ${bySha.get(sha)?.subject ?? ""}`),
		}])),
	};
}
