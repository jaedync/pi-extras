/**
 * Checks, `after` and direct review loops with real child sessions from the
 * pinned SDK, driven by Pi's faux provider. Main is a MainMail whose port
 * counts the messages that would start a turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-ux-sdk-"));
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
const { childInstructions } = await import("../lib/subagents/format.ts");
const { MainMail } = await import("../lib/subagents/deliver.ts");
const { stillWorking } = await import("../lib/subagents/status.ts");

type Delivery = import("../lib/subagents/types.ts").MainDelivery;
type Router = (context: any) => unknown;

/** A team of real child sessions in `cwd`, a main that counts its wakes, and the faux model answering through `route`. */
async function setup(route: Router) {
	const cwd = mkdtempSync(join(scratch, "work-"));
	const sessionDir = mkdtempSync(join(agentDir, "sessions-"));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	faux.setResponses(Array.from({ length: 60 }, () => route));
	const delivered: Delivery[] = [];
	const wakes: string[] = [];
	const box: { team?: InstanceType<typeof Team> } = {};
	const mail = new MainMail({
		batchMs: 5,
		port: { send: (message, options) => { if (options.triggerTurn) wakes.push(message.content); } },
		status: (except) => stillWorking(box.team!.list(), except, Date.now()),
	});
	let tools: any;
	const team = new Team({
		maxConcurrent: 4, maxDepth: 1, replyTimeoutMs: 10_000,
		sessionFileFor: (name) => join(sessionDir, `${name}.jsonl`),
		deliverToMain: (delivery) => { delivered.push(delivery); mail.deliver(delivery); },
		launcher: createLauncher({
			sdk: sdk as never, agentDir, cwd, sessionDir,
			modelRuntime: async () => runtime,
			toolsFor: (record) => ({ tools: ["read", "bash"], customTools: [childMessageTool(tools, record.name)] }),
			instructions: (record) => childInstructions({ name: record.name, parent: record.parent, readOnly: false, canSpawn: false, roster: "" }),
		}),
	});
	box.team = team;
	tools = { team, replyTimeoutMs: 10_000 };
	const spawn = (name: string, task: string, extra: object = {}) => {
		const result = team.spawn({ name, task, parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, result.ok ? "" : result.error);
	};
	return { team, cwd, delivered, wakes, spawn, close: async () => { mail.dispose(); await team.close(); } };
}

const said = (message: any): string => typeof message?.content === "string" ? message.content
	: (message?.content ?? []).map((part: any) => part.text ?? "").join("");
const agentOf = (context: any): string | undefined => JSON.stringify(context).match(/You are the subagent \\"([a-z0-9-]+)\\"/)?.[1];
const firstPrompt = (team: InstanceType<typeof Team>, name: string): string => said(team.messages(name).find((message: any) => message.role === "user"));

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400 && !check(); i++) await sleep(25);
	assert.ok(check(), `timed out waiting for ${what}`);
}

test("a check that passes runs in the child's directory, and the report and its file end with the evidence", { timeout: 30_000 }, async () => {
	const t = await setup((context) => context.messages.at(-1)?.role === "toolResult"
		? ai.fauxAssistantMessage("Wrote done.txt.")
		: ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "printf ready > done.txt" })));
	try {
		t.spawn("writer", "Write done.txt", { check: { command: "test -f done.txt && echo CHECK-OK", fixUntilPass: 0 } });
		const done = await t.team.whenDone("writer");
		assert.equal(done.state, "idle", done.error);
		assert.equal(done.checked?.exitCode, 0);
		assert.equal(readFileSync(join(t.cwd, "done.txt"), "utf8"), "ready");
		const saved = readFileSync(done.reportFile!, "utf8");
		assert.match(saved, /^Wrote done\.txt\.\n\nCheck run by the harness, not by the agent: passed \(exit 0\) in \d+s\.\nCommand: test -f done\.txt && echo CHECK-OK\nLast lines of output:\n```\nCHECK-OK\n```$/);
		await sleep(30);
		assert.equal(t.wakes.length, 1);
		assert.match(t.wakes[0]!, /Wrote done\.txt\.[\s\S]*passed \(exit 0\)/);
	} finally { await t.close(); }
});

test("a check that fails goes back to the child once, passes, and main is woken once with the final result", { timeout: 30_000 }, async () => {
	const prompts: string[] = [];
	const t = await setup((context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return ai.fauxAssistantMessage("Fixed: fixed.txt exists now. Full report: the task is done.");
		prompts.push(said(last));
		return said(last).includes("The harness ran your check")
			? ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "touch fixed.txt" }))
			: ai.fauxAssistantMessage("Done, I think.");
	});
	try {
		t.spawn("fixer", "Make fixed.txt exist", { check: { command: "test -f fixed.txt", fixUntilPass: 1 } });
		const done = await t.team.whenDone("fixer");
		assert.equal(done.state, "idle", done.error);
		assert.equal(done.runs, 1, "the fix round is part of the same run");
		assert.equal(prompts.length, 2);
		assert.match(prompts[1]!, /failed \(exit 1\) in \d+s, attempt 1 of 2\.\nCommand: test -f fixed\.txt/);
		assert.ok(existsSync(join(t.cwd, "fixed.txt")));
		await sleep(30);
		assert.equal(t.wakes.length, 1, "main hears only the final report");
		assert.match(t.wakes[0]!, /Fixed: fixed\.txt exists now\.[\s\S]*passed \(exit 0\) in \d+s, attempt 2 of 2\./);
		assert.doesNotMatch(t.wakes[0]!, /Done, I think/);
	} finally { await t.close(); }
});

