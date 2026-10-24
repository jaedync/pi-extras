import assert from "node:assert/strict";
import test from "node:test";
import { cleanDetail, GovSearchError, redact } from "../lib/gov-search/errors.ts";
import { formatOutput, MAX_OUTPUT_BYTES, NOTICE, type Counts } from "../lib/gov-search/output.ts";
import { badRequestReason, dedupe, parseResponse, type GovResult } from "../lib/gov-search/response.ts";

const item = (n: number, extra: Record<string, unknown> = {}) => ({ url: `https://law.example.gov/sec/${n}`, title: `Section ${n}`, description: `Synthetic text of section ${n}.`, position: n, ...extra });
const body = (web: unknown[]) => JSON.stringify({ success: true, data: { web } });
const counts = (over: Partial<Counts> = {}): Counts => ({ requestedCount: 10, retrievedCount: 3, duplicateCount: 0, rejectedCount: 0, filtered: false, ...over });

test("a 200 body becomes ranked, cleaned records", () => {
	const parsed = parseResponse(body([item(1), item(2, { title: " Two\u0007\n lines ", description: undefined }), item(3, { title: "" })]));
	assert.equal(parsed.retrievedCount, 3);
	assert.deepEqual(parsed.results.map((r) => [r.rank, r.title, r.snippet]), [[1, "Section 1", "Synthetic text of section 1."], [2, "Two lines", ""], [3, "law.example.gov", "Synthetic text of section 3."]]);
});

test("records without a plain web URL are removed and counted", () => {
	const parsed = parseResponse(body([item(1, { url: "javascript:alert(1)" }), item(2, { url: "https://user:pw@law.example.gov/" }), "text", item(4, { url: `https://a.gov/${"x".repeat(3000)}` }), item(5)]));
	assert.equal(parsed.results.length, 1);
	assert.equal(parsed.rejectedCount, 4);
	assert.equal(parsed.results[0]!.rank, 1);
});

test("a body that is not the documented shape is an error", () => {
	for (const bad of ["<html>", "[]", JSON.stringify({ success: false }), JSON.stringify({ success: true, data: { web: {} } })]) {
		assert.throws(() => parseResponse(bad), (error: unknown) => error instanceof GovSearchError && error.code === "response");
	}
	assert.deepEqual(parseResponse(JSON.stringify({ success: true, data: {} })).results, [], "no web group reads as no results");
});

test("dedupe drops the same URL and the same page on a mirror host, and renumbers", () => {
	const make = (url: string, title: string, snippet: string): GovResult => ({ rank: 0, url, title, snippet, excerptClipped: false });
	const { results, duplicateCount } = dedupe([
		make("https://www.ftc.gov/rule/a", "Rule A", "Text of rule A."),
		make("https://search.ftc.gov/rule?id=a", "Rule  A", "text of rule a."),
		make("https://ftc.gov/rule/a/", "Other title", "Other text."),
		make("https://other.example.gov/defs", "Definitions", ""),
		make("https://other.example.gov/defs2", "Definitions", ""),
		make("https://copy.example.com/rule/a", "Rule A", "Text of rule A."),
	]);
	assert.equal(duplicateCount, 2);
	assert.deepEqual(results.map((r) => [r.rank, r.url]), [
		[1, "https://www.ftc.gov/rule/a"],
		[2, "https://other.example.gov/defs"],
		[3, "https://other.example.gov/defs2"],
		[4, "https://copy.example.com/rule/a"],
	], "a title with no description, or a copy on another site, is not merged");
});

test("the text lists records, counts, and ends with the untrusted notice", () => {
	const { results } = parseResponse(body([item(1), item(2)]));
	const output = formatOutput(results, counts({ retrievedCount: 3, duplicateCount: 1, filtered: true }));
	assert.equal(output.text, [
		"1. Section 1", "https://law.example.gov/sec/1", "Synthetic text of section 1.", "",
		"2. Section 2", "https://law.example.gov/sec/2", "Synthetic text of section 2.", "",
		"Firecrawl Government Index: 2 results for k=10 (3 from the API; 1 duplicate removed).",
		"Filters leave out pages without labels, so this list can miss relevant law.",
		NOTICE,
	].join("\n"));
	assert.equal(output.status, "complete");
	assert.match(NOTICE, /untrusted/);
	assert.match(NOTICE, /issuer, jurisdiction, date and in-force status/);
});

test("zero results says it does not prove that no law exists", () => {
	const output = formatOutput([], counts({ retrievedCount: 0 }));
	assert.match(output.text, /0 results for k=10 \(0 from the API; no duplicates removed\)/);
	assert.match(output.text, /does not prove that no law exists/);
});

test("descriptions are cut to 300 characters", () => {
	const { results } = parseResponse(body([item(1, { description: "d".repeat(900) })]));
	const output = formatOutput(results, counts());
	assert.equal(output.results[0]!.snippet, `${"d".repeat(300)}…`);
	assert.equal(output.excerptClippedCount, 1);
});

test("a large answer stays under the byte limit and says what it left out", () => {
	const web = Array.from({ length: 100 }, (_, i) => item(i + 1, { title: `T${i} ${"t".repeat(190)}`, description: "é".repeat(1500), url: `https://law.example.gov/${i}/${"p".repeat(200)}` }));
	const { results } = parseResponse(body(web));
	const output = formatOutput(results, counts({ requestedCount: 100, retrievedCount: 100 }));
	assert.ok(Buffer.byteLength(output.text) <= MAX_OUTPUT_BYTES, `${Buffer.byteLength(output.text)} bytes`);
	assert.ok(output.resultCount > 10 && output.resultCount < 100);
	assert.equal(output.omittedCount, 100 - output.resultCount);
	assert.equal(output.status, "partial");
	assert.ok(output.results.every((r) => Array.from(r.snippet).length <= 161), "shorter descriptions come before dropped records");
	assert.match(output.text, new RegExp(`${output.omittedCount} results left out by the output size limit`));
	assert.ok(output.text.endsWith(NOTICE));
});

test("a 400 reason joins error and details, bounded", () => {
	assert.equal(badRequestReason(JSON.stringify({ success: false, error: "Invalid query parameters", details: [{ path: ["courtType"], message: "Invalid enum value" }, "x"] })), "Invalid query parameters; courtType: Invalid enum value; x");
	assert.equal(badRequestReason("not json"), "");
	assert.ok(badRequestReason(JSON.stringify({ error: "e".repeat(5000) })).length <= 300);
	const key = ["fc", "synthetic", "cut", "0003"].join("-");
	assert.ok(!badRequestReason(JSON.stringify({ error: `${"e".repeat(295)}${key}` }), key).includes(key.slice(0, 4)), "redacted before the cut");
});

test("redact removes raw and percent-encoded keys; cleanDetail drops control text", () => {
	assert.equal(redact("a fc-k/ey+1 b fc-k%2Fey%2B1", "fc-k/ey+1"), "a [redacted] b [redacted]");
	assert.equal(redact("text", undefined), "text");
	assert.equal(cleanDetail("a\u202eb\n\tc"), "a b c");
});
