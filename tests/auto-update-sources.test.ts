import assert from "node:assert/strict";
import test from "node:test";
import { applySet, classify, entrySource, restoreOriginals, withSource } from "../lib/auto-update/sources.ts";
import { compareSemver, newestGit, newestNpm, parseSemver } from "../lib/auto-update/versions.ts";
import type { RunResult, Runner } from "../lib/auto-update/run.ts";
import type { UpdateSet } from "../lib/auto-update/state.ts";

const STORE = "/s";

test("unpinned npm and git sources are managed; pinned and local ones are left alone", () => {
	const npm = classify("npm:pi-web-access", STORE);
	assert.equal(npm.kind, "managed");
	assert.deepEqual(npm.kind === "managed" && npm.origin, { kind: "npm", source: "npm:pi-web-access", name: "pi-web-access", key: "npm-pi-web-access-0c1c95e7", label: "pi-web-access" });
	const scoped = classify("npm:@scope/pkg", STORE);
	assert.equal(scoped.kind === "managed" && scoped.origin.key, "npm-scope-pkg-e9a8e5aa");
	assert.equal(classify("npm:x@1.2.3", STORE).kind, "pinned");
	assert.equal(classify("npm:@scope/pkg@^1", STORE).kind, "pinned");
	const git = classify("git:github.com/jaedync/pi-extras", STORE);
	assert.equal(git.kind, "managed");
	assert.deepEqual(git.kind === "managed" && git.origin, { kind: "git", source: "git:github.com/jaedync/pi-extras", url: "https://github.com/jaedync/pi-extras", key: "git-github.com-jaedync-pi-extras-daed6da4", label: "pi-extras" });
	const https = classify("https://github.com/a/b.git", STORE);
	assert.equal(https.kind === "managed" && https.origin.kind === "git" && https.origin.url, "https://github.com/a/b.git");
	assert.equal(https.kind === "managed" && https.origin.key, "git-github.com-a-b-c8aa266f");
	const ssh = classify("git:git@github.com:a/b", STORE);
	assert.equal(ssh.kind === "managed" && ssh.origin.kind === "git" && ssh.origin.url, "git@github.com:a/b");
	assert.equal(classify("git:github.com/a/b@v1.0.0", STORE).kind, "pinned");
	assert.equal(classify("https://github.com/a/b@main", STORE).kind, "pinned");
	assert.equal(classify("git:git@github.com:a/b@dev", STORE).kind, "pinned");
	assert.equal(classify("/home/u/dev/remote-pi", STORE).kind, "local");
	assert.equal(classify("./rel", STORE).kind, "local");
	const stored = classify("/s/packages/npm-x/1.0.0/node_modules/x", STORE);
	assert.deepEqual(stored, { kind: "store", key: "npm-x" });
	assert.equal(classify("/s/packagesX/npm-x/1.0.0", STORE).kind, "local");
	assert.equal(classify("https://user:secret@example.com/a/b", STORE).kind === "managed", true);
});

test("sources whose names give the same slug get different keys", () => {
	const key = (source: string) => {
		const classified = classify(source, STORE);
		return classified.kind === "managed" ? classified.origin.key : undefined;
	};
	assert.notEqual(key("npm:@scope/foo"), key("npm:scope-foo"));
	assert.notEqual(key("git:github.com/a/b-c"), key("git:github.com/a-b/c"));
	assert.equal(key("git:github.com/a/b"), key("https://github.com/a/b.git"), "one repository, one key");
	assert.equal(key("https://user:secret@github.com/a/b"), key("git:github.com/a/b"), "credentials never reach the key");
	assert.match(key("npm:@scope/foo")!, /^npm-scope-foo-[0-9a-f]{8}$/);
});

test("entries keep their filters when the source changes", () => {
	assert.equal(entrySource("npm:x"), "npm:x");
	assert.equal(entrySource({ source: "npm:x", extensions: ["a"] }), "npm:x");
	assert.equal(entrySource({ nope: 1 }), undefined);
	assert.equal(withSource("npm:x", "/p"), "/p");
	assert.deepEqual(withSource({ source: "npm:x", extensions: ["a"] }, "/p"), { source: "/p", extensions: ["a"] });
});