test("an after chain: B starts only when A has ended, with A's report path, and main wakes once", { timeout: 30_000 }, async () => {
	const flag = join(scratch, "release-a");
	const t = await setup((context) => {
		const name = agentOf(context);
		if (name === "a") {
			return context.messages.at(-1)?.role === "toolResult" ? ai.fauxAssistantMessage("A's plan: three steps.")
				: ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `until [ -f ${flag} ]; do sleep 0.05; done; echo released` }));
		}
		return ai.fauxAssistantMessage("B followed A's plan.");
	});
	try {
		t.spawn("a", "Plan the work");
		t.spawn("b", "Follow a's plan", { after: ["a"] });
		await until(() => t.team.get("a")?.activity?.startsWith("bash") === true, "a waits in bash");
		assert.equal(t.team.get("b")?.state, "queued");
		assert.equal(t.team.get("b")?.activity, "after a");
		assert.equal(t.team.get("b")?.startedAt, undefined);
		writeFileSync(flag, "");
		const b = await t.team.whenDone("b");
		const a = t.team.get("a")!;
		assert.equal(b.state, "idle", b.error);
		assert.ok(b.startedAt! >= a.endedAt!, "B started after A ended");
		const prompt = firstPrompt(t.team, "b");
		assert.ok(prompt.startsWith("Follow a's plan\n\n## Agents you started after"), prompt);
		assert.ok(prompt.includes(`- a finished. Report: ${a.reportFile}`), prompt);
		assert.equal(readFileSync(a.reportFile!, "utf8"), "A's plan: three steps.");
		assert.ok(!prompt.includes("three steps"), "the report text stays out of the prompt");
		await sleep(30);
		assert.deepEqual(t.delivered.map((d) => d.kind === "report" ? [d.record.name, d.quiet === true] : d.kind), [["a", true], ["b", false]]);
		assert.equal(t.wakes.length, 1);
	} finally { await t.close(); }
});

test("a reviewer and an implementer loop two rounds by message; main wakes once and never sees their notes", { timeout: 30_000 }, async () => {
	const t = await setup((context) => {
		const name = agentOf(context);
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return ai.fauxAssistantMessage(name === "impl" ? "Answered review." : "Sent a finding; waiting for impl.");
		const text = said(last);
		if (name === "impl") {
			const round = text.match(/Finding (\d)/)?.[1];
			return round ? ai.fauxAssistantMessage(ai.fauxToolCall("message", { to: "review", text: `Fixed finding ${round}.` }))
				: ai.fauxAssistantMessage("Implemented the parser.");
		}
		if (text.includes("Fixed finding 2")) return ai.fauxAssistantMessage("Approved: the parser is right after two rounds.");
		const round = text.includes("Fixed finding 1") ? 2 : 1;
		return ai.fauxAssistantMessage(ai.fauxToolCall("message", { to: "impl", text: `Finding ${round}: fix it.`, expectReply: true }));
	});
	try {
		t.spawn("impl", "Implement the parser");
		t.spawn("review", "Review impl's parser. Iterate with impl directly, then report.", { after: ["impl"] });
		await until(() => t.team.get("review")?.state === "idle" && t.team.get("impl")?.state === "idle", "review approves and impl ends");
		await sleep(50);
		const reviewSaw = t.team.messages("review").filter((message: any) => message.role === "user").map(said).join("\n");
		assert.match(reviewSaw, /Fixed finding 1\.[\s\S]*Fixed finding 2\./, "two rounds");
		assert.equal(t.delivered.filter((d) => d.kind !== "report").length, 0, "no note between them reaches main");
		// impl's run that answers a round may still be going when the next round arrives, which then steers into it,
		// and its last report may land after review's.
		const reports = t.delivered.map((d) => d.kind === "report" ? `${d.record.name}${d.quiet ? " (quiet)" : ""}` : d.kind);
		assert.deepEqual(reports.filter((report) => report.startsWith("review")), ["review"]);
		assert.ok(reports.length >= 3 && reports.filter((report) => report.startsWith("impl")).every((report) => report === "impl (quiet)"), reports.join(", "));
		assert.equal(t.wakes.length, 1, "one turn for main");
		assert.match(t.wakes[0]!, /Approved: the parser is right after two rounds\./);
	} finally { await t.close(); }
});
