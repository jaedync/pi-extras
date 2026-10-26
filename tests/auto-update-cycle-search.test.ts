/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts), with
 * a fake smoke test that judges each set by its versions. This file: the
 * culprit search (tests without a verdict, retries, coupled releases).
 * It is apart from auto-update-cycle-failures.test.ts, so that the two run
 * in parallel.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { readState } from "../lib/auto-update/state.ts";
import { PI_NAME, tagRelease } from "./support/auto-update-fixtures.ts";
import { fail, judge, PASS, type Versions } from "./support/auto-update-judge.ts";
import { enabled, GIT_KEY, NPM_KEY } from "./support/auto-update-world.ts";

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
	const together = (v: Versions) => (v.git === "2.0.0" && v.npm === "1.0.2" ? fail("conflict") : PASS);
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
