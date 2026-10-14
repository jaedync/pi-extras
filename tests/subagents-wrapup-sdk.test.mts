/**
 * Wrap-ups with real child sessions from the pinned SDK, driven by Pi's faux
 * provider: at the budget a tool call is blocked, the loop ends at the turn
 * boundary, the same session writes the report, and a tool call that runs
 * past the grace is aborted without leaving the session unusable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-wrapup-sdk-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");
const { childMessageTool } = await import("../lib/subagents/tools.ts");
const { BUDGET_BLOCKED, childInstructions } = await import("../lib/subagents/format.ts");

type Delivery = import("../lib/subagents/types.ts").MainDelivery;

/** 0.005 minutes: the budget runs out after 300 ms of work. */
const BUDGET = 0.005;
const WRAP_UP = "budget for this run is used up";

async function setup(budgetTimes: Record<string, number>) {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const main: Delivery[] = [];
	let tools: any;
	const sessions = join(agentDir, "sessions", "subagents", `parent-${Math.random().toString(36).slice(2)}`);
	const team = new Team({
		maxConcurrent: 2, maxDepth: 1, replyTimeoutMs: 5_000, budgetTimes: { minNoteMinutes: 1_000, ...budgetTimes },
		sessionFileFor: (name) => join(sessions, `${name}.jsonl`),
		deliverToMain: (delivery) => main.push(delivery),
		launcher: createLauncher({
			sdk: sdk as never, agentDir, cwd: scratch, sessionDir: sessions,
			modelRuntime: async () => runtime,
			toolsFor: (record) => ({ tools: ["bash", "read"], customTools: [childMessageTool(tools, record.name)] }),
			instructions: (record) => childInstructions({ name: record.name, parent: record.parent, readOnly: false, canSpawn: false, roster: "", budget: { minutes: record.maxMinutes } }),
		}),
	});
	tools = { team, replyTimeoutMs: 5_000 };
	return { team, faux, main };
}

/** The session file's messages. */
function messages(file: string): Array<{ role?: string; content?: unknown; isError?: boolean; stopReason?: string }> {
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message);
}
const textOf = (message: { content?: unknown }): string => (typeof message.content === "string" ? message.content
	: Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? "").join("") : "");
const said = (context: any): string => JSON.stringify(context.messages);

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${what} within ${ms / 1000} s`);
}

test("at the budget a real session's tool call is blocked, its loop ends at the turn boundary, and the same session writes the report", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
	const { team, faux, main } = await setup({});
	const marker = join(scratch, "blocked-marker");
	let open!: () => void;
	const gate = new Promise<void>((resolve) => { open = resolve; });
	let sawBudget = false;
	faux.setResponses([
		async (context: any) => {
			sawBudget = JSON.stringify(context).includes("## Budget");
			// This reply streams past the limit: its call must not run.
			await gate;
			return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `touch ${marker}` }));
		},
		(context: any) => ai.fauxAssistantMessage(said(context).includes(WRAP_UP) ? "Wrap-up report: nothing ran after the limit." : "unexpected"),
	]);
	assert.ok(team.spawn({ name: "worker", task: "Touch the marker", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, maxMinutes: BUDGET }).ok);
	await until("worker wraps up", () => team.get("worker")?.activity?.startsWith("wrapping up") === true);
	assert.deepEqual(await team.send("main", "worker", "A late note."), { ok: true, delivered: "steered" });
	open();
	const done = await team.whenDone("worker");
	assert.equal(done.state, "idle", done.error);
	assert.equal(done.budgetEnd, `over its ${BUDGET}-minute budget`);
	assert.equal(done.report, "Wrap-up report: nothing ran after the limit.");
	assert.ok(sawBudget, "the child's instructions name its budget");
	assert.equal(existsSync(marker), false, "the blocked call did not run");
	const transcript = messages(done.sessionFile!);
	const result = transcript.find((message) => message.role === "toolResult");
	assert.equal(result?.isError, true);
	assert.match(textOf(result!), new RegExp(BUDGET_BLOCKED.replace(/[.']/g, "\\$&")));
	const users = transcript.filter((message) => message.role === "user").map(textOf);
	assert.equal(users.length, 2, "its task, then the wrap-up prompt, in one session file");
	assert.match(users[1]!, /^Your 0\.005-minute budget for this run is used up\./);
	assert.ok(!users.some((text) => text.includes("A late note.")), "mail during the wrap-up is not read in it");
	assert.deepEqual(done.inbox, ["Message from main:\nA late note."], "it waits for the next run");
	assert.equal(transcript.filter((message) => message.role === "assistant" && message.stopReason === "aborted").length, 0, "nothing was aborted");
	const report = main.find((delivery) => delivery.kind === "report");
	assert.equal(report?.kind === "report" && report.record.budgetEnd, done.budgetEnd);
	await team.close();
});

test("a tool call that runs past the grace is aborted, and the same session takes the wrap-up prompt", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
	const { team, faux } = await setup({ toolGraceMs: 300 });
	const marker = join(scratch, "slow-marker");
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `sleep 20; touch ${marker}` })),
		(context: any) => ai.fauxAssistantMessage(said(context).includes(WRAP_UP) ? "Report after the abort: the slow step did not finish." : "unexpected"),
	]);
	const started = Date.now();
	assert.ok(team.spawn({ name: "slow", task: "Run the slow step", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, maxMinutes: BUDGET }).ok);
	const done = await team.whenDone("slow");
	assert.equal(done.state, "idle", done.error);
	assert.equal(done.budgetEnd, `over its ${BUDGET}-minute budget`);
	assert.equal(done.report, "Report after the abort: the slow step did not finish.");
	assert.ok(Date.now() - started < 15_000, "the slow call did not run to its end");
	assert.equal(existsSync(marker), false);
	const users = messages(done.sessionFile!).filter((message) => message.role === "user").map(textOf);
	assert.equal(users.length, 2);
	assert.match(users[1]!, /used up/);
	await team.close();
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
