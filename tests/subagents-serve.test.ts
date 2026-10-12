/**
 * One module's service of a session (serve.ts) with Pi faked down to what it
 * reads: a `ctx` that throws once Pi has replaced it, as an invalidated one
 * does, and a host a reload left behind where a test needs one.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { HOST_VERSION, type HostPorts, type HostState, type ParkedHost } from "../lib/subagents/contract.ts";
import { takeParked } from "../lib/subagents/host.ts";
import { serveSession } from "../lib/subagents/serve.ts";
import { ToolActivity } from "../lib/subagents/tool-activity.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Pi as one module sees it: `replace()` makes its `pi` and `ctx` throw, as a /reload does. */
function fakePi(dir = mkdtempSync(join(tmpdir(), "subagents-serve-"))) {
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const notices: string[] = [];
	let replaced = false;
	const live = <T>(value: T): T => { if (replaced) throw new Error("This extension ctx is stale after session replacement or reload."); return value; };
	const sessionManager = { getSessionId: () => "parent-serve", getBranch: () => live([]) };
	const sdk = { getAgentDir: () => join(dir, "agent"), CONFIG_DIR_NAME: ".pi", parseSessionEntries: () => [], migrateSessionEntries: () => undefined };
	const ctx = { cwd: dir, scopedModels: [], model: undefined, modelRegistry: {}, sessionManager, ui: { notify: (message: string) => { live(notices).push(message); } } };
	const pi = { getActiveTools: () => live([]), getAllTools: () => live([]), sendMessage: () => live(undefined) };
	const serve = (parked?: ParkedHost) => serveSession({ sdk, pi, ctx, generation: 2, parked, route: () => "wake", teamChanged() {}, mailChanged() {}, currentGroup: () => "run-2-0" } as never);
	return { dir, notices, sessionManager, serve, replace: () => { replaced = true; }, index: join(dir, "agent", "sessions", "subagents", "parent-serve", "index.json") };
}

/** Ports for a module that claims a host later: what it is told. */
function laterPorts(notices: string[]): HostPorts {
	return {
		send: () => undefined, route: () => "wake", notify: (message) => { notices.push(message); }, teamChanged: () => undefined, mailChanged: () => undefined,
		launcher: { launch: () => Promise.reject(new Error("no launches here")) },
		models: () => ({ allowed: [], fallbackModel: null }),
	};
}

test("a failure to let go of the old team after the swap is told through the host, never through a ctx Pi has replaced", async () => {
	const pi = fakePi();
	let fail!: (error: Error) => void;
	const retiring = new Promise<void>((_resolve, reject) => { fail = reject; });
	// A quiet host from the module before, as an earlier /reload left it.
	const older = {
		version: HOST_VERSION, generation: 1, activity: new ToolActivity(),
		team: { list: () => [] }, mail: { pending: () => [] },
		rebind(ports: HostPorts) { ports.teamChanged(); },
		park() {}, quiet: () => true, handOver: () => () => undefined,
		retire: () => retiring, restore: async () => undefined, close: async () => undefined,
	} as unknown as HostState;
	const served = await pi.serve({ version: HOST_VERSION, claim: () => older, close: async () => undefined });
	assert.equal(served.adopted, true);
	await tick();
	await tick();
	assert.notEqual(served.host(), older, "the quiet old team was swapped for this module's");
	// Pi reloads before the old team has let go, and the next module has not claimed the host yet.
	served.park(pi.sessionManager);
	pi.replace();
	fail(new Error("synthetic retire failure"));
	await tick();
	const next = takeParked(pi.sessionManager)!.claim() as HostState;
	const told: string[] = [];
	next.rebind(laterPorts(told));
	cleanups.push(() => next.close());
	assert.match(told.join("\n"), /synthetic retire failure/, "the next module shows it");
});

test("a park that fails closes the host as a reload did before, so the lease is let go and the next start opens the index", async () => {
	const pi = fakePi();
	const served = await pi.serve();
	// Pi's `ctx` already throws when the host would keep what main's tools were.
	pi.replace();
	await served.park(pi.sessionManager);
	assert.equal(takeParked(pi.sessionManager), undefined, "nothing parked");
	assert.equal(JSON.parse(readFileSync(pi.index, "utf8")).shutdown, "reload");
	const second = await fakePi(pi.dir).serve();
	cleanups.push(() => second.close());
	assert.equal(second.adopted, false);
});
