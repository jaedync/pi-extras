import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SkySession, type Approval, type ApprovalRequest } from "../lib/computer-use/session.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-sky.mjs", import.meta.url));

function fakeSession(options: { idleMs?: number; callTimeoutMs?: number } = {}) {
	let launches = 0;
	const stderr: string[] = [];
	const session = new SkySession({
		launch: async () => {
			launches++;
			const child = spawn(process.execPath, [FAKE], { stdio: ["pipe", "pipe", "pipe"] });
			child.stderr.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
			return child;
		},
		idleMs: options.idleMs ?? 60_000,
		callTimeoutMs: options.callTimeoutMs ?? 5_000,
	});
	return { session, launches: () => launches, stderr };
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
	const { session, stderr } = fakeSession();
	try {
		const asked: ApprovalRequest[] = [];
		const state = await session.call("get_app_state", { app: "Finder" }, { approve: async (request) => { asked.push(request); return "always"; } });
		assert.deepEqual(asked.map(({ app, message, warning, highRisk, canRemember }) => ({ app, message, warning, highRisk, canRemember })),
			[{ app: "Finder", message: "Allow ChatGPT to use Finder?", warning: undefined, highRisk: false, canRemember: true }]);
		assert.deepEqual(state.content.map((block) => block.type), ["text", "image"]);
		assert.match(stderr.join(""), /persist=always/);

		const denied = await session.call("get_app_state", { app: "Notes" }, { approve: allow("deny") });
		assert.equal(denied.isError, true);

		const auto = await session.call("get_app_state", { app: "Maps" }, { approve: allow("auto") });
		assert.notEqual(auto.isError, true);
		assert.equal(stderr.join("").match(/persist=/g)?.length, 1, "Allow all must never remember an app");
	} finally { await session.close(); }
});

test("a crashed client is replaced on the next call", async () => {
	const { session, launches } = fakeSession();
	try {
		await assert.rejects(session.call("crash", {}, { approve: allow("once") }), /Computer Use client exited/);
		await session.call("list_apps", {}, { approve: allow("once") });
		assert.equal(launches(), 2);
	} finally { await session.close(); }
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
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(dismissed, true);
		assert.match(stderr.join(""), /answer=decline/);
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
