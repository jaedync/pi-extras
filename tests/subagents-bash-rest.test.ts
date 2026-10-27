/**
 * A child's bash call that begins with a long `sleep` gives its slot to the
 * next agent in line for the sleep (bash-rest.ts), and the rest of the
 * command runs as the child wrote it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { leadingSleep, restingBash } from "../lib/subagents/bash-rest.ts";

test("a leading sleep is read with its unit and what follows it", () => {
	assert.deepEqual(leadingSleep("sleep 240; cd /repo && git status"), { ms: 240_000, rest: "cd /repo && git status" });
	assert.deepEqual(leadingSleep("  sleep 5m && gh run list"), { ms: 300_000, rest: "gh run list" });
	assert.deepEqual(leadingSleep("sleep 620\ndate -u"), { ms: 620_000, rest: "date -u" });
	assert.deepEqual(leadingSleep("sleep 1.5h"), { ms: 5_400_000, rest: "" });
	assert.deepEqual(leadingSleep("sleep 90 ;"), { ms: 90_000, rest: "" });
});

test("a short sleep, a sleep that is not first, and other forms stay as they are", () => {
	assert.deepEqual(leadingSleep("sleep 240;cmd"), { ms: 240_000, rest: "cmd" });
	const refused = ["sleep 240\r\nls", "sleep 240 &&", "sleep 240;; x", "sleep 30d", "sleep 240 & ls"];
	for (const command of ["sleep 3; ls", "cd x && sleep 240", "sleep 240 || echo", "sleep 240 &", "sleep $N; ls", "sleep infinity", "sleeper 60", "sleep 60 30", ...refused]) {
		assert.equal(leadingSleep(command), undefined, command);
	}
});

type Params = { command: string; timeout?: number };

function fakeBash() {
	const ran: Params[] = [];
	const definition = {
		name: "bash",
		async execute(_id: string, params: Params, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("aborted");
			ran.push(params);
			return { content: [{ type: "text", text: `ran ${params.command}` }], details: undefined };
		},
	};
	return { ran, definition };
}

test("the sleep runs as a rest and the bash tool runs what follows", async () => {
	const { ran, definition } = fakeBash();
	const rests: number[] = [];
	const bash = restingBash(definition as unknown as ToolDefinition, async (ms) => { rests.push(ms); return true; }, () => true);
	const result = await (bash.execute as any)("id", { command: "sleep 240; git status", timeout: 600 }, undefined, undefined, undefined);
	assert.deepEqual(rests, [240_000]);
	assert.deepEqual(ran, [{ command: "git status", timeout: 360 }], "the timeout keeps what the sleep left of it");
	assert.equal(result.content[0].text, "ran git status");
});

test("a sleep with nothing after it still gives the bash tool's own result", async () => {
	const { ran, definition } = fakeBash();
	const bash = restingBash(definition as unknown as ToolDefinition, async () => true, () => true);
	await (bash.execute as any)("id", { command: "sleep 60" }, undefined, undefined, undefined);
	assert.deepEqual(ran, [{ command: ":" }]);
});

test("a sleep the timeout would cut, and a short sleep, run in bash", async () => {
	const { ran, definition } = fakeBash();
	const rests: number[] = [];
	const bash = restingBash(definition as unknown as ToolDefinition, async (ms) => { rests.push(ms); return true; }, () => true);
	await (bash.execute as any)("id", { command: "sleep 240; ls", timeout: 200 }, undefined, undefined, undefined);
	await (bash.execute as any)("id", { command: "sleep 2; ls" }, undefined, undefined, undefined);
	assert.deepEqual(rests, []);
	assert.deepEqual(ran.map((params) => params.command), ["sleep 240; ls", "sleep 2; ls"]);
});

test("an abort during the rest ends the call as an aborted bash call does", async () => {
	const { ran, definition } = fakeBash();
	const controller = new AbortController();
	const bash = restingBash(definition as unknown as ToolDefinition, async () => { controller.abort(); return false; }, () => true);
	await assert.rejects((bash.execute as any)("id", { command: "sleep 60; ls" }, controller.signal, undefined, undefined), /Command aborted/);
	assert.deepEqual(ran, []);
});

test("a sleep beside other tool calls of the turn keeps its slot and runs in bash", async () => {
	const { ran, definition } = fakeBash();
	const rests: number[] = [];
	const bash = restingBash(definition as unknown as ToolDefinition, async (ms) => { rests.push(ms); return true; }, () => false);
	await (bash.execute as any)("id", { command: "sleep 60; ls" }, undefined, undefined, undefined);
	assert.deepEqual(rests, []);
	assert.deepEqual(ran.map((params) => params.command), ["sleep 60; ls"]);
});

test("a rest that a stop or close ended runs nothing more of the command", async () => {
	const { ran, definition } = fakeBash();
	const bash = restingBash(definition as unknown as ToolDefinition, async () => false, () => true);
	await assert.rejects((bash.execute as any)("id", { command: "sleep 60; gh pr merge" }, undefined, undefined, undefined), /Command aborted/);
	assert.deepEqual(ran, []);
});

test("a timeout bash would refuse is left to bash", async () => {
	const { ran, definition } = fakeBash();
	const bash = restingBash(definition as unknown as ToolDefinition, async () => true, () => true);
	for (const timeout of [0, Number.NaN, 3_000_000]) await (bash.execute as any)("id", { command: "sleep 60; ls", timeout }, undefined, undefined, undefined);
	assert.deepEqual(ran.map((params) => params.command), ["sleep 60; ls", "sleep 60; ls", "sleep 60; ls"]);
});
