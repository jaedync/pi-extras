/**
 * One module's service of a session (serve.ts) with Pi faked down to what it
 * reads: a `ctx` that throws once Pi has replaced it, as an invalidated one
 * does, and a host a reload left behind where a test needs one.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { HOST_VERSION, type HostPorts, type HostState, type ParkedHost } from "../lib/subagents/contract.ts";
import { parkHost, takeParked } from "../lib/subagents/host.ts";
import { serveSession } from "../lib/subagents/serve.ts";
import { forgetScopeRecords } from "../lib/subagents/scope.ts";
import { ToolActivity } from "../lib/subagents/tool-activity.ts";
import { subagentTool } from "../lib/subagents/tools.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); forgetScopeRecords(); });

/** Pi as one module sees it: `replace()` makes its `pi` and `ctx` throw, as a /reload does. */
function fakePi(dir = mkdtempSync(join(tmpdir(), "subagents-serve-")), sdkExtra: object = {}, ctxExtra: object = {}) {
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const notices: string[] = [];
	let replaced = false;
	const live = <T>(value: T): T => { if (replaced) throw new Error("This extension ctx is stale after session replacement or reload."); return value; };
	const sessionManager = { getSessionId: () => "parent-serve", getBranch: () => live([]) };
	const sdk = { getAgentDir: () => join(dir, "agent"), CONFIG_DIR_NAME: ".pi", parseSessionEntries: () => [], migrateSessionEntries: () => undefined, ...sdkExtra };
	const ctx: { scopedModels: unknown[] } & Record<string, unknown> = { cwd: dir, scopedModels: [], model: undefined, modelRegistry: {}, sessionManager, ui: { notify: (message: string) => { live(notices).push(message); } }, ...ctxExtra };
	const pi = { getActiveTools: () => live([]), getAllTools: () => live([]), sendMessage: () => live(undefined) };
	const serve = (parked?: ParkedHost, extra: object = {}) => serveSession({ sdk, pi, ctx, generation: 2, parked, route: () => "wake", teamChanged() {}, mailChanged() {}, currentGroup: () => "run-2-0", ...extra } as never);
	return { dir, ctx, notices, sessionManager, serve, replace: () => { replaced = true; }, index: join(dir, "agent", "sessions", "subagents", "parent-serve", "index.json") };
}

const model = (id: string) => ({ provider: "openai-codex", id, name: id });
const allowedRefs = (scope: { allowed: readonly { ref: string }[] }) => scope.allowed.map((choice) => choice.ref);

