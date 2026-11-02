import assert from "node:assert/strict";
import test from "node:test";
import { CodeExecutor } from "../lib/computer-use/executor.ts";
import { identity, parseTree } from "../lib/computer-use/index-guard.ts";
import type { CallOptions, ToolResult } from "../lib/computer-use/session.ts";

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], isError });

const header = (pid = 81606) => `Computer Use state (CUA App Version: 1000816)\n<app_state>\nApp=/System/Applications/Calculator.app/ (bundleID com.apple.calculator, pid ${pid})\nWindow: "Calculator", App: Calculator.\n`;

/** Basic mode, as Sky printed it on the Mac (trimmed): index 15 is the 5 button. */
const BASIC = `${header()}0 standard window Calculator, ID: main, Secondary Actions: Raise
\t1 split group main, SidebarNavigationSplitView
\t\t2 splitter (disabled, settable, float) -1
\t\t3 container CalculatorKeypadView
\t\t\t4 scroll area ID: StandardInputView;value:7, Secondary Actions: Copy
\t\t\t\t5 text Description: Edit field, Value: 7
\t\t\t6 button Description: Delete, Help: Delete the last digit or operation entered (long press to delete all)
\t\t\t7 button Clear
\t\t\t8 button Percent
\t\t\t9 button Divide
\t\t\t10 button Description: 7, ID: Seven
\t\t\t11 button Description: 8, ID: Eight
\t\t\t12 button Description: 9, ID: Nine
\t\t\t13 button Multiply
\t\t\t14 button Description: 4, ID: Four
\t\t\t15 button Description: 5, ID: Five
\t\t\t16 button Description: 6, ID: Six

</app_state>`;

/** Scientific mode: the layout moved, and index 15 is now Divide. */
const SCIENTIFIC = BASIC.replace("15 button Description: 5, ID: Five", "15 button Divide").replace("9 button Divide", "9 button Description: 2nd, ID: Second");

/** Basic mode after a digit: values and the Clear label's flags changed, the elements did not. */
const BASIC_AFTER_DIGIT = BASIC.replace("ID: StandardInputView;value:7", "ID: StandardInputView;value:75").replace("Value: 7\n", "Value: 75\n").replace("2 splitter (disabled, settable, float) -1", "2 splitter (settable, float) -1");

const approve = async () => "once" as const;

