import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE, VOICES, checkVoice, voiceLanguage } from "../skills/walkthrough-video/scripts/lib/voices.mjs";

test("the default voice is an American male voice", () => {
	assert.equal(DEFAULT_VOICE, "am_michael");
	assert.ok(VOICES.includes(DEFAULT_VOICE));
});

test("the list covers all four Kokoro prefixes", () => {
	for (const prefix of ["af_", "am_", "bf_", "bm_"]) {
		assert.ok(VOICES.some((name) => name.startsWith(prefix)), prefix);
	}
});

test("an unknown voice is refused with the list", () => {
	assert.throws(() => checkVoice("zz_jenny"), (error) => /Unknown voice/.test(error.message) && /am_michael/.test(error.message) && /af_heart/.test(error.message));
});

test("checkVoice accepts a known voice", () => {
	assert.equal(checkVoice("am_michael"), "am_michael");
	assert.equal(checkVoice("bf_emma"), "bf_emma");
});

test("American voices speak en-us and British voices en-gb", () => {
	assert.equal(voiceLanguage("am_adam"), "en-us");
	assert.equal(voiceLanguage("af_heart"), "en-us");
	assert.equal(voiceLanguage("bm_george"), "en-gb");
	assert.equal(voiceLanguage("bf_emma"), "en-gb");
});
