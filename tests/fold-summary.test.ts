import assert from "node:assert/strict";
import { test } from "node:test";
import { foldPhrase as phrase, foldStats, phraseText, type FoldFacts } from "../lib/fold/summary.ts";

const foldPhrase = (facts: FoldFacts, brief = false) => phraseText(phrase(facts, brief));

const tool = (name: string, running = false, failed = false) => ({ name, running, failed });
const facts = (over: Partial<FoldFacts> = {}): FoldFacts => ({ tools: [], live: false, tokens: 0, ...over });

test("finished calls are counted by kind, in the order they first ran", () => {
	const text = foldPhrase(facts({ tools: [tool("grep"), tool("read"), tool("read"), tool("bash"), tool("edit"), tool("bash")] }));
	assert.equal(text, "Searched for 1 pattern, read 2 files, ran 2 commands, edited 1 file");
});

test("a kind with a call still going reads in the present tense", () => {
	const text = foldPhrase(facts({ live: true, tools: [tool("read"), tool("bash", true)] }));
	assert.equal(text, "Read 1 file, running 1 command");
});

test("live work with no call going says the model is thinking", () => {
	assert.equal(foldPhrase(facts({ live: true, tools: [tool("read")] })), "Read 1 file, thinking");
	assert.equal(foldPhrase(facts({ live: true })), "Thinking");
});

test("failures come before what the model does now", () => {
	assert.deepEqual(phrase(facts({ live: true, tools: [tool("bash", false, true)] })), { said: "Ran 1 command", failed: "1 failed", after: "thinking" });
	assert.equal(foldPhrase(facts({ tools: [tool("bash", false, true), tool("read")] })), "Ran 1 command, read 1 file, 1 failed");
});

test("finished work with no calls was thinking", () => {
	assert.equal(foldPhrase(facts()), "Thought");
	assert.equal(foldPhrase(facts({ elapsedMs: 2_500 })), "Thought for 2.5s", "the time moves into the words");
});

test("other tools are named, and names are cleaned", () => {
	assert.equal(foldPhrase(facts({ tools: [tool("usage"), tool("usage")] })), "Called usage 2 times");
	assert.equal(foldPhrase(facts({ tools: [tool("x\x1b[31m")] })), "Called x");
	assert.equal(foldPhrase(facts({ tools: [tool("mcp__oc__web_search")] })), "Searched the web 1 time");
});

test("pi-extras and Pi tools share their kinds", () => {
	const text = foldPhrase(facts({ tools: [tool("shell_job_start"), tool("subagent"), tool("fetch_content"), tool("fetch_content"), tool("codemode"), tool("write"), tool("ls"), tool("find")] }));
	assert.equal(text, "Started 1 background job, started 1 subagent, fetched 2 pages, ran 1 script, wrote 1 file, listed 1 folder, searched for 1 pattern");
});

test("stats give tokens sent and received, and time; an unknown time is left out", () => {
	assert.deepEqual(foldStats(facts({ tools: [tool("read"), tool("bash", false, true)], sent: 288_214, tokens: 1_620, elapsedMs: 8_400 })), ["↑288k ↓1.6k", "8.4s"], "the words count the calls already");
	assert.deepEqual(foldStats(facts({ tools: [tool("read")], tokens: 12 })), ["↓12"]);
	assert.deepEqual(foldStats(facts({ tools: [tool("read")], sent: 1 })), ["↑1"]);
	assert.deepEqual(foldStats(facts({ tools: [tool("read")] })), [], "cost shows only on the end line");
	assert.deepEqual(foldStats(facts({ live: true, elapsedMs: 441 })), ["0.4s"]);
	assert.deepEqual(foldStats(facts({ tokens: 30, elapsedMs: 2_500 })), ["↓30"], "a Thought line says its time in its words");
});

test("a call can count as several: each step of a chained command, each call inside a script", () => {
	const text = foldPhrase(facts({ tools: [{ ...tool("bash"), count: 3 }, tool("read"), { ...tool("codemode", false, true), count: 0 }] }));
	assert.equal(text, "Ran 3 commands, read 1 file, 1 failed", "a script whose calls are counted is not counted again, but its failure is");
});

test("other tools are counted together when they are many or their names are long", () => {
	const many = Array.from({ length: 22 }, () => [tool("mcp__playwright__browser_navigate"), tool("mcp__playwright__browser_evaluate")]).flat();
	assert.equal(foldPhrase(facts({ tools: many })), "Used 44 tools");
	assert.equal(foldPhrase(facts({ tools: [tool("mcp__playwright__browser_navigate")] })), "Used 1 tool", "a long name is not spelled out");
	assert.equal(foldPhrase(facts({ tools: [tool("read"), tool("usage"), tool("agent_request")] })), "Read 1 file, used 2 other tools");
	assert.equal(foldPhrase(facts({ live: true, tools: [tool("usage"), tool("agent_request", true)] })), "Using 2 tools");
});

test("the brief form is the total count of calls", () => {
	const tools = [{ ...tool("bash"), count: 3 }, tool("read"), tool("edit", true), tool("bash", false, true)];
	assert.deepEqual(phrase(facts({ live: true, tools }), true), { said: "Using 6 tools", failed: "1 failed" });
	assert.equal(foldPhrase(facts({ tools: [tool("read")] }), true), "Used 1 tool");
	assert.equal(foldPhrase(facts({ elapsedMs: 900 }), true), "Thought for 0.9s", "no calls: nothing to count");
});
