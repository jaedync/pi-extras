import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLauncher } from "../lib/subagents/child.ts";

test("successful extension shutdown clears its child disposal deadline and disposal stays idempotent", async (t) => {
	const scratch = mkdtempSync(join(tmpdir(), "child-dispose-"));
	const nativeSet = globalThis.setTimeout;
	const nativeClear = globalThis.clearTimeout;
	const pending = new Set<ReturnType<typeof setTimeout>>();
	t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
		const timer = nativeSet(...args);
		if (args[1] === 2_000) pending.add(timer);
		return timer;
	});
	t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout>) => { pending.delete(timer); nativeClear(timer); });
	let closes = 0;
	const session = { sessionFile: undefined, bindExtensions: async () => {}, subscribe: () => () => {}, dispose: () => { closes++; },
		extensionRunner: { hasHandlers: () => true, emit: async () => {} } };
	const sdk = { SettingsManager: { create: () => ({}) }, SessionManager: { inMemory: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		resolveCliModel: () => ({ model: { provider: "faux", api: "faux", id: "fixture" } }), createAgentSession: async () => ({ session }) };
	const launcher = createLauncher({ sdk: sdk as never, agentDir: scratch, cwd: scratch, sessionDir: null,
		modelRuntime: async () => ({}) as never, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "" });
	try {
		const child = await launcher.launch({ model: "faux/fixture" } as never, { update() {} } as never);
		await child.dispose();
		assert.equal(pending.size, 0, "settled shutdown must not leave an otherwise unnecessary two-second timer");
		await child.dispose();
		assert.equal(closes, 1);
	} finally {
		for (const timer of pending) nativeClear(timer);
		rmSync(scratch, { recursive: true, force: true });
	}
});
