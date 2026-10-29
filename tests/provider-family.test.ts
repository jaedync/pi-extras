import { test } from "node:test";
import assert from "node:assert/strict";
import { familyMembers, providerFamily, sameFamily } from "../lib/provider-family.ts";

test("anthropic, claude-code and meridian are one family, openai-codex and openai another", () => {
	for (const id of ["anthropic", "claude-code", "meridian"]) assert.equal(providerFamily(id), "anthropic");
	for (const id of ["openai-codex", "openai"]) assert.equal(providerFamily(id), "openai-codex");
	assert.deepEqual(familyMembers("anthropic"), ["anthropic", "claude-code", "meridian"]);
	assert.deepEqual(familyMembers("openai-codex"), ["openai-codex", "openai"]);
});

test("every other provider id is its own family", () => {
	for (const id of ["openrouter", "opencode-go", "opencode", "fw01-halogen"]) {
		assert.equal(providerFamily(id), id);
		assert.deepEqual(familyMembers(id), [id]);
	}
	assert.equal(providerFamily(undefined), undefined);
	assert.equal(providerFamily(""), "");
});

test("sameFamily compares families, and never matches a missing id", () => {
	assert.equal(sameFamily("claude-code", "anthropic"), true);
	assert.equal(sameFamily("openai", "openai-codex"), true);
	assert.equal(sameFamily("openai", "anthropic"), false);
	assert.equal(sameFamily("openrouter", "openrouter"), true);
	assert.equal(sameFamily(undefined, undefined), false);
	assert.equal(sameFamily("anthropic", undefined), false);
});