test("a model scoped after the session start is allowed at once, and one taken out is refused", async () => {
	const pi = fakePi();
	pi.ctx.scopedModels = [{ model: model("gpt-6-luna") }];
	const served = await pi.serve();
	cleanups.push(() => served.close());
	assert.deepEqual(allowedRefs(served.tools), ["openai-codex/gpt-6-luna"]);
	// /scoped-models sets a new list on the session, which `ctx.scopedModels` returns.
	pi.ctx.scopedModels = [{ model: model("gpt-6-luna") }, { model: model("gpt-6.1-terra") }];
	assert.deepEqual(allowedRefs(served.tools), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"], "the tool's check");
	assert.deepEqual(allowedRefs(served.host().ports.models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"], "the launch and resume check");
	assert.match(served.tools.modelTable, /gpt-6\.1-terra/, "the table a refreshed description shows");
	pi.ctx.scopedModels = [{ model: model("gpt-6.1-terra") }];
	assert.deepEqual(allowedRefs(served.host().ports.models()), ["openai-codex/gpt-6.1-terra"]);
	assert.equal(served.tools.fallbackModel, "openai-codex/gpt-6.1-terra");
});

test("a /reload after an enabledModels edit allows the new model, though Pi keeps its old scope", async () => {
	let patterns = ["openai-codex/gpt-6-luna"];
	const asked: string[][] = [];
	const sdkExtra = {
		SettingsManager: { create: () => ({ getEnabledModels: () => patterns }) },
		resolveModelScopeWithDiagnostics: async (wanted: string[]) => {
			asked.push(wanted);
			return { scopedModels: wanted.map((ref) => ({ model: model(ref.split("/")[1]!) })), diagnostics: [] };
		},
	};
	const pi = fakePi(undefined, sdkExtra, { modelRegistry: { runtime: { refresh: () => undefined, getAvailable: async () => [model("gpt-6-luna"), model("gpt-6.1-terra")] } } });
	const stale = [{ model: model("gpt-6-luna") }];
	pi.ctx.scopedModels = stale;
	const first = await pi.serve(undefined, { reason: "startup" });
	await first.close("quit");
	patterns = ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"];
	const second = await pi.serve(undefined, { reason: "reload" });
	cleanups.push(() => second.close());
	assert.deepEqual(asked, [patterns]);
	assert.deepEqual(allowedRefs(second.tools), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"]);
	assert.deepEqual(allowedRefs(second.host().ports.models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"]);
});

test("the subagent tool says why a known model is refused and how to fix it", async () => {
	const sdkExtra = { SettingsManager: { create: () => ({ getEnabledModels: () => ["openai-codex/gpt-6.1-terra"] }) } };
	const registry = { getAll: () => [model("gpt-6-luna"), model("gpt-6.1-terra")] };
	const pi = fakePi(undefined, sdkExtra, { modelRegistry: registry });
	pi.ctx.scopedModels = [{ model: model("gpt-6-luna") }];
	const served = await pi.serve();
	cleanups.push(() => served.close());
	const tool = subagentTool(served.tools, "main");
	await assert.rejects((tool.execute as never as (...args: unknown[]) => Promise<unknown>)("id", { task: "Check", model: "openai-codex/gpt-6.1-terra" }, undefined, undefined),
		/is not one of the allowed models: openai-codex\/gpt-6-luna\. openai-codex\/gpt-6\.1-terra is in enabledModels but not in this session's model scope\. Run \/reload, or enable it with \/scoped-models\./);
	await assert.rejects((tool.execute as never as (...args: unknown[]) => Promise<unknown>)("id", { task: "Check", model: "gpt-9" }, undefined, undefined),
		(error: Error) => /^"gpt-9" is not one of the allowed models: openai-codex\/gpt-6-luna\.$/.test(error.message));
});

/** Ports for a module that claims a host later: what it is told. */
function laterPorts(notices: string[]): HostPorts {
	return {
		send: () => undefined, route: () => "wake", notify: (message) => { notices.push(message); }, teamChanged: () => undefined, mailChanged: () => undefined,
		launcher: { launch: () => Promise.reject(new Error("no launches here")) },
		models: () => ({ allowed: [], fallbackModel: null }),
	};
}

test("a failure to let go of the old team after the swap is told through the host, never through a ctx Pi has replaced", async () => {
	const pi = fakePi();
	let fail!: (error: Error) => void;
	const retiring = new Promise<void>((_resolve, reject) => { fail = reject; });
	// A quiet host from the module before, as an earlier /reload left it.
	const older = {
		version: HOST_VERSION, generation: 1, activity: new ToolActivity(),
		team: { list: () => [] }, mail: { pending: () => [] },
		rebind(ports: HostPorts) { ports.teamChanged(); },
		park() {}, quiet: () => true, handOver: () => () => undefined,
		retire: () => retiring, restore: async () => undefined, close: async () => undefined,
	} as unknown as HostState;
	const served = await pi.serve({ version: HOST_VERSION, claim: () => older, close: async () => undefined });
	assert.equal(served.adopted, true);
	await tick();
	await tick();
	assert.notEqual(served.host(), older, "the quiet old team was swapped for this module's");
	// Pi reloads before the old team has let go, and the next module has not claimed the host yet.
	served.park(pi.sessionManager);
	pi.replace();
	fail(new Error("synthetic retire failure"));
	await tick();
	const next = takeParked(pi.sessionManager)!.claim() as HostState;
	const told: string[] = [];
	next.rebind(laterPorts(told));
	cleanups.push(() => next.close());
	assert.match(told.join("\n"), /synthetic retire failure/, "the next module shows it");
});

test("a park that fails closes the host as a reload did before, so the lease is let go and the next start opens the index", async () => {
	const pi = fakePi();
	const served = await pi.serve();
	// Pi's `ctx` already throws when the host would keep what main's tools were.
	pi.replace();
	await served.park(pi.sessionManager);
	assert.equal(takeParked(pi.sessionManager), undefined, "nothing parked");
	assert.equal(JSON.parse(readFileSync(pi.index, "utf8")).shutdown, "reload");
	const second = await fakePi(pi.dir).serve();
	cleanups.push(() => second.close());
	assert.equal(second.adopted, false);
});

test("a start that waits too long for a host still closing says to run /reload again, not that the lease is owned", async () => {
	const pi = fakePi();
	const served = await pi.serve();
	const host = served.host();
	// Its close never ends, as one whose child won't abort.
	let finish!: () => void;
	const stuck = { ...host, close: () => new Promise<void>((resolve) => { finish = resolve; }) } as HostState;
	parkHost(pi.sessionManager, stuck, { timeoutMs: 5, log: () => undefined });
	await new Promise((resolve) => setTimeout(resolve, 20));
	// The same session, as after a reload, whose start finds that close still under way.
	await assert.rejects(pi.serve(undefined, { closeWaitMs: 20 }), /still closing\. Run \/reload again/);
	finish();
	await host.close();
});

test("main's thinking levels and chat look come from its project's settings only when main trusts the project", async () => {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const { chatSettings, sessionScope, thinkingSettings } = await import("../lib/subagents/serve.ts");
	const dir = mkdtempSync(join(tmpdir(), "subagents-trust-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const agentDir = join(dir, "agent");
	const project = join(dir, "repository");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "high", modelThinkingLevels: { "faux/cheap": "low" }, hideThinkingBlock: true, outputPad: 0 }));
	writeFileSync(join(project, ".pi", "subagent-models.md"), "- project guide\n");
	assert.deepEqual(thinkingSettings(sdk, project, agentDir, false), { modelThinkingLevels: {} });
	assert.deepEqual(chatSettings(sdk, project, agentDir, false), { hideThinking: false, outputPad: 1 });
	assert.deepEqual(thinkingSettings(sdk, project, agentDir, true), { modelThinkingLevels: { "faux/cheap": "low" }, defaultThinkingLevel: "high" });
	assert.deepEqual(chatSettings(sdk, project, agentDir, true), { hideThinking: true, outputPad: 0 });
	const ctx = (trusted: boolean) => ({ cwd: project, scopedModels: [], model: undefined, ui: { notify: () => undefined }, isProjectTrusted: () => trusted });
	const scoped = (trusted: boolean) => sessionScope({ ...sdk, getAgentDir: () => agentDir } as never, ctx(trusted) as never);
	assert.equal(scoped(false).projectTrusted, false);
	assert.equal(scoped(false).thinking.defaultThinkingLevel, undefined, "main's decision, not Pi's default, which trusts");
	assert.equal(scoped(true).thinking.defaultThinkingLevel, "high");
	assert.equal(scoped(false).guide, "", "an untrusted project's guide never reaches main's tool description");
	assert.equal(scoped(true).guide, "- project guide");
});
