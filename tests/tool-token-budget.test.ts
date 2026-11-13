/**
 * Every request carries each declared tool's description and schema, so a release that grows them
 * raises the cost of every turn of every session. These budgets hold the largest pi-extras tools to
 * their size; raise one only on purpose. Tokens are estimated as characters / 2.75, which matched
 * Anthropic's count of a whole request within 0.1% (2026-10-26).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerLinkTool } from "../lib/link-context/index.ts";
import { DESCRIPTION_MAX_CHARS, PI_SUFFIX_RESERVE, subagentDescription } from "../lib/subagents/describe.ts";
import { subagentParams } from "../lib/subagents/tools.ts";

const CHARS_PER_TOKEN = 2.75;
const tokens = (description: string, parameters: unknown): number =>
	Math.round(JSON.stringify({ name: "tool", description, input_schema: parameters }).length / CHARS_PER_TOKEN);

const MODEL_LINE = "- anthropic/claude-opus-5-5, thinking high\n";
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

/** Claude Code cuts an MCP tool description at 4,096 characters (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH), so the guide's last lines were lost. */
test("the subagent description never passes Claude Code's 4,096-character cut, and a long guide keeps its first lines", () => {
	assert.equal(DESCRIPTION_MAX_CHARS, 4_096);
	const models = MODEL_LINE.repeat(12);
	for (const length of [0, 500, 1_500, 2_500, 4_000, 9_000]) {
		const guide = ["- Never use model-x.", ...Array.from({ length: Math.ceil(length / 60) }, (_, i) => `- note ${i} about which model suits which work, one line.`)].join("\n");
		const description = subagentDescription({ models, defaultModel: "anthropic/claude-opus-5-5", guide, forChild: false });
		const sent = `${description}\n\nCodemode: \`tools.subagent(args)\` resolves to a string.`;
		assert.ok(sent.length <= DESCRIPTION_MAX_CHARS, `${sent.length} characters with a ${length}-character guide and Pi's codemode line`);
		assert.ok(description.length <= DESCRIPTION_MAX_CHARS - PI_SUFFIX_RESERVE);
		assert.match(description, /- Never use model-x\./, "the guide's first line, where the bans go, survives");
	}
});

test("the subagent description's fixed text stays within 2,100 characters", () => {
	const guide = "- a model note of about one line, as a guide's Summary section has them.\n".repeat(14).trim();
	const description = subagentDescription({ models: MODEL_LINE.repeat(12).trim(), defaultModel: "anthropic/claude-opus-5-5", guide, forChild: false });
	const fixed = description.length - guide.length - MODEL_LINE.repeat(12).trim().length;
	assert.ok(fixed <= 2_100, `the fixed text uses ${fixed} characters; budget 2100`);
});
