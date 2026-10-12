import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import type { HostState, ParkedHost } from "../lib/subagents/contract.ts";
import { HOST_VERSION } from "../lib/subagents/contract.ts";
import { parkHost, takeParked } from "../lib/subagents/host.ts";
import { serveSession } from "../lib/subagents/serve.ts";
import { hostHarness } from "./support/host-harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function setup() {
	const h = hostHarness();
	cleanups.push(h.cleanup);
	return h;
}

const index = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { shutdown?: string; shutdownOwner?: string; records: Array<{ name: string; state: string; interruptedBy?: string; report?: string; restored?: boolean }> };

test("while Pi reloads, a report waits for the next module and reaches main once", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	cleanups.push(() => host.close());
	const name = h.spawn(host, "Count files");
	await tick();
	host.park();
	h.call(name).finish("Counted 3.");
	await host.team.whenDone(name);
	await sleep(20);
	assert.deepEqual(h.reports(first, name), [], "nothing goes to the module Pi is replacing");
	assert.equal(host.quiet(), false, "the report has not reached main");
	const second = h.portsFor("second");
	host.rebind(second.ports);
	await sleep(20);
	assert.equal(h.reports(second, name).length, 1);
	assert.equal(h.reports(first, name).length, 0);
});

test("a launch while Pi reloads waits for the next module's launcher", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	cleanups.push(() => host.close());
	host.park();
	const name = h.spawn(host, "Start during the gap");
	await sleep(10);
	assert.equal(host.team.get(name)?.state, "starting", "waiting for a launcher");
	assert.deepEqual(first.launched, [], "the old module's code does not start it");
	const second = h.portsFor("second");
	host.rebind(second.ports);
	await tick(); await tick();
	assert.deepEqual(second.launched, [name]);
	assert.equal(h.call(name).launcher, "second");
});

test("a child's question to main crosses the reload: main's answer through the next module reaches it", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	cleanups.push(() => host.close());
	const name = h.spawn(host, "Ask main something");
	await tick();
	const asked = host.team.send(name, "main", "Which branch?", { expectReply: true });
	await sleep(10);
	assert.equal(host.team.get(name)?.state, "asking");
	host.park();
	const second = h.portsFor("second");
	host.rebind(second.ports);
	assert.deepEqual(await host.team.send("main", name, "release/2.0"), { ok: true, delivered: "replied" });
	assert.deepEqual(await asked, { ok: true, delivered: "replied", reply: "release/2.0" });
	assert.equal(host.team.get(name)?.state, "running");
	assert.equal(first.sent.filter(({ message }) => message.customType === "subagent-message").length, 1, "the question went out before the reload");
});

test("notices while Pi reloads are kept for the next module, up to a limit, and the rest are counted", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	cleanups.push(() => host.close());
	host.park();
	for (let i = 0; i < 25; i++) host.ports.notify(`notice ${i}`, "warning");
	assert.deepEqual(first.notices, []);
	const second = h.portsFor("second");
	host.rebind(second.ports);
	assert.equal(second.notices.length, 21);
	assert.equal(second.notices[0], "notice 0");
	assert.match(second.notices.at(-1)!, /5 more notices came during \/reload and were dropped/);
});

test("a session is not current while parked, so a child that pauses then lets it go at once", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	cleanups.push(() => host.close());
	const name = h.spawn(host, "Work across the reload");
	await tick();
	host.park();
	h.call(name).finish("Done.");
	await host.team.whenDone(name);
	await tick();
	assert.deepEqual(h.disposed, [name], "its next run starts on the next module's code");
});

