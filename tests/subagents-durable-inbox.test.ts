import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ChildIndex, recoverRoster } from "../lib/subagents/restore.ts";
import { teamHarness } from "./support/team-harness.ts";

const warn = (message: string) => assert.fail(message);

/** A team in a fresh directory, and a way to restart Pi: save the index as a crash would and restore a new team from it. */
function world() {
	const dir = mkdtempSync(join(tmpdir(), "durable-inbox-"));
	const first = teamHarness({ sessionDir: dir });
	const restart = (crash: boolean) => {
		if (crash) first.team.interrupt("signal");
		new ChildIndex(dir, "parent", dir).save(first.team.list(), crash ? "SIGTERM" : "quit");
		const loaded = new ChildIndex(dir, "parent", dir).load(warn);
		const second = teamHarness({ sessionDir: dir, transcripts: first.transcripts });
		second.team.restore(recoverRoster(loaded, dir, () => [], warn));
		return second;
	};
	return { dir, first, restart, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const settle = async () => { await tick(); await tick(); await tick(); };

test("a note waiting in an idle child's inbox survives a restart and reaches its next run once", async () => {
	const w = world();
	try {
		w.first.spawn("alpha work", { name: "alpha" });
		w.first.spawn("beta work", { name: "beta" });
		await tick();
		w.first.lastCall("alpha").finish("alpha done");
		await w.first.team.whenDone("alpha");
		assert.deepEqual(await w.first.team.send("beta", "alpha", "FYI the schema changed"), { ok: true, delivered: "inbox" });
		await w.first.team.close();
		const second = w.restart(false);
		assert.deepEqual(second.team.get("alpha")?.inbox, ["Message from beta:\nFYI the schema changed"]);
		assert.equal((await second.team.send("main", "alpha", "Go on")).ok, true);
		await settle();
		assert.match(second.lastCall("alpha").text, /Go on[\s\S]*FYI the schema changed/);
		assert.equal(second.team.get("alpha")?.inbox, undefined, "taken once it is delivered");
		second.lastCall("alpha").finish("ok");
		await second.team.whenDone("alpha");
		await second.team.send("main", "alpha", "Again");
		await settle();
		assert.doesNotMatch(second.lastCall("alpha").text, /schema changed/);
		await second.team.close();
	} finally { w.cleanup(); }
});

test("an answer a child is owed still resumes it after a crash, and only once", async () => {
	const w = world();
	try {
		w.first.spawn("alpha work", { name: "alpha" });
		w.first.spawn("beta work", { name: "beta" });
		await tick();
		await w.first.team.send("alpha", "beta", "Which port?", { expectReply: true });
		w.first.lastCall("alpha").finish("Waiting on beta.");
		await tick();
		assert.equal(w.first.team.get("alpha")?.state, "waiting");
		const second = w.restart(true);
		assert.equal(second.team.get("alpha")?.state, "interrupted");
		assert.deepEqual(second.team.get("alpha")?.owed, ["beta"]);
		assert.deepEqual(await second.team.send("beta", "alpha", "Port 8080"), { ok: true, delivered: "resumed" });
		await settle();
		assert.match(second.lastCall("alpha").text, /Port 8080/);
		assert.equal(second.team.get("alpha")?.owed, undefined);
		second.lastCall("alpha").finish("Done with 8080.");
		assert.equal((await second.team.whenDone("alpha")).state, "idle");
		assert.deepEqual(await second.team.send("beta", "alpha", "One more thing"), { ok: true, delivered: "inbox" }, "it is owed nothing now, so a peer's note waits");
		await second.team.close();
	} finally { w.cleanup(); }
});

test("a message steered into a running child that it had not read when Pi crashed reaches its next run", async () => {
	const w = world();
	try {
		w.first.spawn("alpha work", { name: "alpha" });
		await tick();
		await w.first.team.send("main", "alpha", "Skip vendor/");
		await w.first.team.send("main", "alpha", "Also skip dist/");
		assert.equal(w.first.team.get("alpha")?.unread?.length, 2);
		w.first.read("alpha", 1);
		assert.deepEqual(w.first.team.get("alpha")?.unread, ["Message from main:\nAlso skip dist/"], "what it read is no longer kept");
		const second = w.restart(true);
		assert.deepEqual(second.team.get("alpha")?.inbox, ["Message from main:\nAlso skip dist/"]);
		assert.equal(second.team.get("alpha")?.unread, undefined);
		await second.team.send("main", "alpha", "Continue");
		await settle();
		assert.match(second.lastCall("alpha").text, /Also skip dist\//);
		assert.doesNotMatch(second.lastCall("alpha").text, /Skip vendor/, "it read that one before the crash");
		await second.team.close();
	} finally { w.cleanup(); }
});

test("a message steered into a child that fails before reading it reaches its next run", async () => {
	const h = teamHarness();
	const name = h.spawn("alpha work");
	await tick();
	await h.team.send("main", name, "Use port 9000");
	h.lastCall(name).fail(new Error("boom"));
	assert.equal((await h.team.whenDone(name)).state, "failed");
	assert.deepEqual(h.team.get(name)?.inbox, ["Message from main:\nUse port 9000"]);
	await h.team.send("main", name, "Try again");
	await settle();
	assert.match(h.lastCall(name).text, /Try again[\s\S]*Use port 9000/);
	await h.team.close();
});

test("a run that ends normally keeps nothing it was steered", async () => {
	const h = teamHarness();
	const name = h.spawn("alpha work");
	await tick();
	await h.team.send("main", name, "Note this");
	h.lastCall(name).finish("Done.");
	await h.team.whenDone(name);
	assert.equal(h.team.get(name)?.unread, undefined);
	assert.equal(h.team.get(name)?.inbox, undefined);
	await h.team.close();
});

test("the child index refuses malformed mail but loads indexes saved before it existed", () => {
	const dir = mkdtempSync(join(tmpdir(), "durable-index-"));
	try {
		const base = { name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "t", readOnly: false, fork: false, blocking: false,
			state: "idle", createdAt: 1, activity: null, runs: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
		const write = (record: object) => writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, parentSession: "p", cwd: dir, records: [record] }));
		write(base);
		assert.equal(new ChildIndex(dir, "p", dir).load(warn)[0]?.inbox, undefined);
		write({ ...base, inbox: ["a"], owed: ["main-helper"], unread: ["b"] });
		assert.deepEqual(new ChildIndex(dir, "p", dir).load(warn)[0]?.owed, ["main-helper"]);
		for (const bad of [{ inbox: "a" }, { owed: [3] }, { unread: [null] }]) {
			write({ ...base, ...bad });
			assert.throws(() => new ChildIndex(dir, "p", dir).load(warn), /invalid/i);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
