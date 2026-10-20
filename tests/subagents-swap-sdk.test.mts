/**
 * Swaps with real child sessions (support/reload-harness.mts): a child whose
 * session went stale in a multi-turn run, after a settings change or a real
 * /reload, moves to a new session at its next turn boundary, as one run with
 * one report and the steering it had not read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, ai, type Asked, copyPackage, extrasConfig, type Parent, parent, removeScratch, until } from "./support/reload-harness.mts";

/** A prompt without the budget clock line a run that goes on starts with. */
const withoutClock = (text: string): string => text.replace(/^\[Budget clock\] [^\n]*\n\n/, "");

// A child may start subagents of its own here, for the wait: true test.
extrasConfig({ maxDepth: 2 });

const NOTE = "Your session moved to current code and settings.";
const SETTINGS = join(agentDir, "settings.json");
const swapLog = (): string => (existsSync(join(agentDir, "subagents", "swaps.log")) ? readFileSync(join(agentDir, "subagents", "swaps.log"), "utf8") : "");
const toolResults = (asked: Asked): number => asked.context.messages.filter((message: { role?: string }) => message.role === "toolResult").length;

/** Two steps in bash, each waiting for its flag (`<name>-1`, `<name>-2`), then a report that says what it saw. */
function twoSteps(asked: Asked): unknown {
	const { name, build, flags, said } = asked;
	const step = toolResults(asked) + 1;
	if (step <= 2) return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `echo ${name}-step-${step}-on-build-${build}; until [ -f ${join(flags, `${name}-${step}`)} ]; do sleep 0.05; done` }));
	return ai.fauxAssistantMessage(`${name} done on build ${build}; steering ${said.includes("Also check the docs.") ? "seen" : "missing"}`);
}

const release = (p: Parent, flag: string) => writeFileSync(join(p.flags, flag), "");

/** The session file's messages. */
function entries(p: Parent, name: string): Array<{ role?: string; stopReason?: string; content?: unknown }> {
	return p.transcript(name).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message);
}

/** Every user message's text, in order. */
const userTexts = (p: Parent, name: string): string[] => entries(p, name).filter((message) => message.role === "user")
	.map((message) => (Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? "").join("") : String(message.content)));

test("a settings change moves a child to a new session at its next turn boundary: one run, one report, its budget and its steering kept", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root, { answer: (asked) => (asked.name === "multi" ? twoSteps(asked) : undefined) });
	try {
		await p.spawn("multi", "Work in two steps");
		await until("multi waits in its first step", () => p.transcript("multi").includes("multi-step-1-on-build-1"));
		const before = p.record("multi");
		await p.send("multi", "Also check the docs.");
		writeFileSync(SETTINGS, JSON.stringify({ hideThinkingBlock: true }));
		release(p, "multi-1");
		await until("multi waits in its second step, in a new session", () => p.transcript("multi").includes("multi-step-2-on-build-1"));
		const moved = p.record("multi");
		assert.equal(moved.runs, 1, "the same run");
		assert.equal(moved.startedAt, before.startedAt, "its time counts from where the run began");
		assert.equal(moved.runCost, before.runCost);
		assert.equal(moved.maxMinutes, before.maxMinutes);
		assert.match(swapLog(), /multi: run 1 moved to a new session at a turn boundary \(settings\.json changed\)/);
		const texts = userTexts(p, "multi");
		assert.equal(texts.length, 2, "its task, then one prompt for the move");
		// The run goes on with its budget clock first (budget.ts), then the note of the move.
		assert.ok(withoutClock(texts[1]!).startsWith(`[${NOTE}`) && texts[1]!.includes("Also check the docs."), texts[1]);
		assert.match(texts[1]!, /^\[Budget clock\] \d+(?:\.\d)? of 60 work minutes used, /);
		assert.equal(entries(p, "multi").filter((message) => message.role === "assistant" && message.stopReason === "aborted").length, 0, "no aborted reply is left behind");
		release(p, "multi-2");
		await until("multi finishes", () => p.record("multi")?.state === "idle");
		assert.equal(p.record("multi").report, "multi done on build 1; steering seen");
		assert.equal(p.record("multi").runs, 1);
		assert.equal(p.record("multi").unread, undefined);
		await until("its report reaches main", () => p.reports("multi done") > 0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(p.reports("multi done"), 1, "one report");
		assert.equal(swapLog().split("multi:").length - 1, 1, "one move");
	} finally { await p.close(); }
});

