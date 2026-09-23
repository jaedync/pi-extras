import assert from "node:assert/strict";
import test from "node:test";
import { CodeExecutor } from "../lib/computer-use/executor.ts";
import type { CallOptions, ToolResult } from "../lib/computer-use/session.ts";

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], isError });

function fakeSession(handler: (tool: string, args: Record<string, unknown>) => Promise<ToolResult> | ToolResult = (tool) => text(`${tool} ok`)) {
	const calls: string[] = [];
	return {
		calls,
		session: {
			async call(tool: string, args: Record<string, unknown>, _options: CallOptions) {
				calls.push(tool);
				return handler(tool, args);
			},
		},
	};
}

const approve = async () => "once" as const;

test("runs agent code against sky and returns only what it emits", async () => {
	const { session, calls } = fakeSession();
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`const apps = await sky.list_apps(); emit(apps); emit({ n: 2 }); await sky.click({ app: "X", element_index: "1" });`, { approve });
	assert.deepEqual(result.content, [{ type: "text", text: "list_apps ok" }, { type: "text", text: '{\n  "n": 2\n}' }]);
	assert.deepEqual(calls, ["list_apps", "click"]);
	assert.equal(result.error, undefined);
});

test("get_app_state gives a tree and a screenshot handle that emitImage turns into an image", async () => {
	const { session } = fakeSession(() => ({ content: [{ type: "text", text: "tree" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false }));
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`const s = await sky.get_app_state({ app: "Finder" }); emit(s.text); emit(typeof s.screenshot.data); emitImage(s.screenshot);`, { approve });
	assert.deepEqual(result.content, [{ type: "text", text: "tree" }, { type: "text", text: "undefined" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
});

test("store survives between runs and must stay JSON", async () => {
	const executor = new CodeExecutor({ session: fakeSession().session });
	await executor.execute(`store.count = 1;`, { approve });
	const second = await executor.execute(`store.count += 1; emit(store.count);`, { approve });
	assert.deepEqual(second.content, [{ type: "text", text: "2" }]);
});

test("a failed Computer Use call throws inside the code, where it can be caught", async () => {
	const { session } = fakeSession((tool) => tool === "click" ? text("no such element", true) : text("ok"));
	const executor = new CodeExecutor({ session });
	const caught = await executor.execute(`try { await sky.click({ app: "X", element_index: "9" }); } catch (e) { emit("caught: " + e.message); }`, { approve });
	assert.deepEqual(caught.content, [{ type: "text", text: "caught: no such element" }]);
	const uncaught = await executor.execute(`emit("before"); await sky.click({ app: "X", element_index: "9" }); emit("after");`, { approve });
	assert.equal(uncaught.error, "no such element");
	assert.deepEqual(uncaught.content.map((block) => block.type === "text" ? block.text : ""), ["before", "Computer Use code stopped: no such element"]);
});

test("a runaway loop is stopped without waiting on Computer Use calls", async () => {
	const executor = new CodeExecutor({ session: fakeSession().session, sliceMs: 100 });
	const result = await executor.execute(`emit("start"); while (true) {}`, { approve });
	assert.match(result.error ?? "", /100 ms between Computer Use calls/);
	assert.deepEqual(result.content[0], { type: "text", text: "start" });
});

test("time spent inside a Computer Use call does not count against the code", async () => {
	const { session } = fakeSession(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); return text("slow ok"); });
	const executor = new CodeExecutor({ session, sliceMs: 100 });
	const result = await executor.execute(`emit(await sky.list_apps());`, { approve });
	assert.deepEqual(result.content, [{ type: "text", text: "slow ok" }]);
});

test("the caller's signal cancels a run", async () => {
	const executor = new CodeExecutor({ session: fakeSession().session });
	const controller = new AbortController();
	const pending = executor.execute(`await new Promise(() => {});`, { approve, signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(pending, /cancelled/);
});

test("code has no Node or code-generation escape hatches", async () => {
	const executor = new CodeExecutor({ session: fakeSession().session });
	const result = await executor.execute(`emit([typeof require, typeof process, typeof fetch].join(",")); try { eval("1"); } catch (e) { emit("eval blocked"); }`, { approve });
	assert.deepEqual(result.content, [{ type: "text", text: "undefined,undefined,undefined" }, { type: "text", text: "eval blocked" }]);
});

test("long output is clipped with a note instead of flooding the context", async () => {
	const executor = new CodeExecutor({ session: fakeSession().session, maxTextChars: 50 });
	const result = await executor.execute(`emit("x".repeat(40)); emit("y".repeat(40));`, { approve });
	const all = result.content.map((block) => block.type === "text" ? block.text : "").join("");
	assert.match(all, /^x{40}y{10}/);
	assert.match(all, /30 more characters clipped/);
});

test("emitting a value JSON cannot represent gives text instead of breaking the run", async () => {
	const executor = new CodeExecutor({ session: fakeSession().session });
	const result = await executor.execute(`emit(() => 1); emit(Symbol("s")); emit("after");`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(result.content.map((block) => block.type === "text" ? block.text : ""), ["() => 1", "Symbol(s)", "after"]);
});
