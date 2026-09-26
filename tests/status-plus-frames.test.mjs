import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-frames-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.STATUS_PLUS_POLL_LIMITS = "0";
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");

test("the footer walks the session for context usage only when the session or model changes", async (t) => {
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const handlers = new Map();
	let component;
	let leaf = "a";
	const calls = { usage: 0, name: 0 };
	const ctx = {
		mode: "tui", model: { id: "test", provider: "test-provider", contextWindow: 1000 },
		sessionManager: {
			getBranch: () => [], getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~",
			getLeafId: () => leaf,
			getSessionName: () => { calls.name++; return `name ${leaf}`; },
		},
		getContextUsage: () => { calls.usage++; return { tokens: leaf === "a" ? 100 : 500, contextWindow: 1000, percent: leaf === "a" ? 10 : 50 }; },
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} } });
	await handlers.get("session_start")({}, ctx);
	try {
		const before = { ...calls };
		const text = () => stripAnsi(component.render(200).join("\n"));
		for (let frame = 0; frame < 5; frame++) assert.match(text(), /name a/);
		assert.deepEqual(calls, { usage: before.usage + 1, name: before.name + 1 }, "frames reuse one reading");
		leaf = "b";
		assert.match(text(), /name b/);
		assert.equal(calls.usage, before.usage + 2, "a new entry reads again");
		ctx.model = { ...ctx.model, contextWindow: 2000 };
		text();
		assert.equal(calls.usage, before.usage + 3, "a model change reads again");
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
	}
});