test("after a real /reload, a child in a multi-turn run moves to the new code at its next turn boundary", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root, { answer: (asked) => (asked.name === "across" ? twoSteps(asked) : undefined) });
	try {
		await p.spawn("across", "Work across the reload");
		await until("across waits in its first step", () => p.transcript("across").includes("across-step-1-on-build-1"));
		code.rebuild();
		await p.session.reload();
		assert.equal(p.record("across")?.state, "running", "the reload interrupts nothing");
		release(p, "across-1");
		await until("its second step runs the new code", () => p.transcript("across").includes("across-step-2-on-build-2"));
		release(p, "across-2");
		await until("across finishes", () => p.record("across")?.state === "idle");
		assert.equal(p.record("across").report, "across done on build 2; steering missing");
		assert.equal(p.record("across").runs, 1);
		assert.match(swapLog(), /across: run 1 moved to a new session at a turn boundary \(new code\)/);
		await until("its report reaches main", () => p.reports("across done") > 0);
		assert.equal(p.reports("across done"), 1);
	} finally { await p.close(); }
});

test("a child blocked in a subagent call with wait: true does not move until the call returns, then moves at that turn's end", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const lead = (asked: Asked): unknown => {
		if (toolResults(asked) === 0) return ai.fauxAssistantMessage(ai.fauxToolCall("subagent", { name: "kid", task: "Help the lead", model: "faux/cheap", wait: true }));
		return ai.fauxAssistantMessage(`lead done; ${asked.said.includes(NOTE) ? "moved" : "stayed"}`);
	};
	const p = await parent(copyPackage().root, { answer: (asked) => (asked.name === "lead" ? lead(asked) : undefined) });
	try {
		await p.spawn("lead", "Lead with a blocking helper");
		await until("kid waits in bash under lead's blocking call", () => p.transcript("kid").includes('"name":"bash"'));
		writeFileSync(SETTINGS, JSON.stringify({ hideThinkingBlock: false }));
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.doesNotMatch(swapLog(), /lead: /, "no move while its call waits");
		assert.equal(userTexts(p, "lead").length, 1);
		assert.equal(p.record("lead").state, "running");
		p.release("kid");
		await until("lead finishes", () => p.record("lead")?.state === "idle");
		assert.equal(p.record("lead").report, "lead done; moved", "it moved once the call returned");
		assert.equal(p.record("lead").runs, 1);
		assert.match(swapLog(), /lead: run 1 moved to a new session at a turn boundary \(settings\.json changed\)/);
		assert.ok(withoutClock(userTexts(p, "lead")[1] ?? "").startsWith(`[${NOTE}`));
		await until("lead's report reaches main", () => p.reports("lead done") > 0);
		assert.equal(p.reports("lead done"), 1);
	} finally { await p.close(); }
});

test("a child that reaches a turn boundary while Pi reloads moves to the next module's code once it binds", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root, { answer: (asked) => (asked.name === "mid" ? twoSteps(asked) : undefined) });
	try {
		await p.spawn("mid", "Work while Pi reloads");
		await until("mid waits in its first step", () => p.transcript("mid").includes("mid-step-1-on-build-1"));
		code.rebuild();
		await p.session.reload({ beforeSessionStart: async () => {
			release(p, "mid-1");
			await until("mid moves while parked", () => /mid: run 1 moved/.test(swapLog()));
		} });
		await until("its second step runs the next module's code", () => p.transcript("mid").includes("mid-step-2-on-build-2"));
		release(p, "mid-2");
		await until("mid finishes", () => p.record("mid")?.state === "idle");
		assert.equal(p.record("mid").report, "mid done on build 2; steering missing");
		assert.equal(p.record("mid").runs, 1);
		await until("its report reaches main", () => p.reports("mid done") > 0);
		assert.equal(p.reports("mid done"), 1);
	} finally { await p.close(); }
});

test.after(removeScratch);
