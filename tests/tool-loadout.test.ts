import { test } from "node:test";
import assert from "node:assert/strict";
import toolLoadout, { LOADOUT_TOOL, hiddenNames, parseLoadoutConfig } from "../extensions/tool-loadout.ts";

const names = (...list: string[]) => list.map((name) => ({ name }));

test("config keeps only tool-name strings, each once", () => {
	assert.deepEqual(parseLoadoutConfig({}), { codemodeOnly: [] });
	assert.deepEqual(parseLoadoutConfig({ codemodeOnly: "get_goal" }), { codemodeOnly: [] });
	assert.deepEqual(parseLoadoutConfig({ codemodeOnly: ["get_goal", 3, "", " gov_search ", "get_goal", "bad name!"] }), { codemodeOnly: ["get_goal", "gov_search"] });
});

test("hides the listed declared tools and itself while codemode is declared", () => {
	const declared = names("read", "codemode", "get_goal", "gov_search", LOADOUT_TOOL);
	assert.deepEqual(hiddenNames(declared, ["get_goal", "gov_search", "not_registered"]), [LOADOUT_TOOL, "get_goal", "gov_search"]);
});

test("without codemode a hidden tool would be unreachable, so only itself is hidden", () => {
	const declared = names("read", "get_goal", LOADOUT_TOOL);
	assert.deepEqual(hiddenNames(declared, ["get_goal"]), [LOADOUT_TOOL]);
});

test("never hides codemode, the file tools or itself twice", () => {
	const declared = names("read", "bash", "codemode", LOADOUT_TOOL);
	assert.deepEqual(hiddenNames(declared, ["codemode", "read", "bash", LOADOUT_TOOL]), [LOADOUT_TOOL]);
});

test("registers one model-only tool whose loadout hook hides the configured tools", () => {
	const registered: Array<Record<string, unknown>> = [];
	toolLoadout({ registerTool: (tool: Record<string, unknown>) => registered.push(tool), on() {} } as never, { config: { codemodeOnly: ["get_goal"] } });
	assert.equal(registered.length, 1);
	const tool = registered[0] as { name: string; exposure: string; prepareLoadout: (loadout: unknown) => { hiddenDeclarations: string[] } };
	assert.equal(tool.name, LOADOUT_TOOL);
	assert.equal(tool.exposure, "model-only");
	const changes = tool.prepareLoadout({ declared: names("codemode", "get_goal", LOADOUT_TOOL) });
	assert.deepEqual(changes.hiddenDeclarations, [LOADOUT_TOOL, "get_goal"]);
});

test("an empty list registers nothing, so the loadout is Pi's own", () => {
	const registered: unknown[] = [];
	toolLoadout({ registerTool: (tool: unknown) => registered.push(tool) } as never, { config: {} });
	assert.equal(registered.length, 0);
});

function loadoutWithInput(active: string[]) {
	let input: ((event: { text: string; source: string }) => unknown) | undefined;
	const pi = {
		registerTool() {},
		on: (name: string, handler: typeof input) => { if (name === "input") input = handler; },
		getActiveTools: () => active,
	};
	toolLoadout(pi as never, { config: { codemodeOnly: ["propose_goal_draft", "complete_goal", "get_goal"] } });
	return (text: string, source = "extension") => input?.({ text, source });
}

test("an extension message that names a hidden tool gets a note on calling it from codemode", () => {
	const send = loadoutWithInput(["codemode", "propose_goal_draft", "complete_goal", "get_goal"]);
	const result = send("Do not answer in prose. Call the propose_goal_draft tool exactly once. Then complete_goal.") as { action: string; text: string };
	assert.equal(result.action, "transform");
	assert.match(result.text, /^Do not answer in prose\. Call the propose_goal_draft tool exactly once\. Then complete_goal\.\n\n/);
	assert.match(result.text, /propose_goal_draft, complete_goal/);
	assert.match(result.text, /codemode/);
	assert.match(result.text, /await tools\.propose_goal_draft\(/);
	assert.doesNotMatch(result.text, /get_goal/, "only the tools the message names");
	const later = send("Call complete_goal when done, never propose_goal_draft.") as { text: string };
	assert.match(later.text, /complete_goal, propose_goal_draft are not declared[^]*tools\.complete_goal\(/, "the example uses the tool the text names first");
});

test("no note for typed input, for text that names no hidden tool, or when the tools are not reachable", () => {
	const send = loadoutWithInput(["codemode", "propose_goal_draft"]);
	assert.deepEqual(send("Call the propose_goal_draft tool.", "interactive"), { action: "continue" });
	assert.deepEqual(send("Start working toward the active goal now."), { action: "continue" });
	assert.deepEqual(send("my_propose_goal_draft_helper is not a tool"), { action: "continue" });
	assert.deepEqual(loadoutWithInput(["propose_goal_draft"])("Call propose_goal_draft."), { action: "continue" }, "without codemode nothing is hidden");
	assert.deepEqual(loadoutWithInput(["codemode"])("Call propose_goal_draft."), { action: "continue" }, "an inactive tool cannot be called at all");
});