const set: UpdateSet = {
	pi: { version: "1.4.0", dir: "/s/pi/1.4.0" },
	packages: {
		"npm-x-5e8159d8": { origin: "npm:x", id: "2.0.0", dir: "/s/packages/npm-x-5e8159d8/2.0.0", entry: "/s/packages/npm-x-5e8159d8/2.0.0/node_modules/x" },
		"git-github.com-a-b-c8aa266f": { origin: "git:github.com/a/b", id: "1.0.0-abc1234", dir: "/s/packages/git-github.com-a-b-c8aa266f/1.0.0-abc1234", entry: "/s/packages/git-github.com-a-b-c8aa266f/1.0.0-abc1234" },
	},
};

test("applySet rewrites managed and stored entries only, and restoreOriginals undoes it", () => {
	const before = ["npm:x", { source: "/s/packages/git-github.com-a-b-c8aa266f/0.9.0-0000000", extensions: ["e"] }, "npm:y@1.0.0", "/local/pkg", "npm:not-in-set"];
	const after = applySet(before, set, STORE);
	assert.deepEqual(after, [
		"/s/packages/npm-x-5e8159d8/2.0.0/node_modules/x",
		{ source: "/s/packages/git-github.com-a-b-c8aa266f/1.0.0-abc1234", extensions: ["e"] },
		"npm:y@1.0.0",
		"/local/pkg",
		"npm:not-in-set",
	]);
	assert.notEqual(after, before);
	const managed = { "npm-x-5e8159d8": { origin: "npm:x", original: "npm:x" }, "git-github.com-a-b-c8aa266f": { origin: "git:github.com/a/b", original: { source: "git:github.com/a/b", extensions: ["e"] } } };
	assert.deepEqual(restoreOriginals(after, managed, STORE), ["npm:x", { source: "git:github.com/a/b", extensions: ["e"] }, "npm:y@1.0.0", "/local/pkg", "npm:not-in-set"]);
});

test("semver parses v tags and orders pre-releases first", () => {
	assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: undefined, text: "1.2.3" });
	assert.equal(parseSemver("1.2"), undefined);
	assert.ok(compareSemver(parseSemver("1.10.0")!, parseSemver("1.9.9")!) > 0);
	assert.ok(compareSemver(parseSemver("1.0.0-rc.1")!, parseSemver("1.0.0")!) < 0);
	assert.ok(compareSemver(parseSemver("1.0.0-rc.10")!, parseSemver("1.0.0-rc.9")!) > 0);
});

function fakeRunner(replies: Record<string, Partial<RunResult>>, calls: string[][] = []): Runner {
	return async (command, args) => {
		calls.push([command, ...args]);
		const key = [command, ...args].join(" ");
		const reply = Object.entries(replies).find(([prefix]) => key.startsWith(prefix))?.[1];
		return { code: 0, stdout: "", stderr: "", timedOut: false, ...(reply ?? { code: 1, stderr: `no fake for ${key}` }) };
	};
}

test("newestGit takes the newest stable v tag and its peeled commit", async () => {
	const lsRemote = [
		"1111111111111111111111111111111111111111\trefs/tags/v0.29.0",
		"2222222222222222222222222222222222222222\trefs/tags/v0.30.0",
		"3333333333333333333333333333333333333333\trefs/tags/v0.30.0^{}",
		"4444444444444444444444444444444444444444\trefs/tags/v0.31.0-rc.1",
		"5555555555555555555555555555555555555555\trefs/tags/release-9",
	].join("\n");
	const calls: string[][] = [];
	const runner = fakeRunner({ "git ls-remote --tags": { stdout: lsRemote } }, calls);
	const found = await newestGit("https://github.com/a/b", "tags", runner, { prereleases: false });
	assert.deepEqual(found, { version: "0.30.0", ref: "v0.30.0", commit: "3333333333333333333333333333333333333333", id: "0.30.0-3333333" });
	assert.deepEqual(calls[0], ["git", "ls-remote", "--tags", "https://github.com/a/b"]);
	const pre = await newestGit("https://github.com/a/b", "tags", runner, { prereleases: true });
	assert.equal(pre.version, "0.31.0-rc.1");
});

