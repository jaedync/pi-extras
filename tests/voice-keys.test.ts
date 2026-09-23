import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLD_THRESHOLD_MS, LEGACY_REPEAT_GAP_MS, initialKeyState, reduceKey, type KeyState } from "../lib/voice/keys.ts";

function run(events: Array<[kind: "press" | "repeat" | "release", at: number]>): string[] {
	let state: KeyState = initialKeyState;
	const actions: string[] = [];
	for (const [kind, at] of events) {
		const next = reduceKey(state, kind, at);
		state = next.state;
		if (next.action !== "ignore") actions.push(`${next.action}@${at}`);
	}
	return actions;
}

test("holding past the threshold records until release", () => {
	assert.deepEqual(run([["press", 0], ["repeat", 400], ["repeat", 430], ["release", 2000]]), ["start@0", "stop@2000"]);
});

test("a quick tap toggles: second press stops", () => {
	assert.deepEqual(run([["press", 0], ["release", 120], ["press", 3000], ["release", 3100]]), ["start@0", "stop@3000"]);
});

test("release exactly at the threshold counts as a hold", () => {
	assert.deepEqual(run([["press", 0], ["release", HOLD_THRESHOLD_MS]]), ["start@0", `stop@${HOLD_THRESHOLD_MS}`]);
});

test("legacy terminals without release events: autorepeat presses are swallowed", () => {
	// Terminal sends the first press, waits for the repeat delay, then repeats quickly.
	const held = [["press", 0], ["press", 450], ["press", 480], ["press", 510]] as Array<["press", number]>;
	assert.deepEqual(run([...held, ["press", 510 + LEGACY_REPEAT_GAP_MS + 1]]), ["start@0", `stop@${510 + LEGACY_REPEAT_GAP_MS + 1}`]);
});

test("stray release while idle does nothing", () => {
	assert.deepEqual(run([["release", 10]]), []);
});

test("after a hold ends, the next press starts a new recording", () => {
	assert.deepEqual(run([["press", 0], ["release", 1000], ["press", 5000], ["release", 6000]]), ["start@0", "stop@1000", "start@5000", "stop@6000"]);
});

test("reducer never mutates the previous state", () => {
	const before = Object.freeze({ ...initialKeyState });
	assert.doesNotThrow(() => reduceKey(before, "press", 0));
});