/** A fake Sky whose tree for each app is whatever `screen.tree` holds when it is read. */
function fakeSky(screen: { tree: string }, diffAfterFirst = false) {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let reads = 0;
	return {
		calls,
		session: {
			async call(tool: string, args: Record<string, unknown>, _options: CallOptions): Promise<ToolResult> {
				calls.push({ tool, args });
				if (tool !== "get_app_state") return text(`${tool} done`);
				reads++;
				if (diffAfterFirst && reads > 1 && args.disableDiff !== true) return text("<app_state_diff>\n~ 15 button Divide\n</app_state_diff>");
				return { content: [{ type: "text", text: screen.tree }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false };
			},
		},
	};
}

test("parseTree reads each row of a full tree by its index, and the bundle id", () => {
	const tree = parseTree(BASIC);
	assert.ok(tree);
	assert.equal(tree.bundleId, "com.apple.calculator");
	assert.equal(tree.rows.get("15"), "button Description: 5, ID: Five");
	assert.equal(tree.rows.get("0"), "standard window Calculator, ID: main, Secondary Actions: Raise");
	assert.equal(tree.rows.size, 17);
});

test("parseTree gives nothing for text that is not a full tree", () => {
	assert.equal(parseTree("<app_state_diff>\n~ 15 button Divide\n</app_state_diff>"), undefined);
	assert.equal(parseTree("click done"), undefined);
	assert.equal(parseTree("\t\t15 button Divide\n\t\t16 button Multiply"), undefined, "rows that do not start at 0 are a partial view");
});

test("parseTree keeps a multi-line value with its row", () => {
	const tree = parseTree(`${header()}0 standard window Notes\n\t1 text Value: first line\n2026 was a year\n\t2 button Done\n</app_state>`);
	assert.equal(tree?.rows.get("2"), "button Done");
	assert.equal(tree?.rows.size, 3);
});

test("identity ignores what changes with normal use: values, flags, help and secondary actions", () => {
	assert.equal(identity("text Description: Edit field, Value: 7"), identity("text Description: Edit field, Value: 75"));
	assert.equal(identity("splitter (disabled, settable, float)"), identity("splitter (settable, float)"));
	assert.equal(identity("scroll area ID: StandardInputView;value:7, Secondary Actions: Copy"), identity("scroll area ID: StandardInputView;value:75"));
	assert.equal(identity("button Description: Mode, ID: Mode: basic; unitConversion: false"), identity("button Description: Mode, ID: Mode: scientific; unitConversion: false"));
});

test("identity tells different elements apart", () => {
	assert.notEqual(identity("button Description: 5, ID: Five"), identity("button Divide"));
	assert.notEqual(identity("button Description: 5, ID: Five"), identity("button Description: 6, ID: Six"));
	assert.notEqual(identity("scroll area ID: StandardResultView"), identity("scroll area ID: StandardInputView;value:7"));
	assert.notEqual(identity("button Clear"), identity("button Description: All Clear, ID: AllClear"));
});

test("a stale index after a layout change is refused, and the click is not sent", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen);
	const session = { call: async (tool: string, args: Record<string, unknown>, options: CallOptions) => {
		const result = await sky.session.call(tool, args, options);
		if (tool === "press_key") screen.tree = SCIENTIFIC;
		return result;
	} };
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator", disableDiff: true });
		await sky.press_key({ app: "Calculator", key: "cmd+2" });
		await sky.click({ app: "Calculator", element_index: "15" });
	`, { approve });
	assert.match(result.error ?? "", /element_index "15" is stale/);
	assert.match(result.error ?? "", /"button Description: 5, ID: Five"/);
	assert.match(result.error ?? "", /"button Divide"/);
	assert.match(result.error ?? "", /get_app_state/);
	assert.deepEqual(sky.calls.map((call) => call.tool), ["get_app_state", "press_key", "get_app_state"]);
	assert.equal(sky.calls[2].args.disableDiff, true, "the check reads a full tree");
	assert.deepEqual(result.calls.map((call) => [call.method, call.ok]), [["get_app_state", true], ["press_key", true], ["click", false]]);
});

test("the refusal is an error the code can catch, and a new get_app_state makes the index usable", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen);
	const session = { call: async (tool: string, args: Record<string, unknown>, options: CallOptions) => {
		const result = await sky.session.call(tool, args, options);
		if (tool === "press_key") screen.tree = SCIENTIFIC;
		return result;
	} };
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		await sky.press_key({ app: "Calculator", key: "cmd+2" });
		try { await sky.click({ app: "Calculator", element_index: "15" }); } catch (e) { emit("caught"); }
		await sky.get_app_state({ app: "Calculator" });
		emit(await sky.click({ app: "Calculator", element_index: "15" }));
	`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(result.content.map((block) => block.type === "text" ? block.text : ""), ["caught", "click done"]);
});

test("the first element action after a read costs no extra read", async () => {
	const sky = fakeSky({ tree: BASIC });
	const executor = new CodeExecutor({ session: sky.session });
	await executor.execute(`await sky.get_app_state({ app: "Calculator" }); await sky.click({ app: "Calculator", element_index: "15" });`, { approve });
	assert.deepEqual(sky.calls.map((call) => call.tool), ["get_app_state", "click"]);
});

