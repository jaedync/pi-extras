import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tool count and the link switch live in pi-extras.json, so it must be a scratch agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "status-plus-click-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");
const { STATUS_CLICK_EVENT } = await import("../lib/status-plus-footer.ts");
const { tuiReference } = await import("./support/tui-reference.ts");

const REMOTE_KEYS = ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION", "PI_CLIPBOARD_OSC52"];
const ARTIFACT = "⇡ 3 published │ ⇠ 1 form waits · Title";

/** A session started over SSH or not: the tests must not depend on how the runner was reached. */
function remote(on) {
	for (const key of REMOTE_KEYS) delete process.env[key];
	if (on) process.env.SSH_CONNECTION = "192.0.2.2 50000 192.0.2.1 22";
}

/** TuiAltScreen keeps its link handler in a public field. */
class AltScreen {
	opened = [];
	openUrl = (url) => this.opened.push(url);
	requestRender() {}
}

function app({ screen = new AltScreen(), statuses = new Map([["artifact", ARTIFACT], ["subagents", "subagents: 2 running"]]) } = {}) {
	const handlers = new Map();
	const emitted = [];
	let component;
	const ctx = {
		mode: "tui", model: { id: "test", provider: "test-provider" },
		sessionManager: { getBranch: () => [], getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined },
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, notify() {}, setFooter(factory) {
			component = factory(tuiReference(screen), { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => statuses, onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit: (name, data) => emitted.push([name, data]) } });
	const lines = () => component.render(120).map(stripAnsi);
	const click = (y, x = 0, button = "left", type = "click") => component.handleMouse({ type, button, x, y, width: 120, height: lines().length });
	return {
		screen, emitted, lines, click,
		dispose: () => component.dispose(),
		start: () => handlers.get("session_start")({}, ctx),
		stop: () => handlers.get("session_shutdown")({}, ctx),
		row: (text) => lines().findIndex((line) => line.includes(text)),
	};
}

test("a left click on a status line announces its key; other clicks and other rows do not", async () => {
	remote(false);
	const footer = app();
	await footer.start();
	try {
		const artifact = footer.row("published");
		const subagents = footer.row("subagents: 2");
		assert.ok(artifact > 0 && subagents > artifact, footer.lines().join("\n"));
		assert.deepEqual(footer.click(artifact, 30), { handled: true });
		assert.deepEqual(footer.emitted, [[STATUS_CLICK_EVENT, { key: "artifact" }]]);
		assert.equal(STATUS_CLICK_EVENT, "status-plus:click");
		assert.deepEqual(footer.click(subagents), { handled: true });
		assert.deepEqual(footer.emitted.at(-1), [STATUS_CLICK_EVENT, { key: "subagents" }]);
		footer.emitted.length = 0;
		assert.equal(footer.click(artifact, 0, "right"), undefined);
		assert.equal(footer.click(artifact, 0, "left", "press"), undefined);
		assert.equal(footer.click(0), undefined, "the grid is not a status");
		// The tool count keeps its own click.
		const tools = footer.row(" tools");
		const x = footer.lines()[tools].indexOf("0 tools");
		assert.deepEqual(footer.click(tools, x), { handled: true });
		assert.deepEqual(footer.emitted, []);
	} finally {
		await footer.stop();
	}
});
