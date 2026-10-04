import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { stopTool, subagentTool } from "../lib/subagents/tools.ts";
import type { AgentRecord, ChildHandle } from "../lib/subagents/types.ts";

/** A team whose children finish when the test says, behind the real `subagent` tool. */
function setup() {
	const finishers = new Map<string, (text: string) => void>();
	const team = new Team({
		maxConcurrent: 4, maxDepth: 1, replyTimeoutMs: 60_000, deliverToMain: () => undefined,
		launcher: {
			async launch(record: AgentRecord): Promise<ChildHandle> {
				let last: string | undefined;
				const messages: unknown[] = [];
				return {
					prompt: () => new Promise<void>((resolve) => finishers.set(record.name, (text) => { last = text; messages.push({ role: "assistant", content: [{ type: "text", text }] }); resolve(); })),
					steer: () => undefined, abort: async () => undefined, lastText: () => last, messages: () => messages,
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

test("stop_subagent stops one of yours and returns how it ended, and refuses agents that aren't yours", async () => {
	const { team, tool, finishers } = setup();
	const stop = stopTool({ team } as never, "main");
	await (tool.execute as any)("id", { task: "survey the repo", name: "surveyor" }, undefined, undefined);
	await tick();
	await tick();
	const stopped = await (stop.execute as any)("id", { name: "surveyor" }, undefined, undefined);
	assert.match(stopped.content[0].text, /^Stopped surveyor\. surveyor \(openai-codex\/gpt-6-luna\) was stopped after/);
	assert.equal(stopped.details.state, "stopped");
	assert.equal(team.get("surveyor")?.state, "stopped");
	const again = await (stop.execute as any)("id", { name: "surveyor" }, undefined, undefined);
	assert.match(again.content[0].text, /surveyor had already stopped; nothing to stop\./);
	await assert.rejects((stop.execute as any)("id", { name: "ghost" }, undefined, undefined), /No agent named ghost/);
	// A child can stop only agents under it.
	const childStop = stopTool({ team } as never, "surveyor");
	await (tool.execute as any)("id", { task: "another job", name: "other" }, undefined, undefined);
	await assert.rejects((childStop.execute as any)("id", { name: "other" }, undefined, undefined), /other is not one of your subagents/);
	finishers.get("other")?.("done");
	await team.close();
});

test("stop_subagent with all stops every live agent you started, and says when there are none", async () => {
	const { team, tool } = setup();
	const stop = stopTool({ team } as never, "main");
	assert.match((await (stop.execute as any)("id", { name: "all" }, undefined, undefined)).content[0].text, /No subagents of yours are running\./);
	await (tool.execute as any)("id", { task: "one", name: "one" }, undefined, undefined);
	await (tool.execute as any)("id", { task: "two", name: "two" }, undefined, undefined);
	await tick();
	await tick();
	const result = await (stop.execute as any)("id", { name: "all" }, undefined, undefined);
	assert.match(result.content[0].text, /^Stopped 2 subagents: one, two\./);
	assert.deepEqual([team.get("one")?.state, team.get("two")?.state], ["stopped", "stopped"]);
	await team.close();
});
