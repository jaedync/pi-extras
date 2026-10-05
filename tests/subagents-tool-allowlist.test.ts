import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { allowedTools, checkAllowlist } from "../lib/subagents/allowlist.ts";
import { childToolNames } from "../lib/subagents/child.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import { subagentTool, type ToolContext } from "../lib/subagents/tools.ts";
import { teamHarness } from "./support/team-harness.ts";

const ACTIVE = ["read", "bash", "edit", "write", "grep", "web_search", "subagent", "message", "stop_subagent", "computer_use"];
const warn = (message: string) => assert.fail(message);

function setup() {
	const h = teamHarness();
	const luna = { ref: "openai-codex/gpt-6-luna", model: { provider: "openai-codex", id: "gpt-6-luna" } };
	const context: ToolContext = { team: h.team, allowed: [luna], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000,
		now: Date.now, childTools: (readOnly) => childToolNames(ACTIVE, readOnly) };
	const call = (parent: string, args: Record<string, unknown>) => (subagentTool(context, parent).execute as any)("id", args, undefined, undefined);
	return { h, call, description: subagentTool(context, "main").description };
}

test("a child with an allowlist gets only those tools, out of the ones it could have", () => {
	const available = childToolNames(ACTIVE, false);
	assert.deepEqual(allowedTools(available, ["read", "grep"]), ["read", "grep"]);
	assert.deepEqual(allowedTools(available, undefined), available, "no allowlist: everything it could have");
	assert.deepEqual(allowedTools(childToolNames(ACTIVE, true), ["read", "find"]), ["read", "find"], "readOnly adds the read tools it can then name");
});

test("an allowlist may name the team tools, which every child keeps anyway, and repeats count once", () => {
	assert.deepEqual(checkAllowlist(["read", "message", "read", "subagent"], childToolNames(ACTIVE, false), false), { ok: true, tools: ["read"] });
});

test("an allowlist that can't be met says what the child can have", () => {
	const available = childToolNames(ACTIVE, false);
	const empty = checkAllowlist([], available, false);
	assert.ok(!empty.ok && /tools is empty/.test(empty.error) && /It can have: read, bash, edit, write, grep, web_search\./.test(empty.error));
	const unknown = checkAllowlist(["read", "computer_use", "lint"], available, false);
	assert.ok(!unknown.ok && /computer_use, lint are not available to this subagent\. It can have: read, bash/.test(unknown.error));
	const writes = checkAllowlist(["read", "bash", "edit"], childToolNames(ACTIVE, true), true);
	assert.ok(!writes.ok && /readOnly: true takes away bash, edit and write, so tools cannot list bash, edit\./.test(writes.error));
});

test("the subagent tool puts the allowlist on the record, and refuses one it can't meet at spawn", async () => {
	const { h, call, description } = setup();
	assert.match(description, /Pass tools to give it only the named tools; its message tool always stays\./);
	await call("main", { task: "look around", name: "looker", tools: ["read", "grep"] });
	assert.deepEqual(h.team.get("looker")?.tools, ["read", "grep"]);
	await call("main", { task: "do anything", name: "anything" });
	assert.equal(h.team.get("anything")?.tools, undefined, "no allowlist: every tool it could have");
	await assert.rejects(call("main", { task: "x", tools: [] }), /tools is empty/);
	await assert.rejects(call("main", { task: "x", tools: ["bash"], readOnly: true }), /readOnly: true takes away/);
	await assert.rejects(call("main", { task: "x", tools: ["lint"] }), /lint is not available to this subagent\. It can have: read, bash/);
	await h.team.close();
});

test("a child with an allowlist can't give its own subagents more than it has", async () => {
	const { h, call } = setup();
	await call("main", { task: "lead the work", name: "lead", tools: ["read", "bash"] });
	await tick();
	await call("lead", { task: "help out", name: "helper" });
	assert.deepEqual(h.team.get("helper")?.tools, ["read", "bash"], "inherits its parent's allowlist");
	await assert.rejects(call("lead", { task: "edit", tools: ["edit"] }), /edit is not available to this subagent\. It can have: read, bash\./);
	await h.team.close();
});

test("the allowlist survives the index, so a resume or a restore keeps the same tools", () => {
	const dir = mkdtempSync(join(tmpdir(), "allowlist-index-"));
	try {
		const record = { name: "looker", parent: "main", depth: 1, model: "faux/cheap", task: "t", readOnly: false, fork: false, blocking: false,
			state: "idle" as const, createdAt: 1, activity: null, runs: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
		new ChildIndex(dir, "p", dir).save([{ ...record, tools: ["read", "grep"] }]);
		assert.deepEqual(new ChildIndex(dir, "p", dir).load(warn)[0]?.tools, ["read", "grep"]);
		new ChildIndex(dir, "p", dir).save([{ ...record, tools: "read" as never }]);
		assert.throws(() => new ChildIndex(dir, "p", dir).load(warn), /invalid/i);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
