/** A real parent session reloads (support/reload-harness.mts): mail and children while Pi reloads: a report that comes while the host is parked, and parked hosts the next module can't take over. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyPackage, extrasConfig, finishWhileParked, parent, reloadWarnings, removeScratch, shelf, until, waitingInBash } from "./support/reload-harness.mts";

// These tests finish a run while Pi reloads, to see where its report goes. A child at a turn boundary then would
// move to a new session, and that launch waits for the next module (subagents-swap-sdk.test.mts), so here it does not.
extrasConfig({ swapAtTurn: false });

test("a report that comes while Pi reloads reaches main once, after the reload", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("mid", "Finish during the reload");
		await waitingInBash(p, "mid");
		await p.session.reload({ beforeSessionStart: () => finishWhileParked(p, "mid") });
		await until("its report reaches main", () => p.reports("mid done") > 0);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(p.reports("mid done"), 1);
		assert.deepEqual(reloadWarnings(p), []);
	} finally { await p.close(); }
});

test("a report that comes while Pi reloads reaches main once when the next module can't take the children over", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("early", "Finish during the reload");
		await waitingInBash(p, "early");
		await p.session.reload({ beforeSessionStart: async () => {
			await finishWhileParked(p, "early");
			const parked = shelf().get(p.session.sessionManager);
			shelf().set(p.session.sessionManager, { ...parked, version: parked.version + 1 });
		} });
		await until("its report reaches main", () => p.reports("early done") > 0);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(p.reports("early done"), 1);
		assert.equal(p.record("early")?.state, "idle", "it finished; nothing to resume");
		assert.equal(p.session.messages.filter((m: any) => m.customType === "subagent-restore").length, 0);
	} finally { await p.close(); }
});

test("a parked host of another version is closed with its own code, and its children resume as after a reload before", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("old", "Work when the version changes");
		await waitingInBash(p, "old");
		await p.session.reload({ beforeSessionStart: async () => {
			const parked = shelf().get(p.session.sessionManager);
			assert.ok(parked, "the reload parked the host");
			shelf().set(p.session.sessionManager, { ...parked, version: parked.version + 1 });
		} });
		const notice = p.session.messages.filter((m: any) => m.customType === "subagent-restore");
		assert.equal(notice.length, 1);
		assert.match(JSON.stringify(notice), /Auto-resuming.*old/);
		assert.match(p.notices.join("\n"), /can't take over/);
		p.release("old");
		await until("old finishes its resumed run", () => p.record("old")?.state === "idle");
		assert.equal(p.record("old")?.runs, 2, "interrupted, then resumed");
	} finally { await p.close(); }
});

test("a takeover that throws closes the parked host with its own code, and its children resume as after a reload before", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("fragile", "Work when the takeover fails");
		await waitingInBash(p, "fragile");
		await p.session.reload({ beforeSessionStart: async () => {
			const parked = shelf().get(p.session.sessionManager);
			shelf().set(p.session.sessionManager, { ...parked, claim: () => ({ ...parked.claim(), rebind() { throw new Error("synthetic takeover failure"); } }) });
		} });
		assert.match(p.notices.join("\n"), /could not take over.*synthetic takeover failure/);
		const notice = p.session.messages.filter((m: any) => m.customType === "subagent-restore");
		assert.equal(notice.length, 1);
		assert.match(JSON.stringify(notice), /Auto-resuming.*fragile/);
		p.release("fragile");
		await until("fragile finishes its resumed run", () => p.record("fragile")?.state === "idle");
		assert.equal(p.record("fragile")?.runs, 2);
	} finally { await p.close(); }
});

test("a start just after a parked host timed out waits for it to let go of its children, then resumes them", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("late", "Work when the reload stalls");
		await waitingInBash(p, "late");
		await p.session.reload({ beforeSessionStart: async () => {
			// What the timeout does: off the shelf, then closed with its own code, still under way as the next start begins.
			const parked = shelf().get(p.session.sessionManager);
			shelf().delete(p.session.sessionManager);
			void parked.close("reload");
		} });
		assert.doesNotMatch(p.notices.join("\n"), /owned/);
		const notice = p.session.messages.filter((m: any) => m.customType === "subagent-restore");
		assert.equal(notice.length, 1);
		assert.match(JSON.stringify(notice), /Auto-resuming.*late/);
		p.release("late");
		await until("late finishes its resumed run", () => p.record("late")?.state === "idle");
	} finally { await p.close(); }
});

test.after(removeScratch);
