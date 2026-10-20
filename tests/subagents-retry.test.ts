import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { retryDelayMs } from "@earendil-works/pi-ai";
import { createLauncher } from "../lib/subagents/child.ts";
import { withChildRetry } from "../lib/subagents/retry.ts";

test("a child retries its own model for minutes, not seconds, before its run fails", () => {
	const retry = withChildRetry(SettingsManager.inMemory()).getRetrySettings();
	assert.deepEqual(retry, { enabled: true, maxRetries: 8, baseDelayMs: 5_000, maxAgentDelayMs: 120_000 });
	const waits = Array.from({ length: retry.maxRetries }, (_, index) => retryDelayMs(retry, index + 1) / 1_000);
	assert.deepEqual(waits, [5, 10, 20, 40, 80, 120, 120, 120]);
});

test("retry settings made longer stay, and retry turned off stays off", () => {
	const longer = { maxRetries: 12, baseDelayMs: 10_000, maxAgentDelayMs: 300_000 };
	assert.deepEqual(withChildRetry(SettingsManager.inMemory({ retry: longer })).getRetrySettings(), { enabled: true, ...longer });
	assert.equal(withChildRetry(SettingsManager.inMemory({ retry: { enabled: false } })).getRetrySettings().enabled, false);
});

test("the launcher gives each child the longer retry", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "child-retry-"));
	const given: SettingsManager[] = [];
	const session = { sessionFile: undefined, bindExtensions: async () => {}, subscribe: () => () => {}, dispose() {} };
	const sdk = { SettingsManager: { create: () => SettingsManager.inMemory() }, SessionManager: { inMemory: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		resolveCliModel: () => ({ model: { provider: "faux", api: "faux", id: "fixture" } }),
		createAgentSession: async (options: { settingsManager: SettingsManager }) => { given.push(options.settingsManager); return { session }; } };
	const launcher = createLauncher({ sdk: sdk as never, agentDir: scratch, cwd: scratch, sessionDir: null,
		modelRuntime: async () => ({}) as never, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "" });
	try {
		const child = await launcher.launch({ model: "faux/fixture" } as never, { update() {} } as never);
		await child.dispose();
		assert.equal(given.length, 1);
		assert.equal(given[0]!.getRetrySettings().maxRetries, 8);
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});
