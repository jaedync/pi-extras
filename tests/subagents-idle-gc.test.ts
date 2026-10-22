import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLauncher } from "../lib/subagents/child.ts";
import { processBusy } from "../lib/idle-gc.ts";

test("a child's run keeps Idle GC from collecting until it ends, also when it fails", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "child-idle-gc-"));
	const seen: boolean[] = [];
	let fail = false;
	const session = { sessionFile: undefined, messages: [], bindExtensions: async () => {}, subscribe: () => () => {}, dispose() {},
		prompt: async () => { seen.push(processBusy()); if (fail) throw new Error("model down"); } };
	const sdk = { SettingsManager: { create: () => SettingsManager.inMemory() }, SessionManager: { inMemory: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		resolveCliModel: () => ({ model: { provider: "faux", api: "faux", id: "fixture" } }),
		createAgentSession: async () => ({ session }) };
	const launcher = createLauncher({ sdk: sdk as never, agentDir: scratch, cwd: scratch, sessionDir: null,
		modelRuntime: async () => ({}) as never, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "" });
	try {
		const child = await launcher.launch({ model: "faux/fixture" } as never, { update() {} } as never);
		await child.prompt("work");
		fail = true;
		await assert.rejects(child.prompt("work again"), /model down/);
		await child.dispose();
		assert.deepEqual(seen, [true, true]);
		assert.equal(processBusy(), false);
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});
