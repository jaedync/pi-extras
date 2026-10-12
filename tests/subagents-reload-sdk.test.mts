/** A real parent session reloads (support/reload-harness.mts): children keep working through Pi's own /reload, and later runs and later children use the new code. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyPackage, hold, parent, reloadWarnings, removeScratch, shelf, until, waitingInBash } from "./support/reload-harness.mts";

test("/reload interrupts no child; new children and the next run of a paused one use the new code; each report reaches main once", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root);
	try {
		p.release("delta");
		await p.spawn("delta", "Finish at once");
		await until("delta finishes", () => p.record("delta")?.state === "idle");
		await p.spawn("alpha", "Work across the reload");
		await waitingInBash(p, "alpha");
		code.rebuild();
		await p.session.reload();
		assert.equal(p.record("alpha")?.state, "running", "the reload interrupts nothing");
		assert.equal(p.record("alpha")?.interruptedBy, undefined);
		// delta's session is still open, but a launch now would use the new code, so its next run relaunches.
		await p.session.agent.state.tools.find((t: any) => t.name === "message").execute("again", { to: "delta", text: "Once more" }, undefined);
		await until("delta's second run", () => p.record("delta")?.report === "delta done on build 2");
		await p.spawn("beta", "Start after the reload");
		await waitingInBash(p, "beta");
		p.release("beta");
		p.release("alpha");
		await until("alpha and beta finish", () => p.record("alpha")?.state === "idle" && p.record("beta")?.state === "idle");
		assert.equal(p.record("alpha")?.report, "alpha done on build 1", "a running child keeps the code it started with");
		assert.equal(p.record("alpha")?.runs, 1);
		assert.equal(p.record("beta")?.report, "beta done on build 2", "a child started after the reload runs the new code");
		await until("every report reaches main", () => ["alpha done", "beta done", "delta done on build 1", "delta done on build 2"].every((text) => p.reports(text) > 0));
		// Quiet now: a team from the new code takes over from the index, which marks what it restored.
		await until("the new code's team takes over", () => ["alpha", "beta", "delta"].every((name) => p.record(name)?.restored === true));
		await p.spawn("gamma", "Start after the new team");
		p.release("gamma");
		await until("gamma finishes", () => p.record("gamma")?.state === "idle");
		assert.equal(p.record("gamma")?.report, "gamma done on build 2");
		await until("gamma's report reaches main", () => p.reports("gamma done") > 0);
		await p.session.agent.state.tools.find((t: any) => t.name === "message").execute("alpha-again", { to: "alpha", text: "Once more" }, undefined);
		await until("alpha's second run, from its file", () => p.record("alpha")?.report === "alpha done on build 2");
		assert.equal(p.record("alpha")?.runs, 2);
		await until("its report reaches main", () => p.reports("alpha done on build 2") > 0);
		for (const text of ["alpha done on build 1", "alpha done on build 2", "beta done", "delta done on build 1", "delta done on build 2", "gamma done"]) assert.equal(p.reports(text), 1, `${text}: reported once`);
		assert.equal(p.session.messages.filter((m: any) => m.customType === "subagent-restore").length, 0, "nothing to announce");
		assert.deepEqual(reloadWarnings(p), []);
	} finally { await p.close(); }
});

test("a second /reload while the adopted team still works hands the same children on again", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root);
	try {
		await p.spawn("long", "Work across two reloads");
		await waitingInBash(p, "long");
		await p.session.reload();
		code.rebuild();
		await p.session.reload();
		assert.equal(p.record("long")?.state, "running");
		await p.spawn("late", "Start after both reloads");
		await waitingInBash(p, "late");
		p.release("long");
		p.release("late");
		await until("both finish", () => p.record("long")?.state === "idle" && p.record("late")?.state === "idle");
		assert.equal(p.record("long")?.report, "long done on build 1");
		assert.equal(p.record("late")?.report, "late done on build 2");
		await until("the reports reach main", () => p.reports("long done") > 0 && p.reports("late done") > 0);
		await until("the newest code's team takes over", () => p.record("long")?.restored === true);
		assert.equal(p.reports("long done"), 1);
		assert.equal(p.reports("late done"), 1);
		assert.deepEqual(reloadWarnings(p), []);
	} finally { await p.close(); }
});

test("a launch under way when Pi reloads ends on the code it began with, runs, reports once, and its next run uses the new code", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root);
	const gate = hold("launch", "slow");
	try {
		await p.spawn("slow", "Start while Pi reloads");
		await until("slow's launch waits at the gate", gate.held);
		code.rebuild();
		await p.session.reload();
		assert.equal(p.record("slow")?.state, "starting", "the reload interrupts no launch");
		gate.open();
		await waitingInBash(p, "slow");
		p.release("slow");
		await until("slow finishes", () => p.record("slow")?.state === "idle");
		assert.equal(p.record("slow")?.report, "slow done on build 1", "the launch finished with the code it began with");
		await until("its report reaches main", () => p.reports("slow done") > 0);
		await p.session.agent.state.tools.find((t: any) => t.name === "message").execute("again", { to: "slow", text: "Once more" }, undefined);
		await until("its next run", () => p.record("slow")?.report === "slow done on build 2");
		await until("that report reaches main", () => p.reports("slow done on build 2") > 0);
		assert.equal(p.reports("slow done on build 1"), 1);
		assert.equal(p.reports("slow done on build 2"), 1);
		assert.deepEqual(reloadWarnings(p), []);
	} finally {
		gate.open();
		gate.done();
		await p.close();
	}
});

test("a /reload while the old team is still letting its sessions go hands the new team on, and nothing is lost or sent twice", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root);
	const gate = hold("retire");
	try {
		p.release("first");
		await p.spawn("first", "Finish before the reloads");
		await until("first finishes", () => p.record("first")?.state === "idle");
		await until("its report reaches main", () => p.reports("first done") > 0);
		await p.session.reload();
		// Quiet at once: the new module's team takes over, and the old one waits at the gate to let first's session go.
		await until("the old team retires", gate.held);
		assert.equal(p.record("first")?.restored, true, "the new team opened from the index");
		code.rebuild();
		await p.session.reload();
		assert.ok(gate.held(), "still retiring through the second reload");
		gate.open();
		await until("the old team is gone", () => !gate.held());
		await p.session.agent.state.tools.find((t: any) => t.name === "message").execute("again", { to: "first", text: "Once more" }, undefined);
		await until("first's second run, from its file", () => p.record("first")?.report === "first done on build 2");
		await until("that report reaches main", () => p.reports("first done on build 2") > 0);
		assert.equal(p.record("first")?.runs, 2);
		assert.equal(p.reports("first done on build 1"), 1);
		assert.equal(p.reports("first done on build 2"), 1);
		assert.deepEqual(reloadWarnings(p), []);
	} finally {
		gate.open();
		gate.done();
		await p.close();
	}
});

test("a shutdown other than a reload interrupts children as before", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	await p.spawn("quitter", "Work when Pi quits");
	await waitingInBash(p, "quitter");
	await p.close();
	assert.equal(p.record("quitter")?.state, "interrupted");
	assert.equal(p.record("quitter")?.interruptedBy, "quit");
	assert.equal(shelf().get(p.session.sessionManager), undefined, "nothing is parked");
});

test.after(removeScratch);
