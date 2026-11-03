import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as nodeEvents from "node:events";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SkySession, type Approval, type ApprovalRequest } from "../lib/computer-use/session.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-sky.mjs", import.meta.url));

function fakeSession(options: { idleMs?: number; callTimeoutMs?: number } = {}) {
	let launches = 0;
	const stderr: string[] = [];
	const closed: Promise<unknown>[] = [];
	const session = new SkySession({
		launch: async () => {
			launches++;
			const child = spawn(process.execPath, [FAKE], { stdio: ["pipe", "pipe", "pipe"] });
			child.stderr.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
			closed.push(once(child.stderr, "close"));
			return child;
		},
		idleMs: options.idleMs ?? 60_000,
		callTimeoutMs: options.callTimeoutMs ?? 5_000,
	});
	return { session, launches: () => launches, stderr, stderrClosed: () => Promise.all(closed) };
}

/** The fake reports on stderr, a separate pipe from its replies, so a line can arrive after the reply it preceded. */
async function stderrMatching(stderr: string[], pattern: RegExp): Promise<string> {
	const deadline = Date.now() + 2_000;
	while (!pattern.test(stderr.join("")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	return stderr.join("");
}

const allow = (answer: Approval) => async () => answer;

test("one warm session serves consecutive calls", async () => {
	const { session, launches } = fakeSession();
	try {
		const apps = await session.call("list_apps", {}, { approve: allow("once") });
		assert.match(apps.content[0].type === "text" ? apps.content[0].text : "", /Finder/);
		await session.call("list_apps", {}, { approve: allow("once") });
		assert.equal(launches(), 1);
	} finally { await session.close(); }
});

test("an app approval request goes to the caller and its answer is honored", async () => {
	const { session, stderr, stderrClosed } = fakeSession();
	try {
		const asked: ApprovalRequest[] = [];
		const state = await session.call("get_app_state", { app: "Finder" }, { approve: async (request) => { asked.push(request); return "always"; } });
		assert.deepEqual(asked.map(({ app, message, warning, highRisk, canRemember }) => ({ app, message, warning, highRisk, canRemember })),
			[{ app: "Finder", message: "Allow ChatGPT to use Finder?", warning: undefined, highRisk: false, canRemember: true }]);
		assert.deepEqual(state.content.map((block) => block.type), ["text", "image"]);
		assert.match(await stderrMatching(stderr, /persist=always/), /persist=always/);

		const denied = await session.call("get_app_state", { app: "Notes" }, { approve: allow("deny") });
		assert.equal(denied.isError, true);

		const auto = await session.call("get_app_state", { app: "Maps" }, { approve: allow("auto") });
		assert.notEqual(auto.isError, true);
	} finally { await session.close(); }
	// Only a closed pipe shows everything the fake said, so a second persist cannot still be in flight.
	await stderrClosed();
	assert.equal(stderr.join("").match(/persist=/g)?.length, 1, "Allow all must never remember an app");
});

test("a crashed client is replaced on the next call", async () => {
	const { session, launches } = fakeSession();
	try {
		await assert.rejects(session.call("crash", {}, { approve: allow("once") }), /Computer Use client exited/);
		await session.call("list_apps", {}, { approve: allow("once") });
		assert.equal(launches(), 2);
	} finally { await session.close(); }
});

/** A client that answers initialize and every tool call, so only the session's choices are under test. */
function fakeClient(kills: string[][]) {
	const { EventEmitter } = nodeEvents;
	const own: string[] = [];
	kills.push(own);
	const proc = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: (signal: string) => own.push(signal) > 0,
	});
	let buffered = "";
	proc.stdin.on("data", (chunk: Buffer) => {
		buffered += chunk;
		for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
			const message = JSON.parse(buffered.slice(0, index));
			buffered = buffered.slice(index + 1);
			if (typeof message.id !== "number") continue;
			const result = message.method === "initialize" ? { protocolVersion: "2025-06-18" } : { content: [{ type: "text", text: "ok" }] };
			proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
		}
	});
	return proc;
}