test("the host is quiet only when nothing is live and all mail has reached main and been seen", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	cleanups.push(() => host.close());
	assert.equal(host.quiet(), true);
	const name = h.spawn(host, "Look");
	assert.equal(host.quiet(), false, "queued");
	await tick();
	assert.equal(host.quiet(), false, "running");
	h.call(name).finish("Seen.");
	await host.team.whenDone(name);
	assert.equal(host.quiet(), false, "its report is batched");
	await sleep(20);
	const [report] = h.reports(first, name);
	assert.ok(report);
	assert.equal(host.quiet(), false, "sent, but main has not shown it yet");
	host.mail.acknowledge((report.message.details as { id: string }).id);
	assert.equal(host.quiet(), true);
});

test("a parked host nobody claims closes as a reload did before: interrupted, saved, and resumed by the next start", async () => {
	const h = setup();
	const first = h.portsFor("first");
	const host = h.open(first);
	const name = h.spawn(host, "Keep working");
	await tick();
	const session = {};
	const logs: string[] = [];
	host.park();
	parkHost(session, host, { timeoutMs: 20, log: (message) => logs.push(message) });
	await sleep(60);
	assert.equal(takeParked(session), undefined, "it is off the shelf");
	assert.match(logs.join("\n"), /no module took over the subagents within 0\.02 s/);
	const saved = index(h.indexFile);
	assert.equal(saved.shutdown, "reload");
	assert.equal(saved.records[0]?.state, "interrupted");
	assert.equal(saved.records[0]?.interruptedBy, "reload");
	const next = h.portsFor("next");
	const reopened = h.open(next);
	cleanups.push(() => reopened.close());
	await reopened.restore("reload");
	await tick(); await tick();
	assert.deepEqual(next.launched, [name], "the next start resumes it, as after any reload before");
	assert.match(h.call(name).text, /Continue your interrupted task/);
});

test("claiming a parked host ends its timeout and exit watch", async () => {
	const h = setup();
	const host = h.open(h.portsFor("first"));
	cleanups.push(() => host.close());
	const session = {};
	const exits = process.listenerCount("exit");
	parkHost(session, host, { timeoutMs: 20, log: () => assert.fail("claimed in time") });
	assert.equal(process.listenerCount("exit"), exits + 1);
	const parked = takeParked(session)!;
	assert.equal(parked.version, HOST_VERSION);
	assert.equal(parked.claim(), host);
	assert.equal(process.listenerCount("exit"), exits);
	await sleep(40);
	assert.equal(host.quiet(), true, "still open");
});

test("an exit while parked interrupts the children and saves the index before anything is awaited", async () => {
	const h = setup();
	const host = h.open(h.portsFor("first"));
	h.spawn(host, "Still working");
	await tick();
	const session = {};
	const before = new Set(process.listeners("exit"));
	parkHost(session, host, { log: () => undefined });
	const onExit = process.listeners("exit").find((listener) => !before.has(listener))!;
	(onExit as () => void)();
	const saved = index(h.indexFile);
	assert.equal(saved.shutdown, "quit");
	assert.equal(saved.records[0]?.state, "interrupted");
	assert.equal(process.listenerCount("exit"), before.size, "it watches only once");
	assert.equal(takeParked(session), undefined);
});

test("a signal while parked records the interrupted runs, and the host can't be taken over after it", async () => {
	const h = setup();
	const host = h.open(h.portsFor("first"));
	cleanups.push(() => host.close());
	h.spawn(host, "Working when the signal comes");
	await tick();
	host.park();
	// Another listener, as Pi has one, so the recorder does not end this process.
	const keep = () => undefined;
	process.on("SIGTERM", keep);
	try { process.emit("SIGTERM"); } finally { process.off("SIGTERM", keep); }
	const saved = index(h.indexFile);
	assert.equal(saved.shutdown, "SIGTERM");
	assert.equal(saved.records[0]?.state, "interrupted");
	assert.equal(saved.records[0]?.interruptedBy, "signal");
	assert.throws(() => host.rebind(h.portsFor("second").ports), /closed/);
});

