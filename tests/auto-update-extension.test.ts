/**
 * The auto-update extension with a fake Pi: what it registers, that it writes
 * nothing for a user who never enabled it, and `/pi-extras update`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import autoUpdate from "../extensions/auto-update.ts";
import { markChildSession } from "../lib/child-session.ts";
import { writeConfig } from "../lib/auto-update/config.ts";
import { storePaths } from "../lib/auto-update/paths.ts";
import { APPLY_COMMAND, UPDATE_ENTRY } from "../lib/auto-update/session.ts";
import { emptyState, writeState } from "../lib/auto-update/state.ts";
import { subcommand } from "../lib/pi-extras-command.ts";
import { removeTree } from "./support/auto-update-fixtures.ts";

function machine(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "au-ext-"));
	const saved = { agent: process.env.PI_CODING_AGENT_DIR, store: process.env.PI_EXTRAS_UPDATE_STORE, smoke: process.env.PI_EXTRAS_UPDATE_SMOKE };
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_EXTRAS_UPDATE_STORE = join(root, "store");
	delete process.env.PI_EXTRAS_UPDATE_SMOKE;
	t.after(() => {
		for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_EXTRAS_UPDATE_STORE", saved.store], ["PI_EXTRAS_UPDATE_SMOKE", saved.smoke]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		removeTree(root);
	});
	return { root, agentDir, paths: storePaths(join(root, "store")) };
}

function fakePi(options: { mode?: string; child?: boolean } = {}) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const renderers = new Map<string, unknown>();
	const notices: [string, string][] = [];
	const statuses: [string, string | undefined][] = [];
	const sessionManager = { getSessionId: () => "s1", getSessionFile: () => "/s/a.jsonl", getBranch: () => [] };
	if (options.child) markChildSession(sessionManager);
	const ctx = {
		mode: options.mode ?? "tui", sessionManager, isIdle: () => true, hasPendingMessages: () => false,
		ui: { notify: (text: string, level: string) => notices.push([text, level]), setStatus: (key: string, text: string | undefined) => statuses.push([key, text]), getEditorText: () => "" },
	};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		appendEntry: () => {},
		sendUserMessage: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	return {
		pi, ctx, commands, renderers, notices, statuses, handlers,
		emit: (name: string, event: Record<string, unknown>) => (handlers.get(name) ?? []).forEach((handler) => handler({ type: name, ...event }, ctx)),
	};
}

test("in the smoke test's Pi the extension does nothing", (t) => {
	machine(t);
	process.env.PI_EXTRAS_UPDATE_SMOKE = "1";
	const fake = fakePi();
	autoUpdate(fake.pi as never);
	assert.equal(fake.handlers.size, 0);
	assert.equal(fake.commands.size, 0);
});

test("a user who never enabled it gets no files; /pi-extras update says how to turn it on", async (t) => {
	const m = machine(t);
	const fake = fakePi();
	autoUpdate(fake.pi as never);
	assert.ok(fake.commands.has(APPLY_COMMAND));
	assert.ok(fake.renderers.has(UPDATE_ENTRY));
	fake.emit("session_start", { reason: "startup" });
	assert.equal(existsSync(m.paths.root), false, "no store, no lease");
	await subcommand("update")!.handler("", fake.ctx as never);
	assert.match(fake.notices.at(-1)![0], /Auto-update: off\nTo turn it on, run: node .*\/lib\/auto-update\/cli\.ts enable$/);
	await subcommand("update")!.handler("now", fake.ctx as never);
	assert.match(fake.notices.at(-1)![0], /^Auto-update is off\./);
	assert.equal(fake.notices.at(-1)![1], "warning");
	await subcommand("update")!.handler("enable", fake.ctx as never);
	assert.match(fake.notices.at(-1)![0], /^Run this command in a shell: node .*cli\.ts enable$/);
	fake.emit("session_shutdown", { reason: "quit" });
	assert.equal(subcommand("update"), undefined, "a shutdown removes the subcommand; the next load adds it again");
});

test("with the store in use, a main session leases and a subagent session does not; pause and resume", async (t) => {
	const m = machine(t);
	const set = { pi: { version: "1.4.0", dir: join(m.paths.root, "pi", "1.4.0") }, packages: {} };
	mkdirSync(m.paths.root, { recursive: true });
	writeState(m.paths.state, { ...emptyState(), current: set, lastCheck: Date.now() });
	writeConfig(m.agentDir, { enabled: true });
	const child = fakePi({ child: true });
	autoUpdate(child.pi as never);
	child.emit("session_start", { reason: "startup" });
	assert.equal(existsSync(m.paths.leases), false, "a subagent shares its parent's process and lease");
	child.emit("session_shutdown", { reason: "quit" });
	const fake = fakePi({ mode: "print" });
	autoUpdate(fake.pi as never);
	fake.emit("session_start", { reason: "startup" });
	assert.equal(readdirSync(m.paths.leases).length, 1, "print mode leases too, but runs no timers");
	await subcommand("update")!.handler("pause", fake.ctx as never);
	assert.equal(JSON.parse(readFileSync(join(m.agentDir, "pi-extras.json"), "utf8")).autoUpdate.paused, true);
	await subcommand("update")!.handler("", fake.ctx as never);
	assert.match(fake.notices.at(-1)![0], /^Auto-update: on, paused/);
	await subcommand("update")!.handler("resume", fake.ctx as never);
	assert.equal(JSON.parse(readFileSync(join(m.agentDir, "pi-extras.json"), "utf8")).autoUpdate.paused, false);
	await subcommand("update")!.handler("rollback", fake.ctx as never);
	assert.match(fake.notices.at(-1)![0], /no previous set/);
	fake.emit("session_shutdown", { reason: "quit" });
	assert.equal(readdirSync(m.paths.leases).length, 0);
});
