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
	toolLoadout({ registerTool: (tool: Record<string, unknown>) => registered.push(tool) } as never, { config: { codemodeOnly: ["get_goal"] } });
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
