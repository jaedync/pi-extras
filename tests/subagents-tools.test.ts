import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { subagentTool } from "../lib/subagents/tools.ts";
import type { AgentRecord, ChildHandle } from "../lib/subagents/types.ts";

/** A team whose children finish when the test says, behind the real `subagent` tool. */
function setup() {
	const finishers = new Map<string, (text: string) => void>();
	const team = new Team({
		maxConcurrent: 4, maxDepth: 1, replyTimeoutMs: 60_000, deliverToMain: () => undefined,
		launcher: {
			async launch(record: AgentRecord): Promise<ChildHandle> {
				let last: string | undefined;
				return {
					prompt: () => new Promise<void>((resolve) => finishers.set(record.name, (text) => { last = text; resolve(); })),
					steer: () => undefined, abort: async () => undefined, lastText: () => last, messages: () => [],
					takeQueued: () => [], dispose: async () => undefined,
				};
			},
		},
	});
	const luna = { ref: "openai-codex/gpt-6-luna", model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } };
	const tool = subagentTool({ team, allowed: [luna as never], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now }, "main");
	return { team, tool, finishers };
}

test("a waited-on child that asks main a question ends the wait instead of deadlocking", async () => {
	const { team, tool, finishers } = setup();
	const call = (tool.execute as any)("id", { task: "check the lockfile", name: "checker", wait: true }, undefined, undefined);
	await tick();
	await tick();
	void team.send("checker", "main", "npm or pnpm?", { expectReply: true });
	const result = await call;
	assert.match(result.content[0].text, /checker asked you something/);
	assert.equal(result.details.detached, true);
	finishers.get("checker")?.("done");
	await team.close();
});

test("a waited-on child's report is the tool result, with the report in details", async () => {
	const { tool, finishers, team } = setup();
	const call = (tool.execute as any)("id", { task: "count files", name: "counter", wait: true }, undefined, undefined);
	await tick();
	await tick();
	finishers.get("counter")!("**3** files");
	const result = await call;
	assert.equal(result.details.report, "**3** files");
	assert.match(result.content[0].text, /counter \(openai-codex\/gpt-6-luna\) finished after/);
	await team.close();
});
