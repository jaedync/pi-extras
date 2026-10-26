/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: sets that fail the smoke test (the bad
 * mark, and the search for the culprit when two changes fail together).
 * The cycle tests are in four files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { readlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../lib/auto-update/config.ts";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { SMOKE_RESERVE_MS, SMOKE_TIMEOUT_MS, type SmokeInput, type SmokeResult } from "../lib/auto-update/smoke.ts";
import { readState, SUSPECT_WAIT_MS } from "../lib/auto-update/state.ts";
import { statusLines } from "../lib/auto-update/status.ts";
import { PI_NAME, tagRelease } from "./support/auto-update-fixtures.ts";
import { enabled, GIT_KEY, NPM_KEY } from "./support/auto-update-world.ts";

test("a broken release fails the smoke test, is marked bad, is not tried again, and the current set stays", async (t) => {
	const w = await enabled(t);
	const before = readState(w.paths.state).current!;
	const settingsBefore = w.read(w.settings);
	const commit = tagRelease(w.gitRepo, "load-error", "2.0.0");
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	assert.match(result.message, /fixture-git 2\.0\.0 failed its test: .*Failed to load extension/);
	const state = readState(w.paths.state);
	assert.deepEqual(state.current, before);
	assert.ok(state.bad[GIT_KEY]?.[`2.0.0-${commit.slice(0, 7)}`], "the broken version is marked bad");
	assert.match(state.lastError?.message ?? "", /failed its test/);
	assert.equal(w.read(w.settings), settingsBefore);
	assert.equal(readlinkSync(w.paths.piCurrent), "pi/1.4.0");
	// Two changes at once: only the broken one is marked; the good one passes alone.
	w.setRegistry("fixture-npm", "1.0.2");
	const both = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(both.outcome, "switched", both.message);
	assert.equal(readState(w.paths.state).current!.packages[NPM_KEY]!.id, "1.0.2");
	assert.equal(readState(w.paths.state).current!.packages[GIT_KEY]!.id, before.packages[GIT_KEY]!.id, "the bad tag is skipped");
});

test("when two changes fail together, only the culprit is marked, and the rest switches in the same cycle", async (t) => {
	const w = await enabled(t);
	const commit = tagRelease(w.gitRepo, "handler-error", "3.0.0");
	w.setRegistry("fixture-npm", "1.0.3");
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	assert.match(result.message, /Updated: fixture-npm 1\.0\.3\. fixture-git 3\.0\.0 failed its test/);
	const state = readState(w.paths.state);
	assert.ok(state.bad[GIT_KEY]?.[`3.0.0-${commit.slice(0, 7)}`]);
	assert.equal(state.bad[NPM_KEY], undefined, "the good npm update is not blamed");
	assert.equal(state.current!.packages[NPM_KEY]!.id, "1.0.3");
	assert.equal(state.suspect, undefined, "every release has its verdict");
});

const sourceOf = (entry: unknown): string => (typeof entry === "string" ? entry : (entry as { source: string }).source);

/** The versions in a smoke input: the Pi folder's name and each store entry's release id. */
function versionsOf(input: SmokeInput): { pi: string; git: string | undefined; npm: string | undefined } {
	const idAfter = (key: string) => {
		const entry = input.packages.map(sourceOf).find((path) => path.includes(`/${key}/`));
		return entry?.split(`/${key}/`)[1]!.split("/")[0]!.replace(/-[0-9a-f]{7}$/, "");
	};
	return { pi: basename(input.piDir), git: idAfter(GIT_KEY), npm: idAfter(NPM_KEY) };
}

/** A fake smoke test that decides by the versions in the set, and records each set it tested. */
function judge(rule: (v: ReturnType<typeof versionsOf>) => SmokeResult) {
	const tested: string[] = [];
	const smoke = async (input: SmokeInput): Promise<SmokeResult> => {
		const v = versionsOf(input);
		tested.push(`pi ${v.pi}, git ${v.git}, npm ${v.npm}`);
		return rule(v);
	};
	return { smoke, tested };
}

const PASS: SmokeResult = { ok: true, ms: 1 };
const fail = (reason: string): SmokeResult => ({ ok: false, reason });

test("a smoke timeout is no verdict: nothing is marked bad, no culprit search runs, and the releases stay suspect", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	w.setRegistry("fixture-npm", "1.0.2");
	const { smoke, tested } = judge(() => ({ ok: false, reason: "no reply within 90 s", inconclusive: true }));
	const result = await runCycle(w.cycleDeps({ smoke }), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	assert.match(result.message, /gave no result: no reply within 90 s.*next check tries again/);
	assert.equal(tested.length, 1, "no search on a test without a verdict");
	const state = readState(w.paths.state);
	assert.deepEqual(state.bad, {});
	assert.equal(Object.values(state.suspect?.[GIT_KEY] ?? {})[0]?.tries, 1);
	assert.equal(Object.values(state.suspect?.[NPM_KEY] ?? {})[0]?.tries, 1);
});

test("the combination fails once, each change passes alone, the combination passes again: switch, nothing bad", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	w.setRegistry("fixture-npm", "1.0.2");
	let calls = 0;
	const { smoke, tested } = judge(() => (++calls === 1 ? fail("Pi exited (1) before the reply: flaky") : PASS));
	const result = await runCycle(w.cycleDeps({ smoke }), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	assert.equal(result.message, "Updated: fixture-git 2.0.0, fixture-npm 1.0.2.");
	assert.equal(readState(w.paths.state).lastError, undefined, "no failure to show");
	assert.deepEqual(tested, ["pi 1.4.0, git 2.0.0, npm 1.0.2", "pi 1.4.0, git 2.0.0, npm 1.0.0", "pi 1.4.0, git 1.0.0, npm 1.0.2", "pi 1.4.0, git 2.0.0, npm 1.0.2"]);
	const state = readState(w.paths.state);
	assert.deepEqual(state.bad, {});
	assert.equal(state.suspect, undefined);
});

test("a single change that fails gets one more test: a pass switches, a second failure is bad with the first reason, no verdict leaves it suspect", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	let calls = 0;
	const flaky = judge(() => (++calls === 1 ? fail("Pi exited (1) before the reply: flaky") : PASS));
	const passed = await runCycle(w.cycleDeps({ smoke: flaky.smoke }), { force: true });
	assert.equal(passed.outcome, "switched", passed.message);
	assert.equal(passed.message, "Updated: fixture-git 2.0.0.");
	assert.deepEqual(flaky.tested, ["pi 1.4.0, git 2.0.0, npm 1.0.0", "pi 1.4.0, git 2.0.0, npm 1.0.0"]);
	assert.deepEqual(readState(w.paths.state).bad, {});

	w.setRegistry("fixture-npm", "1.0.2");
	calls = 0;
	const unsure = judge(() => (++calls === 1 ? fail("first failure") : { ok: false, reason: "no reply within 90 s", inconclusive: true }));
	assert.equal((await runCycle(w.cycleDeps({ smoke: unsure.smoke }), { force: true })).outcome, "smoke-failed");
	assert.equal(unsure.tested.length, 2);
	assert.deepEqual(readState(w.paths.state).bad, {}, "the retry gave no verdict");
	assert.equal(Object.values(readState(w.paths.state).suspect?.[NPM_KEY] ?? {})[0]?.tries, 1);

	calls = 0;
	const broken = judge(() => fail(++calls === 1 ? "first failure" : "second failure"));
	const result = await runCycle(w.cycleDeps({ smoke: broken.smoke }), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	assert.equal(broken.tested.length, 2);
	assert.equal(Object.values(readState(w.paths.state).bad[NPM_KEY] ?? {})[0]?.reason, "first failure");
	assert.match(result.message, /fixture-npm 1\.0\.2 failed its test: first failure/);
});

test("the combination fails twice while each change passes alone: all are bad together; a retry without a verdict marks nothing", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	w.setRegistry("fixture-npm", "1.0.2");
	const together = (v: ReturnType<typeof versionsOf>) => (v.git === "2.0.0" && v.npm === "1.0.2" ? fail("conflict") : PASS);
	let calls = 0;
	const unsure = judge((v) => (++calls === 4 ? { ok: false, reason: "no reply within 90 s", inconclusive: true } : together(v)));
	assert.equal((await runCycle(w.cycleDeps({ smoke: unsure.smoke }), { force: true })).outcome, "smoke-failed");
	assert.equal(unsure.tested.length, 4);
	assert.deepEqual(readState(w.paths.state).bad, {}, "the retry gave no verdict");
	const sure = judge(together);
	const result = await runCycle(w.cycleDeps({ smoke: sure.smoke }), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	const state = readState(w.paths.state);
	assert.match(Object.values(state.bad[GIT_KEY] ?? {})[0]?.reason ?? "", /only together/);
	assert.match(Object.values(state.bad[NPM_KEY] ?? {})[0]?.reason ?? "", /only together/);
});

test("coupled releases: Pi 1.5 and a package that needs it switch together, and only the broken third change is bad", async (t) => {
	for (const mutual of [false, true]) {
		await t.test(mutual ? "Pi 1.5 also breaks the old package" : "Pi 1.5 works with the old package", async (t) => {
			const w = await enabled(t);
			tagRelease(w.gitRepo, "good", "2.0.0");
			w.setRegistry(PI_NAME, "1.5.0");
			w.setRegistry("fixture-npm", "1.0.9");
			const { smoke, tested } = judge((v) => {
				if (v.npm === "1.0.9") return fail("fixture-npm 1.0.9 is broken");
				if (v.git === "2.0.0" && v.pi !== "1.5.0") return fail("fixture-git 2.0.0 needs Pi 1.5");
				if (mutual && v.pi === "1.5.0" && v.git !== "2.0.0") return fail("Pi 1.5 breaks fixture-git 1.0.0");
				return PASS;
			});
			const result = await runCycle(w.cycleDeps({ smoke }), { force: true });
			assert.equal(result.outcome, "switched", `${result.message}\n${tested.join("\n")}`);
			const state = readState(w.paths.state);
			assert.equal(state.current!.pi.version, "1.5.0");
			assert.match(state.current!.packages[GIT_KEY]!.id, /^2\.0\.0-/);
			assert.equal(state.current!.packages[NPM_KEY]!.id, "1.0.0");
			assert.deepEqual(Object.keys(state.bad), [NPM_KEY], "only the broken change is bad");
			assert.ok(state.bad[NPM_KEY]?.["1.0.9"]);
		});
	}
});

test("two broken changes: no single removal helps, so the search adds them back one at a time to the changes that passed alone", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "load-error", "2.0.0");
	w.setRegistry(PI_NAME, "1.5.0");
	w.setRegistry("fixture-npm", "1.0.9");
	const { smoke } = judge((v) => (v.git === "2.0.0" || v.npm === "1.0.9" ? fail(`broken ${v.git === "2.0.0" ? "git" : "npm"}`) : PASS));
	const result = await runCycle(w.cycleDeps({ smoke }), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	const state = readState(w.paths.state);
	assert.equal(state.current!.pi.version, "1.5.0");
	assert.deepEqual(Object.keys(state.bad).sort(), [GIT_KEY, NPM_KEY].sort());
	assert.equal(state.current!.packages[NPM_KEY]!.id, "1.0.0");
});

