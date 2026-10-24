import assert from "node:assert/strict";
import test from "node:test";
import extension, { DESCRIPTION, registerGovSearch, TOOL_NAME } from "../lib/gov-search/index.ts";
import { GovSearchClient } from "../lib/gov-search/client.ts";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { govSearchSpec } from "../lib/tool-display/web.ts";
import { rowKind } from "../lib/tool-row.ts";
import { band, harness, row, text } from "./support/tool-rows.ts";

const plainTheme = { fg: (_key: string, value: string) => value, bold: (value: string) => value } as never;

function registered(client?: GovSearchClient) {
	const tools: Array<Record<string, any>> = [];
	const pi = { registerTool: (tool: Record<string, any>) => tools.push(tool) } as never;
	if (client) registerGovSearch(pi, client);
	else extension(pi);
	return tools[0]!;
}

test("the extension registers gov_search with the gov row and a closed schema", () => {
	const tool = registered();
	assert.equal(tool.name, TOOL_NAME);
	assert.equal(rowKind(tool), "gov");
	assert.equal(tool.executionMode, undefined, "calls in one batch run side by side");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["query", "k", "jurisdiction", "court", "courtType", "cites", "domain"]);
	assert.deepEqual(tool.parameters.required, ["query"]);
	for (const phrase of ["Zero results does not prove that no law exists", "check the issuer, jurisdiction, date and in-force status", "read the source page", "untrusted", "no key needed"]) {
		assert.ok(DESCRIPTION.includes(phrase), phrase);
	}
});

test("execute returns the text for the model and the records as details", async () => {
	const fake = { search: async () => ({ text: "1. T\nhttps://e.test/\n", results: [{ rank: 1, title: "T", url: "https://e.test/", snippet: "s", excerptClipped: false }], resultCount: 1, requestedCount: 10, retrievedCount: 2, duplicateCount: 1, rejectedCount: 0, omittedCount: 0, excerptClippedCount: 0, status: "complete", proxied: false, keyed: false }) };
	const tool = registered(fake as never);
	const result = await tool.execute("id", { query: "q" }, undefined);
	assert.deepEqual(result.content, [{ type: "text", text: "1. T\nhttps://e.test/\n" }]);
	assert.equal(result.details.duplicateCount, 1);
	assert.equal(result.details.text, undefined, "the text is not repeated in details");
	assert.equal(typeof result.details.durationMs, "number");
});

test("errors from the client reach Pi as thrown errors", async () => {
	const tool = registered(new GovSearchClient({ env: () => ({}), proxy: () => undefined, defaultKeyFile: "/nonexistent/gov-search-key" }));
	await assert.rejects(tool.execute("id", { query: "q", limit: 3 }, undefined), /unknown field "limit"/);
});

test("the call line shows the query, filters and k", () => {
	const tool = registered();
	const line = tool.renderCall({ query: "qualified immunity", jurisdiction: "us-ca", courtType: "state-supreme", cites: "42 U.S.C. § 1983", domain: "courts.ca.gov", k: 5 }, plainTheme, {}).render(200)[0].trimEnd();
	assert.equal(line, 'gov_search "qualified immunity" us-ca state-supreme cites:42 U.S.C. § 1983 site:courts.ca.gov k 5');
});

test("Tool Display draws the gov row with its filters in the band", () => {
	const h = harness();
	const search = row(toolRenderers(h.kit, govSearchSpec("gov_search")) as never, { query: "small claims", jurisdiction: "us-tx", k: 5 });
	search.update({ executionStarted: true });
	h.advance(1_200);
	const results = [1, 2].map((rank) => ({ rank, title: `Result ${rank}`, url: `https://www.site${rank}.test/page`, snippet: "s", excerptClipped: false }));
	search.update({ executionStarted: true, isPartial: false, result: text("two", { resultCount: 2, requestedCount: 5, durationMs: 1_200, status: "complete", results, duplicateCount: 1 }) });
	assert.deepEqual(search.lines(), [band("gov_search small claims us-tx, 2 results", "1.2s"), "    1. Result 1  site1.test", "    2. Result 2  site2.test"]);
});
