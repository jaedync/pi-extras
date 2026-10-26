import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installGitRelease, installNpmRelease, installPi } from "../lib/auto-update/install.ts";
import { storePaths } from "../lib/auto-update/paths.ts";
import { runCommand, type Runner } from "../lib/auto-update/run.ts";
import { classify, type Origin } from "../lib/auto-update/sources.ts";
import { newestGit } from "../lib/auto-update/versions.ts";
import { fakeGitHost, gitPackage, removeTree, tagRelease, writeFile } from "./support/auto-update-fixtures.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "au-install-"));
	t.after(() => removeTree(dir));
	return dir;
}

const origin = (source: string): Origin => {
	const classified = classify(source, "/nowhere");
	assert.equal(classified.kind, "managed");
	return (classified as { origin: Origin }).origin;
};

const deps = (runner: Runner = runCommand) => ({ runner, now: () => 1_000 });

test("a git release is cloned at its tag, verified, read-only, and reused next time", async (t) => {
	const root = scratch(t);
	const host = fakeGitHost(join(root, "host"));
	const repo = gitPackage(join(host.root, "a", "repo"), "good", "0.1.0", "fixture-pkg");
	const commit = tagRelease(repo, "good", "1.0.0", true);
	tagRelease(repo, "good", "1.1.0-rc.1");
	const paths = storePaths(join(root, "store"));
	const source = origin(host.url("a/repo"));
	assert.equal(source.kind, "git");
	const found = await newestGit((source as { url: string }).url, "tags", runCommand, { prereleases: false });
	assert.equal(found.commit, commit, "the annotated tag resolves to its commit");
	const release = await installGitRelease(paths, source as Extract<Origin, { kind: "git" }>, found, deps());
	assert.equal(release.id, `1.0.0-${commit.slice(0, 7)}`);
	assert.equal(release.entry, release.dir);
	assert.equal(release.label, "fixture-pkg 1.0.0");
	assert.equal(JSON.parse(readFileSync(join(release.dir, "package.json"), "utf8")).version, "1.0.0");
	assert.ok(existsSync(join(release.dir, ".pi-extras-release.json")));
	assert.equal(statSync(release.dir).mode & 0o222, 0, "the release folder is read-only");
	assert.equal(statSync(join(release.dir, "package.json")).mode & 0o222, 0);
	assert.throws(() => writeFileSync(join(release.dir, "x"), "x"), /EACCES|EPERM/);
	assert.deepEqual(readdirSync(join(paths.packagesRoot, source.key)), [release.id], "no staging folder is left");
	const calls: string[] = [];
	const again = await installGitRelease(paths, source as Extract<Origin, { kind: "git" }>, found, deps(async (command, args, options) => {
		calls.push(command);
		return runCommand(command, args, options);
	}));
	assert.deepEqual(again, release);
	assert.deepEqual(calls, [], "an installed release is not installed again");
});

test("a failed install leaves neither a staging nor a final folder", async (t) => {
	const root = scratch(t);
	const host = fakeGitHost(join(root, "host"));
	const repo = gitPackage(join(host.root, "a", "repo"), "good");
	tagRelease(repo, "good", "1.0.0");
	const paths = storePaths(join(root, "store"));
	const source = origin(host.url("a/repo")) as Extract<Origin, { kind: "git" }>;
	const moved = { version: "1.0.0", ref: "v1.0.0", commit: "0".repeat(40), id: "1.0.0-0000000" };
	await assert.rejects(installGitRelease(paths, source, moved, deps()), /moved during the install/);
	assert.deepEqual(readdirSync(join(paths.packagesRoot, source.key)), []);
	const missing = { version: "9.0.0", ref: "v9.0.0", commit: "1".repeat(40), id: "9.0.0-1111111" };
	await assert.rejects(installGitRelease(paths, source, missing, deps()), /git clone failed: exit 128/);
	assert.deepEqual(readdirSync(join(paths.packagesRoot, source.key)), []);
});

