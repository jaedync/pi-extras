import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-refresh-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");

const START = 1_750_000_000_000;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let ids = 0;

function reply(provider, cost, seconds = 2) {
	return { type: "message", id: `e${++ids}`, timestamp: new Date(START + seconds * 1000).toISOString(), message: {
		role: "assistant", provider, model: "m", timestamp: START,
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, content: [],
	} };
}

/** Status Plus wired to a fake Pi whose transcript walks are counted. */
function app(branch, models = []) {
	const handlers = new Map();
	let component;
	const counts = { walks: 0 };
	const ctx = {
		mode: "tui", model: { id: "m", provider: "anthropic" },
		modelRegistry: { getAll: () => models, find: () => undefined },
		sessionManager: {
			getBranch: () => { counts.walks++; return branch; },
			getLeafId: () => branch.at(-1)?.id ?? null,
			getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined,
		},
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} }, appendEntry() {} });
	return {
		counts,
		emit: (name, event = {}) => handlers.get(name)(event, ctx),
		lines: () => component.render(200).map(stripAnsi),
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a request's start and its limit headers repaint the footer without walking the transcript again", async (t) => {
	const footer = app([reply("anthropic", 0.5)]);
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	const walks = footer.counts.walks;
	await footer.emit("turn_start");
	await footer.emit("before_provider_request");
	await footer.emit("after_provider_response", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.3" } });
	assert.match(footer.lines().join("\n"), /5h 30%/);
	await settle();
	assert.equal(footer.counts.walks, walks);
});

test("a reply's cost shows once Pi has saved it, not only after its tools ran", async (t) => {
	const branch = [reply("anthropic", 0.5)];
	const footer = app(branch);
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await footer.emit("turn_start");
	await footer.emit("before_provider_request");
	const saved = reply("anthropic", 0.5, 4);
	// Pi tells extensions about the reply first and saves it to the session after.
	await footer.emit("message_end", { message: saved.message });
	branch.push(saved);
	await settle();
	assert.match(footer.lines().find((line) => line.startsWith("Ant")), /^Ant {2}\$1\.00/);
	// turn_end with nothing new on the branch does not walk it again.
	const walks = footer.counts.walks;
	await footer.emit("turn_end");
	await settle();
	assert.equal(footer.counts.walks, walks);
});

test("providers whose models cost nothing get a $0.00 row with their tokens and airtime", async (t) => {
	const models = [
		{ provider: "anthropic", id: "m", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
		{ provider: "redarch-bonsai", id: "m", cost: ZERO },
		{ provider: "sparky", id: "m", cost: ZERO },
	];
	const footer = app([reply("anthropic", 0.5), reply("redarch-bonsai", 0, 130)], models);
	await footer.emit("session_start");
	t.after(() => {
		footer.emit("session_shutdown");
		rmSync(agentDir, { recursive: true, force: true });
	});
	const rows = footer.lines().slice(2);
	assert.equal(rows.length, 2, rows.join("\n"));
	assert.match(rows[0], /^Ant /);
	assert.match(rows[1], /^redarch-bonsai {2}\$0\.00 · +2m10s │ 1\.0k in · 100 out$/);
});
