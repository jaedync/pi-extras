import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import herdrHold from "../extensions/herdr-hold.ts";
import { ackFor, Gate, readReport } from "../lib/herdr-hold/gate.ts";
import { adoptGate, currentGate, herdrEnv, leaveGate } from "../lib/herdr-hold/socket.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT } from "../lib/tab-status/events.ts";

const PANE = "w1:p1";
const report = (state: string, extra: Record<string, unknown> = {}) =>
	`${JSON.stringify({ id: `herdr:pi:${state}`, method: "pane.report_agent", params: { pane_id: PANE, source: "herdr:pi", agent: "pi", state, seq: 1, ...extra } })}\n`;

function manualGate() {
	const sent: string[] = [];
	const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
	const gate = new Gate({
		paneId: PANE,
		send: (bytes) => sent.push(bytes),
		setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer; },
		clearTimer: (timer) => { (timer as { live: boolean }).live = false; },
	});
	const fireTimers = () => { for (const timer of timers.splice(0)) if (timer.live) timer.run(); };
	return { gate, sent, timers, fireTimers };
}

test("readReport accepts only Herdr's own Pi reports for this pane", () => {
	assert.deepEqual(readReport(report("idle"), PANE), { id: "herdr:pi:idle", method: "pane.report_agent", state: "idle" });
	assert.deepEqual(readReport(Buffer.from(report("working")), PANE)?.state, "working");
	assert.equal(readReport(report("idle", { source: "custom:x" }), PANE), undefined);
	assert.equal(readReport(report("idle", { pane_id: "w1:p2" }), PANE), undefined);
	for (const chunk of ["not json", "null", "{}", '{"method":1}', 42, undefined, "x".repeat(70_000)]) assert.equal(readReport(chunk, PANE), undefined);
	assert.deepEqual(JSON.parse(ackFor({ id: "a", method: "pane.report_agent" })), { id: "a", result: { type: "ok" } });
});

test("idle passes when nothing runs in the background", () => {
	const { gate } = manualGate();
	gate.setSession("s");
	assert.equal(gate.write(report("working")), "pass");
	assert.equal(gate.write(report("idle")), "pass");
	assert.equal(gate.holding(), false);
});

test("idle is held while background work runs and replayed after the grace period", () => {
	const { gate, sent, timers, fireTimers } = manualGate();
	gate.setSession("s");
	gate.background({ sessionId: "s", source: "shell-jobs", count: 1 });
	gate.background({ sessionId: "s", source: "subagents", count: 2 });
	assert.equal(gate.write(report("idle")), "hold");
	gate.background({ sessionId: "s", source: "shell-jobs", count: 0 });
	assert.equal(timers.length, 0, "still busy with subagents");
	gate.background({ sessionId: "s", source: "subagents", count: 0 });
	assert.equal(timers.at(-1)?.ms, 2000);
	assert.deepEqual(sent, []);
	fireTimers();
	assert.deepEqual(sent, [report("idle")], "Herdr's own bytes go out unchanged");
	assert.equal(gate.holding(), false);
});

test("a new turn replaces the held idle, so the work ending plays one sound", () => {
	const { gate, sent, fireTimers } = manualGate();
	gate.setSession("s");
	gate.background({ sessionId: "s", source: "shell-jobs", count: 1 });
	assert.equal(gate.write(report("idle")), "hold");
	gate.background({ sessionId: "s", source: "shell-jobs", count: 0 });
	gate.turnStarted();
	assert.equal(gate.write(report("working")), "pass");
	fireTimers();
	assert.deepEqual(sent, []);
	assert.equal(gate.write(report("idle")), "pass");
});

test("work that starts again during the grace period cancels the replay", () => {
	const { gate, sent, fireTimers } = manualGate();
	gate.setSession("s");
	gate.rateLimitWait("s", true);
	assert.equal(gate.write(report("idle")), "hold");
	gate.rateLimitWait("s", false);
	gate.background({ sessionId: "s", source: "subagents", count: 1 });
	fireTimers();
	assert.deepEqual(sent, []);
	assert.equal(gate.holding(), true);
});

