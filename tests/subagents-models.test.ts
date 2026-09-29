import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedModels, resolveModel, thinkingFor, modelTable } from "../lib/subagents/models.ts";

const model = (provider: string, id: string, name = id) => ({ provider, id, name }) as any;
const opus = model("anthropic", "claude-opus-5-5", "Claude Opus 5.5");
const fable = model("anthropic", "claude-fable-5-1", "Claude Fable 5.1");
const luna = model("openai-codex", "gpt-6-luna", "GPT-6 Luna");
const sol = model("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol");
const scoped = [{ model: opus }, { model: fable }, { model: luna, thinkingLevel: "low" as const }, { model: sol }];

test("allowed models are the scoped models, deduplicated by reference", () => {
	const allowed = allowedModels([...scoped, { model: opus }], opus);
	assert.deepEqual(allowed.map((choice) => choice.ref), [
		"anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-sol",
	]);
	assert.equal(allowed[2]!.patternThinking, "low");
});

test("without scoping, only the parent's model is listed", () => {
	assert.deepEqual(allowedModels([], opus).map((choice) => choice.ref), ["anthropic/claude-opus-5-5"]);
	assert.deepEqual(allowedModels([], undefined), []);
});

test("resolves exact references, bare ids and unique short names", () => {
	const allowed = allowedModels(scoped, opus);
	const ref = (query: string) => { const r = resolveModel(query, allowed); return r.ok ? r.choice.ref : r.error; };
	assert.equal(ref("openai-codex/gpt-6-luna"), "openai-codex/gpt-6-luna");
	assert.equal(ref("GPT-6-LUNA"), "openai-codex/gpt-6-luna");
	assert.equal(ref("luna"), "openai-codex/gpt-6-luna");
	assert.equal(ref("sol"), "openai-codex/gpt-6.1-sol");
	assert.equal(ref("gpt 6.1"), "openai-codex/gpt-6.1-sol");
	assert.equal(ref("Opus 5.5"), "anthropic/claude-opus-5-5");
	assert.equal(ref("fable"), "anthropic/claude-fable-5-1");
});

test("ambiguous and unknown names fail with the allowed list", () => {
	const allowed = allowedModels(scoped, opus);
	const ambiguous = resolveModel("claude", allowed);
	assert.equal(ambiguous.ok, false);
	assert.match(!ambiguous.ok ? ambiguous.error : "", /matches 2 models.*claude-opus-5-5.*claude-fable-5-1/s);
	const unknown = resolveModel("gemini", allowed);
	assert.equal(unknown.ok, false);
	assert.match(!unknown.ok ? unknown.error : "", /not one of the allowed models.*gpt-6-luna/s);
});

test("an empty allowed list refuses every model", () => {
	const result = resolveModel("luna", []);
	assert.equal(result.ok, false);
});

test("thinking: per call, then scoped pattern, then per-model setting, then default", () => {
	const [opusChoice, , lunaChoice, solChoice] = allowedModels(scoped, opus);
	const settings = { modelThinkingLevels: { "openai-codex/gpt-6.1-sol": "high" as const }, defaultThinkingLevel: "medium" as const };
	assert.equal(thinkingFor(lunaChoice!, "xhigh", settings), "xhigh");
	assert.equal(thinkingFor(lunaChoice!, undefined, settings), "low");
	assert.equal(thinkingFor(solChoice!, undefined, settings), "high");
	assert.equal(thinkingFor(opusChoice!, undefined, settings), "medium");
	assert.equal(thinkingFor(opusChoice!, undefined, {}), undefined);
});

test("model table lists each model with its effective thinking level", () => {
	const allowed = allowedModels(scoped, opus);
	const table = modelTable(allowed, { modelThinkingLevels: { "openai-codex/gpt-6.1-sol": "high" }, defaultThinkingLevel: "medium" });
	assert.equal(table, [
		"- anthropic/claude-opus-5-5 (Claude Opus 5.5), thinking medium",
		"- anthropic/claude-fable-5-1 (Claude Fable 5.1), thinking medium",
		"- openai-codex/gpt-6-luna (GPT-6 Luna), thinking low",
		"- openai-codex/gpt-6.1-sol (GPT-6.1 Sol), thinking high",
	].join("\n"));
});