// A failed pipe closes the link but not the child: the session must stop that child before a new one starts.
test("a client whose output failed is killed before the next call replaces it", async () => {
	const kills: string[][] = [];
	const procs: ReturnType<typeof fakeClient>[] = [];
	const session = new SkySession({
		launch: async () => { const proc = fakeClient(kills); procs.push(proc); return proc as never; },
		idleMs: 60_000,
		callTimeoutMs: 5_000,
	});
	try {
		await session.call("list_apps", {}, { approve: allow("once") });
		procs[0].stdout.emit("error", new Error("read EIO"));
		assert.equal(session.state, "closed");
		await session.call("list_apps", {}, { approve: allow("once") });
		assert.equal(procs.length, 2);
		assert.deepEqual(kills[0], ["SIGTERM"], "the failed client was left running");
	} finally { await session.close(); }
	assert.deepEqual(kills[1], ["SIGTERM"]);
});

test("an idle session closes itself and restarts on demand", async () => {
	const { session, launches } = fakeSession({ idleMs: 30 });
	try {
		await session.call("list_apps", {}, { approve: allow("once") });
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(session.state, "closed");
		await session.call("list_apps", {}, { approve: allow("once") });
		assert.equal(launches(), 2);
	} finally { await session.close(); }
});

test("a call is bounded by its timeout and by the caller's signal", async () => {
	const { session } = fakeSession({ callTimeoutMs: 50 });
	try {
		await assert.rejects(session.call("slow", { ms: 1000 }, { approve: allow("once") }), /timed out after 50 ms/);
		const controller = new AbortController();
		const pending = session.call("list_apps", {}, { approve: allow("once"), signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, /cancelled/);
	} finally { await session.close(); }
});

test("a high-risk app's warning reaches the approver, naming the agent rather than ChatGPT", async () => {
	const { session } = fakeSession();
	try {
		let asked: ApprovalRequest | undefined;
		await session.call("get_app_state", { app: "Safari" }, { approve: async (request) => { asked = request; return "deny"; } });
		assert.equal(asked?.app, "Safari");
		assert.equal(asked?.highRisk, true);
		assert.match(asked?.warning ?? "", /^Allowing the agent to use this app introduces new risks, including those related to prompt injection attacks/);
		assert.doesNotMatch(asked?.warning ?? "", /ChatGPT/);
	} finally { await session.close(); }
});

test("requests that are not a plain app approval are declined without asking", async () => {
	const { session } = fakeSession();
	try {
		let asked = 0;
		const approve = async () => { asked++; return "always" as const; };
		const url = await session.call("ask_url", {}, { approve });
		const form = await session.call("ask_form", {}, { approve });
		assert.deepEqual([url, form].map((result) => result.content[0].type === "text" ? result.content[0].text : ""), ["url decline", "form decline"]);
		assert.equal(asked, 0);
	} finally { await session.close(); }
});

test("cancelling a call dismisses its approval, and a late answer is still a decline", async () => {
	const { session, stderr } = fakeSession();
	try {
		const controller = new AbortController();
		let dismissed = false;
		const pending = session.call("get_app_state", { app: "Notes" }, {
			signal: controller.signal,
			approve: async (request) => {
				request.signal.addEventListener("abort", () => { dismissed = true; });
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 20));
				return "always";
			},
		});
		await assert.rejects(pending, /cancelled|abort/i);
		assert.equal(dismissed, true);
		// A loaded runner can take more than 100 ms to deliver the fake's stderr line: wait for it.
		assert.match(await stderrMatching(stderr, /answer=decline/), /answer=decline/);
		assert.doesNotMatch(stderr.join(""), /persist=/);
	} finally { await session.close(); }
});

test("control characters in the client's text never reach the dialog", async () => {
	const { session } = fakeSession();
	try {
		let asked: ApprovalRequest | undefined;
		await session.call("get_app_state", { app: "Bad\u001b[2J\nApp" }, { approve: async (request) => { asked = request; return "deny"; } });
		assert.doesNotMatch(`${asked?.app}${asked?.message}`, /[\u0000-\u001f\u007f]/);
		assert.equal(asked?.app, "Bad [2J App");
	} finally { await session.close(); }
});

test("the call that starts the client reports how long startup took", async () => {
	const { session } = fakeSession();
	try {
		const first = await session.call("list_apps", {}, { approve: allow("once") });
		const second = await session.call("list_apps", {}, { approve: allow("once") });
		assert.equal(typeof first.startupMs, "number");
		assert.equal(second.startupMs, undefined);
	} finally { await session.close(); }
});
