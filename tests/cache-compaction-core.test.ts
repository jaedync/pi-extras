import assert from "node:assert/strict";
import { summaryOutputFloor } from "../lib/cache-compaction/estimate.ts";
import { test } from "node:test";
import { conversationKey, capturePayload, payloadHashes, mergePayload, loadConfig, idleLimitMs, fallbackReason, fileLists, formatFiles, fingerprint, reconcile, buildInstruction, boundaryIdentifier, MAX_BOUNDARY_IDENTIFIER_CHARS, requestOutputLimit, requestEffort, safeHeaders } from "../lib/cache-compaction/core.ts";

for (const [api, key] of [["anthropic-messages", "messages"], ["openai-completions", "messages"], ["openai-responses", "input"], ["openai-codex-responses", "input"], ["google-generative-ai", "contents"], ["google-vertex", "contents"]]) {
	test(`payload replay changes only ${key} for ${api}`, () => {
		const original = { [key]: ["old"], reasoning: { effort: "low", summary: "auto" }, tools: [{ name: "read" }], max_tokens: 123, metadata: { user_id: "session" }, prompt_cache_key: "session" };
		const captured = capturePayload(api, original)!;
		assert.equal(conversationKey(api), key);
		assert.equal(key in captured, false, "do not retain a duplicate transcript");
		const result = mergePayload(api, captured, { [key]: ["new"], reasoning: { effort: "high" }, max_tokens: 123 });
		assert.deepEqual(result, { ...original, [key]: ["new"] });
		assert.deepEqual(original[key], ["old"]);
		assert.notEqual(result.reasoning, original.reasoning);
	});
}
test("unsupported and malformed payloads refuse replay", () => {
	assert.equal(conversationKey("unknown"), undefined);
	assert.equal(capturePayload("anthropic-messages", { input: [] }), undefined);
	assert.throws(() => mergePayload("anthropic-messages", {}, {}));
});
test("provider prefix guard catches later context transforms without retaining request bodies", () => {
	const original = { messages: [{ role: "user", content: [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }] }] };
	const hashes = payloadHashes("anthropic-messages", original)!;
	assert.doesNotThrow(() => mergePayload("anthropic-messages", {}, { messages: [{ role: "user", content: [{ type: "text", text: "old" }] }, { role: "assistant", content: "new" }] }, hashes));
	assert.throws(() => mergePayload("anthropic-messages", {}, { messages: [{ role: "user", content: "changed" }] }, hashes));
	assert.equal(payloadHashes("unknown", original), undefined);
});
test("split-turn boundary identifies tool-only messages and explicitly excludes the suffix in every section", () => {
	const kept = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "sensor.js" } }] };
	const messages = [msg("system", "sys"), msg("user", "original request"), kept, msg("toolResult", "test failed"), msg("user", "null decision"), msg("assistant", "fixed; tests pass")];
	const text = buildInstruction({ messages, boundary: 2, entryId: "read-entry", historyStart: 1, splitStart: 1 });
	assert.match(text, /"id": "read-1"/);
	assert.match(text, /"name": "read"/);
	assert.match(text, /"type": "toolCall"/);
	assert.doesNotMatch(text, /message \d|\d+(?:st|nd|rd|th) message|from the end|messages \d/);
	assert.match(text, /AFTER your summary/);
	assert.match(text, /must NOT appear in your summary/);
	assert.match(text, /Early Progress.*Context for Suffix.*only.*before/s);
	assert.match(text, /decisions, changes, test results or next steps.*only.*retained suffix/s);
});
test("kept boundary identifiers are capped for huge text, arguments and tool results", () => {
	for (const kept of [msg("user", "x".repeat(100000)), { role: "assistant", content: [{ type: "toolCall", id: "unique-id", name: "read", arguments: { path: "x".repeat(100000) } }] }, { role: "toolResult", toolCallId: "unique-result", content: [{ type: "text", text: "x".repeat(100000) }] }]) {
		const identifier = boundaryIdentifier(kept);
		assert.ok(identifier.length <= MAX_BOUNDARY_IDENTIFIER_CHARS);
		assert.match(identifier, /"role":/);
		if (kept.role === "assistant") assert.match(identifier, /unique-id/);
		if (kept.role === "toolResult") assert.match(identifier, /unique-result/);
	}
});
test("validated idle configuration defaults are conservative except known Meridian", () => {
	const c = loadConfig({ enabled: false, idleSeconds: { anthropic: 12, bad: -1, nan: "10" } });
	assert.equal(c.enabled, false);
	assert.equal(idleLimitMs(c, { provider: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:3456" }), 12000);
	assert.equal(idleLimitMs(loadConfig({}), { provider: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:3456" }), 55 * 60000);
	assert.equal(idleLimitMs(loadConfig({}), { provider: "anthropic", api: "anthropic-messages" }), 4 * 60000);
	assert.equal(idleLimitMs(loadConfig({}), { provider: "openai-codex", api: "openai-codex-responses" }), 4 * 60000);
});
const model = { provider: "anthropic", id: "fixture", api: "anthropic-messages", contextWindow: 10000 };
const gate = { enabled: true, captured: { ...model, sessionId: "s", at: 100 }, model, sessionId: "s", now: 200, idleMs: 1000, reason: "manual", aborted: false };
test("fallback decisions cover disabled, missing, changed, cold, overflow, unsupported and abort", () => {
	assert.equal(fallbackReason(gate), undefined);
	for (const [patch, expected] of [
		[{ enabled: false }, "disabled"], [{ captured: undefined }, "no-request"], [{ model: { ...model, id: "other" } }, "model-changed"],
		[{ sessionId: "other" }, "session-changed"], [{ now: 1200 }, "cold-cache"], [{ now: 0 }, "cold-cache"], [{ reason: "overflow" }, "overflow"],
		[{ model: { ...model, api: "unknown" }, captured: { ...gate.captured, api: "unknown" } }, "unsupported-api"], [{ aborted: true }, "aborted"],
	] as const) assert.equal(fallbackReason({ ...gate, ...patch }), expected);
});
test("file operations carry prior hook details and exactly mirror Pi XML lists", () => {
	const ops = { read: new Set(["z", "edited", "a"]), written: new Set(["written"]), edited: new Set(["edited"]) };
	const details = fileLists(ops, { readFiles: ["prior", "written"], modifiedFiles: ["prior-edit"] });
	assert.deepEqual(details, { readFiles: ["a", "prior", "z"], modifiedFiles: ["edited", "prior-edit", "written"] });
	assert.equal(formatFiles(details), "\n\n<read-files>\na\nprior\nz\n</read-files>\n\n<modified-files>\nedited\nprior-edit\nwritten\n</modified-files>");
	assert.equal(formatFiles({ readFiles: [], modifiedFiles: [] }), "");
	assert.equal(ops.read.size, 3);
});
const msg = (role: string, content: string) => ({ role, content, timestamp: 1 });
test("reconciliation requires entry identity and immutable message fingerprints, not similar text", () => {
	const messages = [msg("system", "sys"), msg("user", "same"), msg("assistant", "last")];
	const snapshot = { ids: ["a", "b"], hashes: messages.slice(0, 2).map(fingerprint) };
	assert.equal(reconcile(snapshot, ["a", "b", "c"], messages), 2);
	assert.equal(reconcile(snapshot, ["a", "different", "c"], messages), undefined);
	assert.equal(reconcile(snapshot, ["a", "b", "c"], [messages[0], { ...messages[1], content: "edit" }, messages[2]]), undefined);
});
test("instructions identify kept and history boundaries without provider-dependent numbering", () => {
	const messages = [msg("system", "sys"), msg("user", "old"), msg("assistant", "kept start")];
	const instruction = buildInstruction({ messages, boundary: 2, entryId: "kept-id", historyStart: 1, splitStart: undefined, previousSummary: undefined, customInstructions: "Preserve tests" });
	assert.match(instruction, /role assistant.*kept-id/);
	assert.doesNotMatch(instruction, /message \d|from the end|messages \d/);
	assert.match(instruction, /"kept start"/);
	assert.match(instruction, /<history-start-message>/);
	assert.match(instruction, /Preserve tests/);
	for (const header of ["## Goal", "## Constraints & Preferences", "### Done", "### In Progress", "### Blocked", "## Key Decisions", "## Next Steps", "## Critical Context"]) assert.ok(instruction.includes(header));
	assert.match(instruction, /Do not call tools/);
});
test("update and split-turn instructions separate history from prefix and exclude retained suffix", () => {
	const messages = [msg("system", "prior facts"), msg("user", "history"), msg("user", "original request"), msg("assistant", "prefix"), msg("assistant", "suffix")];
	const text = buildInstruction({ messages, boundary: 4, entryId: "suffix-id", historyStart: 1, splitStart: 2, previousSummary: "prior facts", customInstructions: undefined });
	assert.doesNotMatch(text, /prior facts|<previous-summary>/);
	assert.match(text, /summary already at the start/);
	assert.match(text, /PRESERVE/);
	assert.match(text, /<split-turn-request>/);
	assert.doesNotMatch(text, /messages \d|from the end/);
	assert.match(text, /Turn Context \(split turn\)/);
	assert.match(text, /## Original Request/);
	assert.match(text, /## Early Progress/);
	assert.match(text, /## Context for Suffix/);
	assert.match(text, /Do not summarize.*retained/s);
});

for (const api of ["google-generative-ai", "google-vertex"]) test(`${api} replaces live abort signals rather than cloning them`, () => {
 const previous = new AbortController(); const current = new AbortController();
 const captured = capturePayload(api, { contents: [], config: { abortSignal: previous.signal, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 123 } } })!;
 assert.equal("abortSignal" in (captured.config as Record<string, unknown>), false);
 previous.abort();
 const merged = mergePayload(api, captured, { contents: ["new"], config: { abortSignal: current.signal, maxOutputTokens: 10000 } });
 assert.equal((merged.config as any).abortSignal, current.signal);
 assert.equal((merged.config as any).abortSignal.aborted, false);
 assert.equal((merged.config as any).maxOutputTokens, 10000);
 assert.deepEqual((merged.config as any).thinkingConfig, { thinkingBudget: 123 });
});
test("output limit shapes and evidence-based summary floor", () => {
 assert.equal(requestOutputLimit({ max_tokens: 1 }), 1);
 assert.equal(requestOutputLimit({ max_output_tokens: 800 }), 800);
 assert.equal(requestOutputLimit({ config: { maxOutputTokens: 300 } }), 300);
 assert.equal(summaryOutputFloor(), 8000);
 assert.equal(summaryOutputFloor("x".repeat(40000)), 18000);
 assert.equal(requestOutputLimit({ max_tokens: "1" }), undefined);
});
for (const [api, key, cap] of [["anthropic-messages", "messages", "max_tokens"], ["openai-responses", "input", "max_output_tokens"]]) test(`${api} replays the generated context-clamped output cap, preserving thinking`, () => {
 const result = mergePayload(api, { [cap]: 16000, thinking: { budget_tokens: 2048 } }, { [key]: [], [cap]: 14000 });
 assert.equal(result[cap], 14000);
 assert.deepEqual(result.thinking, { budget_tokens: 2048 });
 assert.throws(() => mergePayload(api, { [cap]: 16000, thinking: { budget_tokens: 7000 } }, { [key]: [], [cap]: 14000 }), /thinking-budget/);
});
test("Google replays only the generated output cap within captured config", () => {
 assert.deepEqual(mergePayload("google-generative-ai", { config: { maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 1000 } } }, { contents: [], config: { maxOutputTokens: 10000 } }).config, { maxOutputTokens: 10000, thinkingConfig: { thinkingBudget: 1000 } });
});
for (const api of ["google-generative-ai", "google-vertex"]) test(`${api} preserves thinking budget only when generated cap leaves summary room`, () => {
 const captured = { config: { maxOutputTokens: 32000, thinkingConfig: { thinkingBudget: 7000 } } };
 assert.throws(() => mergePayload(api, captured, { contents: [], config: { maxOutputTokens: 14000 } }), /thinking-budget/);
 const result = mergePayload(api, captured, { contents: [], config: { maxOutputTokens: 18000 } });
 assert.deepEqual(result.config, { maxOutputTokens: 18000, thinkingConfig: { thinkingBudget: 7000 } });
});
for (const opening of ["continue", '<skill name="review">' + "x".repeat(300)]) test(`repeated ${opening.slice(0, 20)} boundary adds a unique preceding chain`, () => {
 const messages = [msg("user", "unique old task"), msg("user", opening), msg("assistant", "unique new task"), msg("user", opening)];
 const instruction = buildInstruction({ messages, boundary: 3, entryId: "kept", historyStart: 0 });
 assert.match(instruction, /preceding-message-chain/);
 assert.match(instruction, /unique new task/);
});
test("unresolvable boundary chain falls back within the identifier cap", () => {
 const messages = Array.from({ length: 30 }, () => msg("user", "continue"));
 assert.throws(() => buildInstruction({ messages, boundary: 29, entryId: "kept", historyStart: 0 }), /ambiguous-boundary/);
});
test("managed effort marker can extend an otherwise exact cached prefix", () => {
 const marker = { role: "system", content: [], output_config: { effort: "xhigh" } };
 const first = { role: "user", content: "cached" };
 const prefix = payloadHashes("anthropic-messages", { messages: [first, marker] })!;
 const result = mergePayload("anthropic-messages", {}, { messages: [first, { role: "user", content: "instruction" }, marker] }, prefix);
 assert.deepEqual((result.messages as unknown[]).slice(0, 2), [first, marker]);
});
test("headers retain routing but never credential-like names; effort comes from the actual payload", () => {
 assert.deepEqual(safeHeaders({ "x-opencode-session": "same-session", "content-type": "application/json", Authorization: "secret", "x-api-key": "secret", cookie: "secret", "x-access-token": "secret", "X-Custom-Key": "secret", "x-signature": "secret", "x-amz-security-token": "synthetic", "CF-Access-Client-Secret": "synthetic", "x-goog-api-key": "synthetic", "x-aws-signature": "synthetic", "Proxy-Authorization": "synthetic", "Set-Cookie": "synthetic" }), { "x-opencode-session": "same-session", "content-type": "application/json" });
 assert.equal(requestEffort({ output_config: { effort: "max" } }), "max");
 assert.equal(requestEffort({ output_config: { effort: "high" }, messages: [{ role: "system", output_config: { effort: "low" } }] }), "low");
 assert.equal(requestEffort({ reasoning: { effort: "low" } }), undefined);
 assert.equal(requestEffort({ messages: [{ role: "system", content: [], output_config: { effort: "xhigh" } }] }), "xhigh");
});
