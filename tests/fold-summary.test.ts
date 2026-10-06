import assert from "node:assert/strict";
import { test } from "node:test";
import { foldPhrase as phrase, foldStats, phraseText, type FoldFacts } from "../lib/fold/summary.ts";

const foldPhrase = (facts: FoldFacts) => phraseText(phrase(facts));

const tool = (name: string, running = false, failed = false) => ({ name, running, failed });
const facts = (over: Partial<FoldFacts> = {}): FoldFacts => ({ tools: [], live: false, tokens: 0, cost: 0, ...over });

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
	assert.equal(foldPhrase(facts({ tools: [tool("usage"), tool("usage"), tool("x\x1b[31m")] })), "Called usage 2 times, called x");
	assert.equal(foldPhrase(facts({ tools: [tool("mcp__oc__web_search")] })), "Searched the web 1 time");
});

test("pi-extras and Pi tools share their kinds", () => {
	const text = foldPhrase(facts({ tools: [tool("shell_job_start"), tool("subagent"), tool("fetch_content"), tool("fetch_content"), tool("codemode"), tool("write"), tool("ls"), tool("find")] }));
	assert.equal(text, "Started 1 background job, started 1 subagent, fetched 2 pages, ran 1 script, wrote 1 file, listed 1 folder, searched for 1 pattern");
});

test("stats give tokens, cost and time; zero cost and unknown time are left out", () => {
	assert.deepEqual(foldStats(facts({ tools: [tool("read"), tool("bash", false, true)], tokens: 1_620, cost: 0.214, elapsedMs: 8_400 })), ["1.6k tokens", "$0.21", "8.4s"], "the words count the calls already");
	assert.deepEqual(foldStats(facts({ tools: [tool("read")], tokens: 12 })), ["12 tokens"]);
	assert.deepEqual(foldStats(facts({ tools: [tool("read")], cost: 0.0042 })), ["$0.0042"]);
	assert.deepEqual(foldStats(facts({ live: true, elapsedMs: 441 })), ["0.4s"]);
	assert.deepEqual(foldStats(facts({ tokens: 30, elapsedMs: 2_500 })), ["30 tokens"], "a Thought line says its time in its words");
});