test("newestGit falls back to HEAD when a repository has no semver tags, or when asked", async () => {
	const runner = fakeRunner({ "git ls-remote --tags": { stdout: "" }, "git ls-remote https://x/a/b HEAD": { stdout: "abcdef0123456789abcdef0123456789abcdef01\tHEAD\n" } });
	assert.deepEqual(await newestGit("https://x/a/b", "tags", runner, { prereleases: false }), { version: undefined, ref: "HEAD", commit: "abcdef0123456789abcdef0123456789abcdef01", id: "head-abcdef0" });
	assert.equal((await newestGit("https://x/a/b", "head", runner, { prereleases: false })).ref, "HEAD");
});

test("a failed lookup throws a sanitized one-line reason", async () => {
	const runner = fakeRunner({ "git ls-remote": { code: 128, stderr: "fatal: could not read from https://u:p@x/a/b\n" } });
	await assert.rejects(newestGit("https://u:p@x/a/b", "tags", runner, { prereleases: false }), (error: Error) => {
		assert.match(error.message, /exit 128: fatal: could not read from https:\/\/\*\*\*@x\/a\/b/);
		assert.doesNotMatch(error.message, /u:p@/);
		return true;
	});
});

// Older npm prints the value of `view --json` as it is; npm 12.2.1 (op01) prints an array with one element for each matched version.
const NPM_SHAPES = { "plain value": (value: unknown) => value, "npm 12 array": (value: unknown) => [value] } as const;

for (const [shape, wrap] of Object.entries(NPM_SHAPES)) {
	test(`newestNpm takes the latest version, or the newest one old enough (${shape} output)`, async () => {
		const runner = fakeRunner({
			"npm view x version --json": { stdout: `${JSON.stringify(wrap("2.1.0"), null, 2)}\n` },
			"npm view x dist-tags time --json": { stdout: JSON.stringify(wrap({ "dist-tags": { latest: "2.1.0" }, time: { created: "2020-01-01T00:00:00Z", modified: "x", "1.0.0": "2026-01-01T00:00:00Z", "2.0.0": "2026-10-20T00:00:00Z", "2.1.0": "2026-10-25T10:00:00Z", "3.0.0-rc.1": "2026-10-01T00:00:00Z" } }), null, 2) },
		});
		assert.equal(await newestNpm("x", runner, { minAgeHours: 0, now: Date.parse("2026-10-25T12:00:00Z") }), "2.1.0");
		assert.equal(await newestNpm("x", runner, { minAgeHours: 24, now: Date.parse("2026-10-25T12:00:00Z") }), "2.0.0");
		assert.equal(await newestNpm("x", runner, { minAgeHours: 24 * 365, now: Date.parse("2026-10-25T12:00:00Z") }), undefined);
		await assert.rejects(newestNpm("x", fakeRunner({ "npm view": { stdout: "not json" } }), { minAgeHours: 0, now: 0 }), /npm view/);
	});
}

test("npm 12 output with several elements: the highest version counts; package fields must agree; anything else fails", async () => {
	const versions = fakeRunner({ "npm view x version --json": { stdout: JSON.stringify(["1.3.0", "1.10.0", "1.4.0"]) } });
	assert.equal(await newestNpm("x", versions, { minAgeHours: 0, now: 0 }), "1.10.0");
	const info = { "dist-tags": { latest: "1.4.0" }, time: { "1.4.0": "2020-01-01T00:00:00Z" } };
	const same = fakeRunner({ "npm view x dist-tags time --json": { stdout: JSON.stringify([info, info]) } });
	assert.equal(await newestNpm("x", same, { minAgeHours: 1, now: Date.now() }), "1.4.0");
	const differ = fakeRunner({ "npm view x dist-tags time --json": { stdout: JSON.stringify([info, { ...info, "dist-tags": { latest: "9.0.0" } }]) } });
	await assert.rejects(newestNpm("x", differ, { minAgeHours: 1, now: Date.now() }), /npm view x: 2 different results/);
	for (const stdout of ["[]", "[1]", JSON.stringify(["1.0.0", "next"]), "{}", "42"]) {
		await assert.rejects(newestNpm("x", fakeRunner({ "npm view x version --json": { stdout } }), { minAgeHours: 0, now: 0 }), /npm view/, stdout);
	}
	await assert.rejects(newestNpm("x", fakeRunner({ "npm view x dist-tags time --json": { stdout: "[]" } }), { minAgeHours: 1, now: 0 }), /npm view/);
});