test("other sessions, session reports and blocked reports are not held", () => {
	const { gate } = manualGate();
	gate.setSession("s");
	gate.background({ sessionId: "child", source: "shell-jobs", count: 3 });
	gate.rateLimitWait("child", true);
	assert.equal(gate.write(report("idle")), "pass");
	gate.background({ sessionId: "s", source: "shell-jobs", count: 1 });
	assert.equal(gate.write(report("blocked")), "pass");
	const session = JSON.stringify({ id: "x", method: "pane.report_agent_session", params: { pane_id: PANE, source: "herdr:pi", agent: "pi", seq: 2 } });
	assert.equal(gate.write(session), "pass");
	gate.setSession("other");
	assert.equal(gate.busy(), false, "a new session starts without the old counts");
});

test("flush sends at once and drop forgets", () => {
	const { gate, sent } = manualGate();
	gate.setSession("s");
	gate.background({ sessionId: "s", source: "shell-jobs", count: 1 });
	gate.write(report("idle"));
	gate.drop();
	gate.flush();
	assert.deepEqual(sent, []);
	gate.write(report("idle"));
	gate.flush();
	assert.deepEqual(sent, [report("idle")]);
});

test("herdrEnv follows Herdr's integration", () => {
	assert.equal(herdrEnv({}), undefined);
	assert.equal(herdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s" }), undefined);
	assert.deepEqual(herdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: PANE }, "darwin"), { endpoint: "/s", paneId: PANE });
	assert.equal(herdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "herdr", HERDR_PANE_ID: PANE }, "win32")?.endpoint, "\\\\.\\pipe\\herdr");
});

// --- End to end: a stand-in Herdr server, a reporter shaped like Herdr's Pi integration, and the extension.

async function herdrServer(t: { after(fn: () => unknown): void }) {
	const dir = mkdtempSync(join(tmpdir(), "herdr-hold-"));
	const path = join(dir, "herdr.sock");
	const received: Array<{ method: string; state?: string; seq?: number }> = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (data) => {
			buffer += data.toString("utf8");
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
				const request = JSON.parse(line);
				received.push({ method: request.method, state: request.params.state, seq: request.params.seq });
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
	return { path, received };
}

/** Like Herdr's integration: `net.createConnection` read at call time, one request per connection, resolve on any reply. */
function herdrReporter(path: string) {
	let seq = 0;
	return (state: string) => new Promise<boolean>((resolve) => {
		const socket = net.createConnection(path);
		const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(report(state, { seq: ++seq })));
		socket.on("data", () => finish(true));
		setTimeout(() => finish(false), 1000).unref();
	});
}

function fakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const events = new EventEmitter();
	const pi = { events, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const fire = async (name: string, event: unknown = {}, ctx: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	return { pi, events, fire };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tuiCtx = (sessionId = "main") => ({ mode: "tui", sessionManager: { getSessionId: () => sessionId } });

test("end to end: Herdr hears idle once, after the background work ends", async (t) => {
	const server = await herdrServer(t);
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.path, HERDR_PANE_ID: PANE };
	const original = net.createConnection;
	const app = fakePi();
	const requests: unknown[] = [];
	app.events.on(BACKGROUND_REQUEST_EVENT, (value) => requests.push(value));
	herdrHold(app.pi as never, { env });
	await app.fire("session_start", { reason: "startup" }, tuiCtx());
	t.after(() => app.fire("session_shutdown", { reason: "quit" }));
	assert.notEqual(net.createConnection, original, "the socket is wrapped");
	assert.deepEqual(requests, [{ sessionId: "main" }], "asks the background sources for their counts");
	const send = herdrReporter(server.path);

	await app.fire("agent_start");
	assert.equal(await send("working"), true);
	app.events.emit(BACKGROUND_EVENT, { sessionId: "main", source: "shell-jobs", count: 1 });
	assert.equal(await send("idle"), true, "the integration's request still settles");
	assert.deepEqual(server.received.map((r) => r.state), ["working"], "idle is held while the job runs");

	app.events.emit(BACKGROUND_EVENT, { sessionId: "main", source: "shell-jobs", count: 0 });
	await sleep(2300);
	assert.deepEqual(server.received.map((r) => r.state), ["working", "idle"]);
	assert.equal(server.received.at(-1)?.seq, 2, "the replay keeps Herdr's sequence number");
});

test("end to end: unrelated sockets and other agents' writes are untouched", async (t) => {
	const server = await herdrServer(t);
	const other = await herdrServer(t);
	const app = fakePi();
	herdrHold(app.pi as never, { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.path, HERDR_PANE_ID: PANE } });
	await app.fire("session_start", {}, tuiCtx());
	t.after(() => app.fire("session_shutdown", { reason: "quit" }));
	app.events.emit(BACKGROUND_EVENT, { sessionId: "main", source: "subagents", count: 1 });
	assert.equal(await herdrReporter(other.path)("idle"), true);
	assert.deepEqual(other.received.map((r) => r.state), ["idle"]);
});

test("outside Herdr, when switched off, and outside the interactive session nothing is wrapped", async () => {
	const original = net.createConnection;
	for (const env of [{}, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/x", HERDR_PANE_ID: PANE, PI_HERDR_HOLD: "off" }]) {
		const app = fakePi();
		herdrHold(app.pi as never, { env });
		await app.fire("session_start", {}, tuiCtx());
		assert.equal(net.createConnection, original);
	}
	const app = fakePi();
	herdrHold(app.pi as never, { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/x", HERDR_PANE_ID: PANE } });
	await app.fire("session_start", {}, { ...tuiCtx(), mode: "rpc" });
	assert.equal(net.createConnection, original);
	assert.equal(currentGate(), undefined);
});

test("reload hands the held idle and the counts to the next copy; quit unwraps", async (t) => {
	const server = await herdrServer(t);
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.path, HERDR_PANE_ID: PANE };
	const original = net.createConnection;
	const first = fakePi();
	herdrHold(first.pi as never, { env });
	await first.fire("session_start", {}, tuiCtx());
	first.events.emit(BACKGROUND_EVENT, { sessionId: "main", source: "subagents", count: 1 });
	await first.fire("session_shutdown", { reason: "reload" });

	const send = herdrReporter(server.path);
	assert.equal(await send("idle"), true, "Herdr's forced idle on reload is still held");
	const second = fakePi();
	herdrHold(second.pi as never, { env });
	await second.fire("session_start", { reason: "reload" }, tuiCtx());
	assert.equal(currentGate()?.holding(), true);
	assert.equal(server.received.length, 0);
	second.events.emit(BACKGROUND_EVENT, { sessionId: "main", source: "subagents", count: 0 });
	await sleep(2300);
	assert.deepEqual(server.received.map((r) => r.state), ["idle"]);

	await second.fire("session_shutdown", { reason: "quit" });
	assert.equal(net.createConnection, original);
	assert.equal(currentGate(), undefined);
});

test("a gate nobody adopts after reload sends the held idle and unwraps", async (t) => {
	const server = await herdrServer(t);
	const original = net.createConnection;
	const owner = {};
	const gate = adoptGate(owner, { endpoint: server.path, paneId: PANE });
	gate.setSession("main");
	gate.background({ sessionId: "main", source: "shell-jobs", count: 1 });
	assert.equal(await herdrReporter(server.path)("idle"), true);
	leaveGate({}, "reload", 50);
	assert.equal(currentGate(), gate, "only the owner can leave");
	leaveGate(owner, "reload", 50);
	await sleep(300);
	assert.equal(net.createConnection, original);
	assert.equal(currentGate(), undefined);
	assert.deepEqual(server.received.map((r) => r.state), ["idle"]);
});