test("a set that only drops a source switches without a test and names the dropped source", async (t) => {
	const w = await enabled(t);
	const settings = JSON.parse(w.read(w.settings));
	writeFileSync(w.settings, JSON.stringify({ ...settings, packages: settings.packages.filter((entry: unknown) => !sourceOf(entry).includes(NPM_KEY)) }, null, 2));
	const logged: string[] = [];
	const { smoke, tested } = judge(() => PASS);
	const result = await runCycle(w.cycleDeps({ smoke, log: (line: string) => logged.push(line) }), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	assert.equal(result.message, "Stopped updating: fixture-npm 1.0.0.");
	assert.deepEqual(tested, [], "removing a package needs no test");
	assert.equal(readState(w.paths.state).current!.packages[NPM_KEY], undefined);
	assert.ok(logged.some((line) => /stopped updating fixture-npm 1\.0\.0/.test(line)), logged.join("\n"));
});

test("the first test starts only when a whole test fits before the hard limit's deadline", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	const { smoke, tested } = judge(() => PASS);
	const clock = Date.now();
	const result = await runCycle(w.cycleDeps({ smoke, now: () => clock, deadline: clock + SMOKE_RESERVE_MS - 1 }), { force: true });
	assert.equal(result.outcome, "error", result.message);
	assert.match(result.message, /no time left to test fixture-git 2\.0\.0/);
	assert.deepEqual(tested, []);
	assert.equal(readState(w.paths.state).suspect, undefined, "no test ran: no try counts");
	const enough = await runCycle(w.cycleDeps({ smoke, now: () => clock, deadline: clock + SMOKE_RESERVE_MS }), { force: true });
	assert.equal(enough.outcome, "switched", enough.message);
});

