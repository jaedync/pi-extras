import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import type { HostState, ParkedHost } from "../lib/subagents/contract.ts";
import { HOST_VERSION } from "../lib/subagents/contract.ts";
import { parkHost, takeParked } from "../lib/subagents/host.ts";
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