/** An npm stand-in that writes what `npm install <name>@<version> --prefix <dir>` would. */
function fakeNpm(installed: (spec: string) => string): Runner {
	return async (command, args) => {
		assert.equal(command, "npm");
		const prefix = args[args.indexOf("--prefix") + 1]!;
		const spec = args.find((arg) => /.@\d/.test(arg))!;
		const name = spec.slice(0, spec.lastIndexOf("@"));
		const base = args.includes("-g") ? join(prefix, "lib", "node_modules", name) : join(prefix, "node_modules", name);
		writeFile(join(base, "package.json"), JSON.stringify({ name, version: installed(spec) }));
		if (args.includes("-g")) writeFile(join(prefix, "bin", "pi"), "#!/bin/sh\n");
		return { code: 0, stdout: "", stderr: "", timedOut: false };
	};
}

test("an npm release lands in its own prefix and names the package folder as its entry", async (t) => {
	const paths = storePaths(join(scratch(t), "store"));
	const source = origin("npm:@scope/web") as Extract<Origin, { kind: "npm" }>;
	const release = await installNpmRelease(paths, source, "2.0.0", deps(fakeNpm(() => "2.0.0")));
	assert.equal(release.dir, join(paths.packagesRoot, "npm-scope-web-33483486", "2.0.0"));
	assert.equal(release.entry, join(release.dir, "node_modules", "@scope/web"));
	assert.equal(release.label, "@scope/web 2.0.0");
	await assert.rejects(installNpmRelease(paths, source, "3.0.0", deps(fakeNpm(() => "2.9.9"))), /installed 2\.9\.9 of @scope\/web, not 3\.0\.0/);
	assert.deepEqual(readdirSync(join(paths.packagesRoot, "npm-scope-web-33483486")), ["2.0.0"]);
});

test("every npm install turns off npm's own min-release-age: only minReleaseAgeHours decides", async (t) => {
	const root = scratch(t);
	const paths = storePaths(join(root, "store"));
	const seen: string[][] = [];
	const record = (inner: Runner): Runner => async (command, args, options) => {
		if (command === "npm") seen.push([...args]);
		return inner(command, args, options);
	};
	await installNpmRelease(paths, origin("npm:@scope/web") as Extract<Origin, { kind: "npm" }>, "2.0.0", deps(record(fakeNpm(() => "2.0.0"))));
	await installPi(paths, "@earendil-works/pi-coding-agent", "1.4.1", deps(record(fakeNpm(() => "1.4.1"))));
	// A git package with a package.json gets `npm install --omit=dev` in its clone.
	const host = fakeGitHost(join(root, "host"));
	const repo = gitPackage(join(host.root, "a", "repo"), "good");
	tagRelease(repo, "good", "1.0.0");
	const source = origin(host.url("a/repo")) as Extract<Origin, { kind: "git" }>;
	const found = await newestGit(source.url, "tags", runCommand, { prereleases: false });
	const okNpm: Runner = async (command, args, options) => (command === "npm" ? { code: 0, stdout: "", stderr: "", timedOut: false } : runCommand(command, args, options));
	await installGitRelease(paths, source, found, deps(record(okNpm)));
	assert.equal(seen.length, 3, JSON.stringify(seen));
	for (const args of seen) assert.ok(args.includes("--min-release-age=0"), args.join(" "));
});

test("Pi installs into its own prefix with scripts off", async (t) => {
	const paths = storePaths(join(scratch(t), "store"));
	const seen: string[][] = [];
	const runner: Runner = async (command, args, options) => {
		seen.push([...args]);
		return fakeNpm(() => "1.4.1")(command, args, options);
	};
	const pi = await installPi(paths, "@earendil-works/pi-coding-agent", "1.4.1", deps(runner));
	assert.equal(pi.dir, join(paths.piRoot, "1.4.1"));
	assert.ok(existsSync(join(pi.dir, "bin", "pi")));
	assert.ok(seen[0]!.includes("--ignore-scripts") && seen[0]!.includes("-g"));
});
