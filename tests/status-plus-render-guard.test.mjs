import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-guard-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.STATUS_PLUS_POLL_LIMITS = "0";
const { default: statusPlus } = await import("../extensions/status-plus.ts");

// Pi's TUI does not catch a footer's render: a throw there reaches uncaughtException, and Pi exits.
test("a footer render that fails logs the error and shows one short line instead of throwing", async (t) => {
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const handlers = new Map();
	let component;
	let broken = false;
	const ctx = {
		mode: "tui", model: { id: "test", provider: "test-provider", contextWindow: 1000 },
		sessionManager: {
			getBranch: () => [], getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~",
			getLeafId: () => (broken ? "b" : "a"), getSessionName: () => undefined,
		},
		getContextUsage: () => {
			if (broken) throw new RangeError("Invalid time value");
			return { tokens: 100, contextWindow: 1000, percent: 10 };
		},
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} } });
	await handlers.get("session_start")({}, ctx);
	try {
		assert.ok(component.render(120).length >= 2);
		broken = true;
		let lines;
		assert.doesNotThrow(() => { lines = component.render(12); });
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= 12, lines[0]);
		const log = join(agentDir, "status-plus.log");
		assert.ok(existsSync(log));
		assert.match(readFileSync(log, "utf8"), /footer render failed: RangeError: Invalid time value/);
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
	}
});
