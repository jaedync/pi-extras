/**
 * The version lookups and an npm install against the real registry and
 * GitHub, with the npm and git on PATH. Opt-in: set PI_EXTRAS_REAL_TOOLS=1
 * (they need the network, so `npm test` skips them; it sets PI_OFFLINE).
 * They catch output shapes that the fakes do not have, such as npm 12's
 * array output of `npm view --json`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installNpmRelease } from "../lib/auto-update/install.ts";
import { storePaths } from "../lib/auto-update/paths.ts";
import { runCommand } from "../lib/auto-update/run.ts";
import { classify, type Origin } from "../lib/auto-update/sources.ts";
import { compareSemver, newestGit, newestNpm, parseSemver } from "../lib/auto-update/versions.ts";
import { removeTree } from "./support/auto-update-fixtures.ts";

const offline = ["1", "true", "yes"].includes((process.env.PI_OFFLINE ?? "").toLowerCase());
const skip = process.env.PI_EXTRAS_REAL_TOOLS !== "1" || offline ? "set PI_EXTRAS_REAL_TOOLS=1 (and no PI_OFFLINE) to run against the real registry and GitHub" : false;
const PI = "@earendil-works/pi-coding-agent";

test("newestNpm finds Pi on the real registry, with and without a minimum age", { skip }, async () => {
	const latest = await newestNpm(PI, runCommand, { minAgeHours: 0, now: Date.now() });
	assert.ok(latest && parseSemver(latest), `latest: ${latest}`);
	const aged = await newestNpm(PI, runCommand, { minAgeHours: 120, now: Date.now() });
	// Five days back there may be no release at all; a found one is never newer than latest.
	if (aged !== undefined) assert.ok(compareSemver(parseSemver(aged)!, parseSemver(latest)!) <= 0, `${aged} <= ${latest}`);
	console.log(`real npm: latest ${latest}, 120 h old ${aged ?? "none"}`);
});

test("newestGit finds the newest v tag of pi-extras on GitHub", { skip }, async () => {
	const release = await newestGit("https://github.com/jaedync/pi-extras", "tags", runCommand, { prereleases: false });
	assert.ok(release.version && parseSemver(release.version), JSON.stringify(release));
	assert.match(release.commit, /^[0-9a-f]{40}$/);
	assert.equal(release.id, `${release.version}-${release.commit.slice(0, 7)}`);
	const head = await newestGit("https://github.com/jaedync/pi-extras", "head", runCommand, { prereleases: false });
	assert.match(head.id, /^head-[0-9a-f]{7}$/);
});

test("installNpmRelease installs a small real package and checks its version", { skip }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "au-real-"));
	t.after(() => removeTree(root));
	const classified = classify("npm:is-number", "/nowhere") as { origin: Origin };
	const origin = classified.origin as Extract<Origin, { kind: "npm" }>;
	const release = await installNpmRelease(storePaths(root), origin, "7.0.0", { runner: runCommand, now: Date.now });
	assert.equal(JSON.parse(readFileSync(join(release.entry, "package.json"), "utf8")).version, "7.0.0");
});