test("an element action after another action checks the index and goes ahead when the element is the same", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen);
	const session = { call: async (tool: string, args: Record<string, unknown>, options: CallOptions) => {
		const result = await sky.session.call(tool, args, options);
		if (tool === "click") screen.tree = BASIC_AFTER_DIGIT;
		return result;
	} };
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		await sky.click({ app: "Calculator", element_index: "15" });
		await sky.click({ app: "Calculator", element_index: "16" });
		await sky.scroll({ app: "Calculator", element_index: "4", direction: "down" });
	`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(sky.calls.map((call) => call.tool), ["get_app_state", "click", "get_app_state", "click", "get_app_state", "scroll"]);
});

test("the guard holds across tool calls, and keys apps by bundle id", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen);
	const session = { call: async (tool: string, args: Record<string, unknown>, options: CallOptions) => {
		const result = await sky.session.call(tool, args, options);
		if (tool === "press_key") screen.tree = SCIENTIFIC;
		return result;
	} };
	const executor = new CodeExecutor({ session });
	await executor.execute(`await sky.get_app_state({ app: "Calculator" });`, { approve });
	await executor.execute(`await sky.press_key({ app: "com.apple.calculator", key: "cmd+2" });`, { approve });
	const result = await executor.execute(`await sky.set_value({ app: "calculator", element_index: "15", value: "x" });`, { approve });
	assert.match(result.error ?? "", /element_index "15" is stale/);
	assert.equal(sky.calls.some((call) => call.tool === "set_value"), false);
});

test("an index that the last tree did not have is not checked, so the guard cannot loop", async () => {
	const sky = fakeSky({ tree: BASIC });
	const executor = new CodeExecutor({ session: sky.session });
	const result = await executor.execute(`await sky.get_app_state({ app: "Calculator" }); await sky.press_key({ app: "Calculator", key: "a" }); await sky.click({ app: "Calculator", element_index: "99" });`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(sky.calls.map((call) => call.tool), ["get_app_state", "press_key", "click"]);
});

test("an element that is gone from the current tree is refused", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen);
	const session = { call: async (tool: string, args: Record<string, unknown>, options: CallOptions) => {
		const result = await sky.session.call(tool, args, options);
		if (tool === "press_key") screen.tree = BASIC.replace(/\n\t\t\t16 button[^\n]*/, "");
		return result;
	} };
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`await sky.get_app_state({ app: "Calculator" }); await sky.press_key({ app: "Calculator", key: "a" }); await sky.click({ app: "Calculator", element_index: "16" });`, { approve });
	assert.match(result.error ?? "", /element_index "16" is stale/);
	assert.match(result.error ?? "", /no element has that index now/);
});

test("a check read that fails refuses the action with the reason", async () => {
	let reads = 0;
	const calls: string[] = [];
	const session = { call: async (tool: string) => {
		calls.push(tool);
		if (tool === "get_app_state" && ++reads > 1) return text("-10005: timeoutReached", true);
		return tool === "get_app_state" ? text(BASIC) : text(`${tool} done`);
	} };
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`await sky.get_app_state({ app: "Calculator" }); await sky.press_key({ app: "Calculator", key: "a" }); await sky.click({ app: "Calculator", element_index: "15" });`, { approve });
	assert.match(result.error ?? "", /could not check element_index "15".*timeoutReached/);
	assert.deepEqual(calls, ["get_app_state", "press_key", "get_app_state"]);
});

test("after a check read, the next get_app_state of the code gives a full tree, so a diff never skips what the code did not see", async () => {
	const sky = fakeSky({ tree: BASIC });
	const executor = new CodeExecutor({ session: sky.session });
	await executor.execute(`await sky.get_app_state({ app: "Calculator" }); await sky.press_key({ app: "Calculator", key: "a" }); await sky.click({ app: "Calculator", element_index: "15" }); await sky.get_app_state({ app: "Calculator" }); await sky.get_app_state({ app: "Calculator" });`, { approve });
	const reads = sky.calls.filter((call) => call.tool === "get_app_state").map((call) => call.args.disableDiff === true);
	assert.deepEqual(reads, [false, true, true, false]);
});

test("when the code gets a diff, the guard reads a full tree once for its baseline", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen, true);
	const executor = new CodeExecutor({ session: sky.session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		const diff = await sky.get_app_state({ app: "Calculator" });
		emit(diff.text);
		await sky.click({ app: "Calculator", element_index: "15" });
	`, { approve });
	assert.equal(result.error, undefined);
	assert.match(String(result.content[0].type === "text" ? result.content[0].text : ""), /app_state_diff/, "the code still gets the diff it asked for");
	assert.deepEqual(sky.calls.map((call) => [call.tool, call.args.disableDiff === true]), [["get_app_state", false], ["get_app_state", false], ["get_app_state", true], ["click", false]]);
});

test("coordinate clicks and keys are never refused, and an app without a read is not checked", async () => {
	const sky = fakeSky({ tree: BASIC });
	const executor = new CodeExecutor({ session: sky.session });
	const result = await executor.execute(`
		await sky.click({ app: "Finder", element_index: "3" });
		await sky.get_app_state({ app: "Calculator" });
		await sky.press_key({ app: "Calculator", key: "a" });
		await sky.click({ app: "Calculator", x: 10, y: 20 });
		await sky.type_text({ app: "Calculator", text: "1" });
	`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(sky.calls.map((call) => call.tool), ["click", "get_app_state", "press_key", "click", "type_text"]);
});
