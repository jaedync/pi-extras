/** Actual pi-extras child launcher, with the parent's opt-in config inherited. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "rate-limit-child-sdk-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }));
writeFileSync(join(agentDir, "pi-extras.json"), JSON.stringify({ rateLimitRecovery: { autoWait: true } }));
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");
const { childInstructions } = await import("../lib/subagents/format.ts");

function quotaTeam(runtime: any, reports: any[], errors: unknown[]) {
	return new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: (report) => reports.push(report),
		launcher: createLauncher({ sdk: sdk as never, agentDir, cwd: scratch, sessionDir: null, modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: [], customTools: [] }),
			instructions: (record) => childInstructions({ name: record.name, parent: record.parent, readOnly: false, canSpawn: false, roster: "" }),
			onExtensionError: (error) => errors.push(error),
		}),
	});
}

for (const seconds of [9905, undefined]) test(`actual child fails after one quota rejection, never hibernates (${seconds})`, { timeout: 10_000 }, async () => {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "child-quota-fixture", models: [{ id: "claude-opus" }] });
	runtime.registerNativeProvider(faux.provider);
	const errorMessage = JSON.stringify({ error: { type: "rate_limit_error", ...(seconds !== undefined ? { retry_after: seconds } : {}) } });
	faux.setResponses(Array.from({ length: 4 }, () => ai.fauxAssistantMessage("", { stopReason: "error", errorMessage })));
	const reports: any[] = [];
	const errors: unknown[] = [];
	const team = quotaTeam(runtime, reports, errors);
	try {
		const spawned = team.spawn({ task: "Review quota", parent: "main", model: "child-quota-fixture/claude-opus", readOnly: false, fork: false, blocking: false });
		assert.equal(spawned.ok, true);
		const done = await team.whenDone("review-quota");
		assert.equal(done.state, "failed");
		assert.equal(faux.state.callCount, 1, "children must not enter native or long retry loops");
		assert.match(done.error ?? "", /child-quota-fixture/);
		assert.match(done.error ?? "", /subagents never.*wait/i);
		if (seconds !== undefined) {
			assert.match(done.error ?? "", /9905 seconds/);
			assert.match(done.error ?? "", /Expected reset at \d{4}-\d{2}-\d{2}T/);
		} else assert.match(done.error ?? "", /reset time is unknown/i);
		assert.equal(reports.filter((report) => report.kind === "report").length, 1);
		assert.deepEqual(errors, []);
	} finally { await team.close(); }
});

test("a quota-blocked child promptly frees the only slot for queued work", { timeout: 10_000 }, async () => {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "child-quota-fixture", models: [{ id: "claude-opus" }] });
	runtime.registerNativeProvider(faux.provider);
	faux.setResponses([
		ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: JSON.stringify({ error: { type: "rate_limit_error", retry_after: 9905 } }) }),
		ai.fauxAssistantMessage("Queued child completed."),
	]);
	const reports: any[] = []; const errors: unknown[] = [];
	const team = quotaTeam(runtime, reports, errors);
	try {
		const base = { parent: "main", model: "child-quota-fixture/claude-opus", readOnly: false, fork: false, blocking: false };
		assert.equal(team.spawn({ ...base, name: "limited", task: "Quota-blocked work." }).ok, true);
		assert.equal(team.spawn({ ...base, name: "queued", task: "Queued work.", readOnly: true }).ok, true);
		assert.equal(team.get("queued")?.state, "queued");
		const [limited, queued] = await Promise.all([team.whenDone("limited"), team.whenDone("queued")]);
		assert.equal(limited.state, "failed");
		assert.match(queued.report ?? "", /Queued child completed/);
		assert.equal(faux.state.callCount, 2);
		assert.deepEqual(errors, []);
	} finally { await team.close(); }
});

test("a child reports guard initialization failure instead of successful aborted work", { timeout: 10_000 }, async () => {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "guard-install-fixture", models: [{ id: "claude-opus" }] });
	const provider = { ...faux.provider, getModels: () => faux.provider.getModels().map((model: any) => ({ ...model, api: "anthropic-messages" })) };
	runtime.registerNativeProvider(provider);
	faux.setResponses([ai.fauxAssistantMessage("This must not run.")]);
	const register = runtime.registerNativeProvider;
	runtime.registerNativeProvider = () => { throw new Error("synthetic guard registration failure"); };
	const reports: any[] = [], errors: unknown[] = [];
	const team = quotaTeam(runtime, reports, errors);
	try {
		assert.equal(team.spawn({ name: "failed-guard", task: "Do not run without protection", parent: "main", model: "guard-install-fixture/claude-opus", readOnly: false, fork: false, blocking: false }).ok, true);
		const done = await team.whenDone("failed-guard");
		assert.equal(done.state, "failed");
		assert.match(done.error ?? "", /quota retry protection.*reload/i);
		assert.equal(faux.state.callCount, 0);
		assert.equal(reports.filter((report) => report.kind === "report").length, 1);
	} finally { runtime.registerNativeProvider = register; await team.close(); }
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
