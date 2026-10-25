/**
 * The newest release of Pi, of an npm package, and of a git repository.
 * Git repositories with semver tags `v*` update to the newest tag, not to
 * the branch head; a repository without such tags follows its default
 * branch. Every lookup has a time limit and fails with a sanitized line.
 */
import { describeFailure, type Runner } from "./run.ts";

export const LOOKUP_TIMEOUT_MS = 60_000;

export interface Semver {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly pre: string | undefined;
	/** Without the `v`. */
	readonly text: string;
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(text: string): Semver | undefined {
	const match = text.trim().match(SEMVER);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4], text: text.trim().replace(/^v/, "").replace(/\+.*$/, "") };
}

function comparePre(a: string | undefined, b: string | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	const left = a.split(".");
	const right = b.split(".");
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const x = left[index];
		const y = right[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x) ? Number(x) : undefined;
		const ny = /^\d+$/.test(y) ? Number(y) : undefined;
		if (nx !== undefined && ny !== undefined && nx !== ny) return nx - ny;
		if (nx === undefined || ny === undefined) {
			if (nx !== undefined) return -1;
			if (ny !== undefined) return 1;
			if (x !== y) return x < y ? -1 : 1;
		}
	}
	return 0;
}

export function compareSemver(a: Semver, b: Semver): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

export interface GitRelease {
	/** The tag's version; undefined when the release is the default branch head. */
	readonly version: string | undefined;
	/** The tag name, or `HEAD`. */
	readonly ref: string;
	readonly commit: string;
	/** The store id: `0.30.0-1a2b3c4`, or `head-1a2b3c4`. */
	readonly id: string;
}

const SHA = /^[0-9a-f]{40,64}$/;

async function lsRemote(args: readonly string[], runner: Runner): Promise<string> {
	const result = await runner("git", ["ls-remote", ...args], { timeoutMs: LOOKUP_TIMEOUT_MS });
	if (result.code !== 0) throw new Error(`git ls-remote failed: ${describeFailure(result)}`);
	return result.stdout;
}

/** Tag name -> commit; a peeled `^{}` line (an annotated tag) names the commit and wins. */
function tagCommits(output: string): Map<string, string> {
	const tags = new Map<string, string>();
	for (const line of output.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !ref?.startsWith("refs/tags/") || !SHA.test(sha)) continue;
		const peeled = ref.endsWith("^{}");
		const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
		if (peeled || !tags.has(name)) tags.set(name, sha);
	}
	return tags;
}

async function headRelease(url: string, runner: Runner): Promise<GitRelease> {
	const output = await lsRemote([url, "HEAD"], runner);
	const sha = output.split("\n").map((line) => line.trim().split(/\s+/)).find(([, ref]) => ref === "HEAD")?.[0];
	if (!sha || !SHA.test(sha)) throw new Error("git ls-remote found no HEAD");
	return { version: undefined, ref: "HEAD", commit: sha, id: `head-${sha.slice(0, 7)}` };
}

export async function newestGit(url: string, mode: "tags" | "head", runner: Runner, options: { prereleases: boolean }): Promise<GitRelease> {
	if (mode === "head") return headRelease(url, runner);
	// Not --refs: an annotated tag needs its peeled line to give the commit.
	const tags = tagCommits(await lsRemote(["--tags", url], runner));
	let best: { semver: Semver; name: string; commit: string } | undefined;
	for (const [name, commit] of tags) {
		if (!name.startsWith("v")) continue;
		const semver = parseSemver(name);
		if (!semver || (semver.pre !== undefined && !options.prereleases)) continue;
		if (!best || compareSemver(semver, best.semver) > 0) best = { semver, name, commit };
	}
	if (!best) return headRelease(url, runner);
	return { version: best.semver.text, ref: best.name, commit: best.commit, id: `${best.semver.text}-${best.commit.slice(0, 7)}` };
}

async function npmJson(args: readonly string[], runner: Runner): Promise<unknown> {
	const result = await runner("npm", ["view", ...args, "--json"], { timeoutMs: LOOKUP_TIMEOUT_MS });
	if (result.code !== 0) throw new Error(`npm view failed: ${describeFailure(result)}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error("npm view printed no JSON");
	}
}

/**
 * The newest version of an npm package: its `latest` tag, or, with a
 * minimum age, the newest stable version not newer than `latest` that is
 * old enough. Undefined when no version is old enough.
 */
export async function newestNpm(name: string, runner: Runner, options: { minAgeHours: number; now: number }): Promise<string | undefined> {
	if (options.minAgeHours <= 0) {
		const version = await npmJson([name, "version"], runner);
		if (typeof version !== "string" || !parseSemver(version)) throw new Error(`npm view gave no version for ${name}`);
		return version;
	}
	const info = (await npmJson([name, "dist-tags", "time"], runner)) as { "dist-tags"?: { latest?: unknown }; time?: Record<string, unknown> } | undefined;
	const latest = typeof info?.["dist-tags"]?.latest === "string" ? parseSemver(info["dist-tags"].latest) : undefined;
	if (!latest || !info?.time) throw new Error(`npm view gave no release times for ${name}`);
	const limit = options.now - options.minAgeHours * 3_600_000;
	let best: Semver | undefined;
	for (const [text, when] of Object.entries(info.time)) {
		const semver = parseSemver(text);
		const at = typeof when === "string" ? Date.parse(when) : Number.NaN;
		if (!semver || semver.pre !== undefined || !(at <= limit) || compareSemver(semver, latest) > 0) continue;
		if (!best || compareSemver(semver, best) > 0) best = semver;
	}
	return best?.text;
}
