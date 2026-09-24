import assert from "node:assert/strict";
import test from "node:test";
import { describeCall, formatMs } from "../lib/computer-use/describe.ts";

test("each method is summarised by what it acts on", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["list_apps", {}, ""],
		["get_app_state", { app: "Finder", disableDiff: true }, "full tree"],
		["click", { app: "Finder", element_index: "12" }, "#12"],
		["click", { app: "Finder", x: 10, y: 20, mouse_button: "right", click_count: 2 }, "(10, 20) right ×2"],
		["perform_secondary_action", { app: "Finder", element_index: "3", action: "AXShowMenu" }, "#3 AXShowMenu"],
		["set_value", { app: "Notes", element_index: "4", value: "hi" }, '#4 = "hi"'],
		["select_text", { app: "Notes", element_index: "4", text: "word" }, '#4 "word"'],
		["scroll", { app: "Safari", element_index: "9", direction: "down", pages: 2 }, "#9 down 2 pages"],
		["drag", { app: "Finder", from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, "(1, 2) → (3, 4)"],
		["press_key", { app: "Finder", key: "cmd+c" }, "cmd+c"],
		["type_text", { app: "Notes", text: "a\tb\u001b[2J" }, '"a b [2J"'],
	];
	for (const [method, args, detail] of cases) assert.deepEqual(describeCall(method, args), { app: typeof args.app === "string" ? args.app : undefined, detail }, method);
	assert.match(describeCall("type_text", { app: "Notes", text: "x".repeat(200) }).detail, /^"x{40,}…"$/);
	assert.equal(describeCall("click", { app: 5 }).app, undefined);
});

test("durations read as milliseconds under a second and seconds above", () => {
	assert.equal(formatMs(46), "46ms");
	assert.equal(formatMs(999.6), "1.0s");
	assert.equal(formatMs(1234), "1.2s");
	assert.equal(formatMs(75_000), "1m 15s");
});