test("a test that the hard limit ends leaves its releases suspect; after 2 such tries they wait 24 h, then get one more try", async (t) => {
	const w = await enabled(t);
	const commit = tagRelease(w.gitRepo, "good", "2.0.0");
	const id = `2.0.0-${commit.slice(0, 7)}`;
	let clock = Date.now();
	// Stands for a cycle that the hard limit ended during the test: no verdict comes back.
	const killed = async (): Promise<SmokeResult> => {
		throw new Error("stopped by the hard limit");
	};
	for (const tries of [1, 2]) {
		const result = await runCycle(w.cycleDeps({ smoke: killed, now: () => clock }), { force: true });
		assert.equal(result.outcome, "error", result.message);
		const state = readState(w.paths.state);
		assert.equal(state.suspect?.[GIT_KEY]?.[id]?.tries, tries);
		assert.equal(state.bad[GIT_KEY], undefined, "not bad: the test gave no verdict");
		clock += 60_000;
	}
	let tested = 0;
	const passing = async (): Promise<SmokeResult> => {
		tested++;
		return { ok: true, ms: 1 };
	};
	const skipped = await runCycle(w.cycleDeps({ smoke: passing, now: () => clock }), { force: true });
	assert.equal(skipped.outcome, "no-change", skipped.message);
	assert.equal(tested, 0, "the same work is not done a third time in a row");
	assert.match(statusLines(readState(w.paths.state), { ...DEFAULT_CONFIG, enabled: true }, clock).join("\n"), /fixture-git 2\.0\.0-\w+ \(its test did not finish 2 times/);
	clock += SUSPECT_WAIT_MS;
	const retried = await runCycle(w.cycleDeps({ smoke: passing, now: () => clock }), { force: true });
	assert.equal(retried.outcome, "switched", retried.message);
	assert.equal(tested, 1);
	assert.equal(readState(w.paths.state).suspect?.[GIT_KEY], undefined, "a verdict clears the mark");
});

test("the culprit search starts no test that the cycle limit would cut off; the untested changes stay suspect, not bad", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	w.setRegistry("fixture-npm", "1.0.2");
	let clock = Date.now();
	let tested = 0;
	const failing = async (): Promise<SmokeResult> => {
		tested++;
		clock += SMOKE_TIMEOUT_MS;
		return { ok: false, reason: "boom" };
	};
	const result = await runCycle(w.cycleDeps({ smoke: failing, now: () => clock, limitMs: 2 * SMOKE_TIMEOUT_MS - 1 }), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	assert.match(result.message, /did not finish/);
	assert.equal(tested, 1, "after the first test, a second one could pass the limit");
	const state = readState(w.paths.state);
	assert.deepEqual(state.bad, {}, "no verdict, so nothing is bad");
	assert.equal(Object.values(state.suspect?.[GIT_KEY] ?? {})[0]?.tries, 1);
	assert.equal(Object.values(state.suspect?.[NPM_KEY] ?? {})[0]?.tries, 1);
});
