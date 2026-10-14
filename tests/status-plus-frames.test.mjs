import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		mode: "tui", cwd: agentDir, isProjectTrusted: () => false, model: { id: "test", provider: "test-provider", contextWindow: 1000 },
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

test("the context figure is a share of the point where Pi compacts, read again with the session", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "status-plus-point-"));
	mkdirSync(agentDir, { recursive: true });
	const settings = (compaction) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction }));
	t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(agentDir, { recursive: true, force: true }); });
	// Pi takes the reserve from the selected model and the window from where it routes (getContextUsage).
	settings({ reserveTokens: 100, modelOverrides: { "virtual/auto": { reserveTokens: 500 } } });
	const handlers = new Map();
	let component;
	let leaf = "a";
	let usage = { tokens: 400, contextWindow: 1000, percent: 40 };
	let trusted = true;
	const ctx = {
		mode: "tui", cwd, isProjectTrusted: () => trusted, model: { id: "auto", provider: "virtual", contextWindow: 4000 },
		sessionManager: {
			getBranch: () => [], getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~",
			getLeafId: () => leaf, getSessionName: () => undefined,
		},
		getContextUsage: () => usage,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (tone, text) => `<${tone}>${text}</>` }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} } });
	await handlers.get("session_start")({}, ctx);
	const figure = () => stripAnsi(component.render(200).join("\n")).match(/<(\w+)>(\S+ \/ \S+)<\/>/)?.slice(1);
	try {
		assert.deepEqual(figure(), ["warning", "400 / 500"], "80 percent of the point, not 40 of the window");
		settings({ enabled: false });
		assert.deepEqual(figure(), ["warning", "400 / 500"], "a frame reads no settings");
		leaf = "b";
		usage = { tokens: 550, contextWindow: 1000, percent: 55 };
		assert.deepEqual(figure(), ["dim", "550 / 1.0k"], "compaction off: the window, read again with the new entry");
		settings({ reserveTokens: 500 });
		leaf = "c";
		assert.deepEqual(figure(), ["error", "550 / 500"], "past the point until Pi compacts");
		leaf = "d";
		usage = { tokens: null, contextWindow: 1000, percent: null };
		assert.deepEqual(figure(), ["dim", "? / 500"], "unknown after a compaction until the next reply");
		usage = { tokens: 300, contextWindow: 1000, percent: 30 };
		// A settings file Pi cannot load leaves its values as they were; the figure keeps its last reading and says why.
		writeFileSync(join(agentDir, "settings.json"), "{ half-written");
		leaf = "e";
		assert.deepEqual(figure(), ["dim", "300 / 500"], "a file that does not load keeps the last reading, not Pi's defaults");
		assert.match(readFileSync(join(agentDir, "status-plus.log"), "utf8"), /context share keeps its last reading/);
		// A trusted project's own settings apply, and the same file is ignored when the project is not trusted.
		settings({ reserveTokens: 500 });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { modelOverrides: { "virtual/auto": { reserveTokens: 700 } } } }));
		leaf = "f";
		assert.deepEqual(figure(), ["error", "300 / 300"], "the trusted project's override");
		trusted = false;
		leaf = "g";
		assert.deepEqual(figure(), ["dim", "300 / 500"], "an untrusted project's settings are not read");
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
	}
});

test("the footer reads the settings files again only when one of them, the directory or the trust changes", async (t) => {
	const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = mkdtempSync(join(tmpdir(), "status-plus-reads-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// Each create takes Pi's lock on settings.json, so the count is what the footer costs other Pi processes.
	const create = SettingsManager.create;
	let creates = 0;
	SettingsManager.create = (...args) => { creates++; return create.apply(SettingsManager, args); };
	t.after(() => { SettingsManager.create = create; rmSync(cwd, { recursive: true, force: true }); rmSync(agentDir, { recursive: true, force: true }); });
	const global = (compaction) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction }));
	const project = (compaction) => writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction }));
	global({ reserveTokens: 500, modelOverrides: { "p/other": { reserveTokens: 800 } } });
	const handlers = new Map();
	let component;
	let leaf = "a";
	let trusted = true;
	const ctx = {
		mode: "tui", cwd, isProjectTrusted: () => trusted, model: { id: "one", provider: "p", contextWindow: 1000 },
		sessionManager: {
			getBranch: () => [], getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~",
			getLeafId: () => leaf, getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} } });
	await handlers.get("session_start")({}, ctx);
	const figure = () => stripAnsi(component.render(200).join("\n")).match(/\S+ \/ (\S+)/)?.[1];
	try {
		assert.equal(figure(), "500");
		const first = creates;
		for (const next of ["b", "c", "d"]) { leaf = next; assert.equal(figure(), "500"); }
		assert.equal(creates, first, "new entries with the files unchanged read nothing");
		ctx.model = { id: "other", provider: "p", contextWindow: 1000 };
		assert.equal(figure(), "200", "a model change takes its override from the settings already read");
		assert.equal(creates, first, "and reads no file");
		global({ reserveTokens: 400, modelOverrides: { "p/other": { reserveTokens: 900 } } });
		assert.equal(figure(), "200", "a frame reads no settings");
		leaf = "e";
		assert.equal(figure(), "100", "a changed global file shows at the next entry");
		assert.equal(creates, first + 1);
		project({ modelOverrides: { "p/other": { reserveTokens: 700 } } });
		leaf = "f";
		assert.equal(figure(), "300", "a changed project file shows at the next entry");
		assert.equal(creates, first + 2);
		trusted = false;
		leaf = "g";
		assert.equal(figure(), "100", "an untrusted project's file is not read");
		assert.equal(creates, first + 3);
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
	}
});
