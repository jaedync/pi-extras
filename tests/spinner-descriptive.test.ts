import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "../lib/phase-status.ts";
import { DEFAULT_VERBS, parseVerbs, renderRunStatus, renderEndLine, parseEndLine, type RunLine } from "../lib/cc-phase.ts";
const theme = { fg: (_key: string, text: string) => text };
const base = { elapsedMs: 12000, phaseMs: 12000, tokens: 212, clockMs: 0, reduced: true };
test("descriptive is default; playful and custom lists explicitly opt in", () => {
	assert.deepEqual(parseVerbs(undefined), []);
	assert.deepEqual(parseVerbs("bad"), []);
	assert.equal(parseVerbs("playful"), DEFAULT_VERBS);
	assert.deepEqual(parseVerbs(["Mixing|Mixed"]), [{ present: "Mixing", past: "Mixed" }]);
});
test("divider captions cover every descriptive and playful phase, with and without tokens", () => {
	for (const [phase, extra, descriptive, playful, tokenDetail] of [
		["prep", {}, "Preparing", "", ""],
		["api", {}, "Sending request", "sending request", "↑"],
		["first_token", {}, "Waiting for the model", "waiting for first token", ""],
		["think", { phaseMs: 0 }, "Thinking", "thinking", "↓ 212 tokens"],
		["think", {}, "Still thinking", "still thinking", "↓ 212 tokens"],
		["think", { phaseMs: 21000 }, "Thinking more", "thinking more", "↓ 212 tokens"],
		["think", { phaseMs: 31000 }, "Thinking more", "thinking some more", "↓ 212 tokens"],
		["think", { phaseMs: 46000 }, "Deep in thought", "deep in thought", "↓ 212 tokens"],
		["tool", { pendingTool: "bash", tokens: 486 }, "Writing bash call", "writing bash call", "↓ 486 tokens"],
		["run", { tools: ["bash"] }, "Running bash", "running bash", ""],
		["run", { tools: ["read", "read", "bash"] }, "Running 3 tools", "running 3 tools", ""],
		["text", { tokens: 1204, thoughtMs: 1000, sinceThoughtMs: 100 }, "Writing reply", "", "↓ 1,204 tokens"],
	] as const) {
		for (const verb of [undefined, DEFAULT_VERBS[0]]) {
			for (const withTokens of [false, true]) {
				const direction = tokenDetail === "↑" || withTokens ? tokenDetail : "";
				const expected = (verb ? "Proofing" : descriptive) + "…" + (verb && playful ? " " + playful : "") + " " + formatElapsed("phaseMs" in extra ? extra.phaseMs : base.phaseMs) + (direction ? " " + direction : "");
				assert.equal(renderRunStatus({ ...base, phase, ...extra, verb } as RunLine, theme, withTokens).slice(4), expected);
			}
		}
	}
});
test("token labels use the displayed rounded count for singular and plural", () => {
 for(const [tokens,label] of [[0.6,"1 token"],[1,"1 token"],[1.4,"1 token"],[1.6,"2 tokens"],[2,"2 tokens"]] as const){
  const row=renderRunStatus({...base,phase:"text",tokens},theme);
  assert.ok(row.endsWith(`↓ ${label}`));
 }
});
test("the step clock shares the status's amber/red tone, including reduced motion", () => {
 const painted={fg:(key:string,text:string)=>`<${key}>${text}</${key}>`};
 for(const reduced of [false,true]){
  const thinking=renderRunStatus({...base,phase:"think",phaseMs:20000,reduced},painted);
  const stalled=renderRunStatus({...base,phase:"api",phaseMs:20100,idleTokenMs:20100,reduced},painted);
  assert.ok(thinking.includes("<warning>00:20.0</warning>"));
  assert.ok(stalled.includes("<error>00:20.1</error>"));
 }
});
test("tool names strip bidi and invisible formatting in descriptive and playful divider captions", () => {
	const invisible = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
	for (const phase of ["tool", "run"] as const) {
		for (const verb of [undefined, DEFAULT_VERBS[0]]) {
			const row = renderRunStatus({ ...base, phase, verb, pendingTool: `ba${invisible}sh`, tools: [`ba${invisible}sh`] }, theme);
			assert.match(row, /bash/);
			assert.doesNotMatch(row, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
		}
	}
});
test("descriptive end metadata renders worked-for; old playful metadata still renders unchanged", () => {
	const end = { elapsedMs: 41000, doneAt: "9:14 PM" };
	assert.deepEqual(parseEndLine(end), end);
	assert.equal(renderEndLine(end, 80, theme), "π Worked for 41s, done 9:14 PM");
	assert.equal(renderEndLine({ ...end, stopped: true }, 80, theme), "π Stopped after 41s");
	assert.equal(renderEndLine({ ...end, past: "Mixed" }, 80, theme), "π Mixed for 41s, done 9:14 PM");
});
