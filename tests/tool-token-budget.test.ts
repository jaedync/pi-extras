/**
 * Every request carries each declared tool's description and schema, so a release that grows them
 * raises the cost of every turn of every session. These budgets hold the largest pi-extras tools to
 * their size; raise one only on purpose. Tokens are estimated as characters / 2.75, which matched
 * Anthropic's count of a whole request within 0.1% (2026-10-26).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerLinkTool } from "../lib/link-context/index.ts";
import { subagentDescription } from "../lib/subagents/describe.ts";
import { subagentParams } from "../lib/subagents/tools.ts";

const CHARS_PER_TOKEN = 2.75;
const tokens = (description: string, parameters: unknown): number =>
	Math.round(JSON.stringify({ name: "tool", description, input_schema: parameters }).length / CHARS_PER_TOKEN);

const MODEL_LINE = "- anthropic/claude-opus-5-5 (Claude Opus 5.5 via Meridian), thinking high\n";
const GUIDE = "- a model note of about one line, as a guide's Summary section has them.\n".repeat(15);

test("subagent stays within its token budget with a summary-sized guide and 11 models", () => {
	const description = subagentDescription({ models: MODEL_LINE.repeat(11), defaultModel: "anthropic/claude-opus-5-5", guide: GUIDE, forChild: false });
	const used = tokens(description, subagentParams);
	assert.ok(used <= 3_100, `subagent uses about ${used} tokens; budget 3100`);
});

test("pull_link stays within its token budget", () => {
	let tool: { description: string; parameters: unknown } | undefined;
	registerLinkTool({ registerTool: (definition: typeof tool) => { tool = definition; }, on() {}, events: { on() {} } } as never, { reader: {} as never });
	assert.ok(tool);
	const used = tokens(tool.description, tool.parameters);
	assert.ok(used <= 950, `pull_link uses about ${used} tokens; budget 950`);
});
