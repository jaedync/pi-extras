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
	assert.deepEqual(foldStats(facts({ tokens: 30, sent: 288_000, elapsedMs: 2_500 })), [], "a settled Thought line says its time in its words, and shows no figures");
	assert.deepEqual(foldStats(facts({ live: true, tokens: 30, sent: 288_000, elapsedMs: 2_500 })), ["↑288k ↓30", "2.5s"], "live thinking still counts up");
});

test("a time below a second keeps its tenths and never reads 0.0s", () => {
	assert.equal(foldPhrase(facts({ elapsedMs: 40 })), "Thought for 0.1s");
	assert.deepEqual(foldStats(facts({ live: true, elapsedMs: 40 })), ["0.1s"]);
});

test("an edit or write names its file when every call of the kind touched one file", () => {
	const file = (name: string, path?: string) => ({ ...tool(name), ...(path ? { file: path } : {}) });
	assert.equal(foldPhrase(facts({ tools: [tool("bash"), file("edit", "footer.ts")] })), "Ran 1 command, edited footer.ts");
	assert.equal(foldPhrase(facts({ tools: [file("edit", "footer.ts"), file("edit", "footer.ts")] })), "Edited footer.ts", "two edits of one file");
	assert.equal(foldPhrase(facts({ tools: [file("edit", "a.ts"), file("edit", "b.ts")] })), "Edited 2 files");
	assert.equal(foldPhrase(facts({ tools: [file("write", "a.ts"), file("write")] })), "Wrote 2 files", "a call whose path is not known yet");
	assert.equal(foldPhrase(facts({ tools: [file("read", "a.ts")] })), "Read 1 file", "reads are counted, not named");
	assert.equal(foldPhrase(facts({ live: true, tools: [{ ...file("edit", "a.ts"), running: true }] })), "Editing a.ts");
	assert.equal(foldPhrase(facts({ tools: [file("edit", "a.ts"), tool("read")] }), true), "Used 2 tools", "the brief form still counts");
});

test("one failed call is named; more are counted", () => {
	const failed = (label?: string) => ({ ...tool("bash", false, true), ...(label ? { label } : {}) });
	assert.deepEqual(phrase(facts({ tools: [failed("ls node_modules"), tool("read")] })).failed, "ls node_modules failed");
	assert.deepEqual(phrase(facts({ tools: [failed("a"), failed("b")] })).failed, "2 failed");
	assert.deepEqual(phrase(facts({ tools: [failed()] })).failed, "1 failed", "no label known");
	assert.deepEqual(phrase(facts({ tools: [failed("ls node_modules")] }), true).failed, "1 failed", "the brief form counts");
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

test("a call the model still writes says so, not what it will do once it runs", () => {
	const writing = (name: string, file?: string) => ({ name, running: true, failed: false, writing: true, ...(file ? { file } : {}) });
	assert.equal(foldPhrase(facts({ live: true, tools: [writing("subagent")] })), "Writing subagent call");
	assert.equal(foldPhrase(facts({ live: true, tools: [tool("read"), writing("artifact_publish")] })), "Read 1 file, writing artifact_publish call");
	assert.equal(foldPhrase(facts({ live: true, tools: [writing("bash"), writing("bash")] })), "Writing 2 bash calls");
	assert.equal(foldPhrase(facts({ live: true, tools: [tool("bash", true), writing("bash")] })), "Running 2 commands", "one runs already");
	assert.equal(foldPhrase(facts({ live: true, tools: [writing("edit", "a.ts")] })), "Editing a.ts", "a file tool names its file");
	assert.equal(foldPhrase(facts({ live: true, tools: [writing("subagent")] }), true), "Using 1 tool", "brief");
});