test("a host the next module can't use is closed with its own code", async () => {
	const h = setup();
	const host = h.open(h.portsFor("first"));
	h.spawn(host, "Old work");
	await tick();
	const session = {};
	parkHost(session, host, { log: () => undefined });
	const parked: ParkedHost = takeParked(session)!;
	await parked.close("reload");
	assert.equal(index(h.indexFile).records[0]?.interruptedBy, "reload");
	assert.equal((parked.claim() as HostState).quiet(), false, "closed");
});

test("a session start that fails before it takes over a parked host interrupts its children at once, not at the timeout", async () => {
	const closes: string[] = [];
	const parked: ParkedHost = { version: HOST_VERSION, claim: () => assert.fail("nothing is taken over"), close: async (reason) => { closes.push(reason); } };
	const ctx = { cwd: process.cwd(), get scopedModels(): never { throw new Error("no scoped models"); } };
	const sdk = { getAgentDir: () => process.cwd() };
	await assert.rejects(serveSession({ sdk, pi: {}, ctx, generation: 1, parked, route: () => "hold", teamChanged() {}, mailChanged() {}, currentGroup: () => "run-1-0" } as never), /no scoped models/);
	assert.deepEqual(closes, ["reload"]);
});

/** A child finishes while its host is parked, so its report waits for a module that never takes the host over. */
async function reportWhileParked(h: ReturnType<typeof setup>, timeoutMs?: number) {
	const first = h.portsFor("first");
	const host = h.open(first);
	const name = h.spawn(host, "Count files");
	await tick();
	host.park();
	const session = {};
	parkHost(session, host, { log: () => undefined, ...(timeoutMs ? { timeoutMs } : {}) });
	h.call(name).finish("Counted 3.");
	await host.team.whenDone(name);
	await sleep(20);
	assert.deepEqual(h.reports(first, name), [], "held while parked");
	return { first, host, name, session };
}

/** The next start of the session, as after a fallback: it opens the index and restores; its mail is `module`'s. */
async function nextStart(h: ReturnType<typeof setup>, label: string) {
	const module = h.portsFor(label);
	const host = h.open(module);
	await host.restore("reload");
	await sleep(20);
	await host.close();
	return module;
}

for (const [fallback, end] of [
	["a closing fallback (version mismatch, failed takeover, failed start)", async (_host: HostState, session: object) => { await takeParked(session)!.close("reload"); }],
	["an exit", async () => { (process.listeners("exit").at(-1) as () => void)(); await sleep(10); }],
] as const) {
	test(`mail held while parked reaches main once after ${fallback}`, async () => {
		const h = setup();
		const { name, host, session } = await reportWhileParked(h);
		await end(host, session);
		const next = await nextStart(h, "next");
		assert.equal(h.reports(next, name).length, 1, "the next start posts it");
		assert.equal(h.reports(next, name)[0]!.options.triggerTurn, true, "and wakes main, as the report would have");
		const later = await nextStart(h, "later");
		assert.equal(h.reports(later, name).length, 0, "only once");
	});
}

test("mail held while parked reaches main once after the parked host times out", async () => {
	const h = setup();
	const { name } = await reportWhileParked(h, 10);
	await sleep(60);
	const next = await nextStart(h, "next");
	assert.equal(h.reports(next, name).length, 1);
	assert.equal(h.reports(await nextStart(h, "later"), name).length, 0);
});

test("a host that closes while bound hands main the mail it still holds, without waking it, and keeps none of it", async () => {
	const h = hostHarness({ batchMs: 60_000 });
	cleanups.push(h.cleanup);
	const first = h.portsFor("first");
	const host = h.open(first);
	const name = h.spawn(host, "Count files");
	await tick();
	h.call(name).finish("Counted 3.");
	await host.team.whenDone(name);
	assert.equal(h.reports(first, name).length, 0, "still batched");
	await host.close("quit");
	assert.equal(h.reports(first, name).length, 1);
	assert.deepEqual(h.reports(first, name)[0]!.options, { triggerTurn: false }, "a session that ends starts no turn");
	assert.equal(h.reports(await nextStart(h, "next"), name).length, 0);
});
