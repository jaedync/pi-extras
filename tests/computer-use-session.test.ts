import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SkySession, type Approval } from "../lib/computer-use/session.ts";

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
		const asked: string[] = [];
		const state = await session.call("get_app_state", { app: "Finder" }, { approve: async (message) => { asked.push(message); return "always"; } });
		assert.deepEqual(asked, ["Allow ChatGPT to use Finder?"]);
		assert.deepEqual(state.content.map((block) => block.type), ["text", "image"]);
		assert.match(stderr.join(""), /persist=always/);

		const denied = await session.call("get_app_state", { app: "Notes" }, { approve: allow("deny") });
		assert.equal(denied.isError, true);
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
