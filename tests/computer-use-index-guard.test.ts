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
	assert.deepEqual(tree.rows.get("15"), { depth: 3, text: "button Description: 5, ID: Five" });
	assert.deepEqual(tree.rows.get("0"), { depth: 0, text: "standard window Calculator, ID: main, Secondary Actions: Raise" });
	assert.equal(tree.rows.size, 17);
	assert.deepEqual(tree.names, ["Calculator", "Calculator.app"]);
});

test("parseTree gives nothing for text that is not a full tree", () => {
	assert.equal(parseTree("<app_state_diff>\n~ 15 button Divide\n</app_state_diff>"), undefined);
	assert.equal(parseTree("click done"), undefined);
	assert.equal(parseTree("\t\t15 button Divide\n\t\t16 button Multiply"), undefined, "rows that do not start at 0 are a partial view");
});

test("parseTree keeps a multi-line value with its row", () => {
	const tree = parseTree(`${header()}0 standard window Notes\n\t1 text Value: first line\n2026 was a year\n\t2 button Done\n</app_state>`);
	assert.equal(tree?.rows.get("2")?.text, "button Done");
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

test("after a check read that saw a change, the next get_app_state of the code gives a full tree, so a diff never skips what the code did not see", async () => {
	const { sky, session } = changingSky(BASIC, "press_key", BASIC_AFTER_DIGIT);
	const executor = new CodeExecutor({ session });
	await executor.execute(`await sky.get_app_state({ app: "Calculator" }); await sky.press_key({ app: "Calculator", key: "a" }); await sky.click({ app: "Calculator", element_index: "15" }); await sky.get_app_state({ app: "Calculator" }); await sky.get_app_state({ app: "Calculator" });`, { approve });
	const reads = sky.calls.filter((call) => call.tool === "get_app_state").map((call) => call.args.disableDiff === true);
	assert.deepEqual(reads, [false, true, true, false]);
});

test("a check read that saw no change leaves the code's next read a diff", async () => {
	const sky = fakeSky({ tree: BASIC });
	const executor = new CodeExecutor({ session: sky.session });
	await executor.execute(`await sky.get_app_state({ app: "Calculator" });`, { approve });
	await executor.execute(`await sky.click({ app: "Calculator", element_index: "15" }); await sky.get_app_state({ app: "Calculator" });`, { approve });
	const reads = sky.calls.filter((call) => call.tool === "get_app_state").map((call) => call.args.disableDiff === true);
	assert.deepEqual(reads, [false, true, false], "the guard's read, then the code's read as it asked for it");
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

/** A mail list: each row holds the same flag button, and its text tells the items apart. */
const LIST = (first: number) => `${header()}0 standard window Mail, ID: main
\t1 table Messages
\t\t2 row
\t\t\t3 text Item ${first}
\t\t\t4 button Description: Flag, ID: flag-${first}
\t\t5 row
\t\t\t6 text Item ${first + 1}
\t\t\t7 button Description: Flag, ID: flag-${first + 1}
</app_state>`;

/** A session whose tree becomes `next` after the first call of `tool`. */
function changingSky(first: string, tool: string, next: string) {
	const screen = { tree: first };
	const sky = fakeSky(screen);
	const session = { call: async (name: string, args: Record<string, unknown>, options: CallOptions) => {
		const result = await sky.session.call(name, args, options);
		if (name === tool) screen.tree = next;
		return result;
	} };
	return { sky, session };
}

test("a list that moves by one item is caught: a row is told apart by its children, a button by its ID", async () => {
	for (const index of ["2", "4"]) {
		const { sky, session } = changingSky(LIST(3), "press_key", LIST(4));
		const executor = new CodeExecutor({ session });
		const result = await executor.execute(`
			await sky.get_app_state({ app: "Calculator" });
			await sky.press_key({ app: "Calculator", key: "Down" });
			await sky.click({ app: "Calculator", element_index: "${index}" });
		`, { approve });
		assert.match(result.error ?? "", new RegExp(`element_index "${index}" is stale`), `index ${index}`);
		assert.equal(sky.calls.some((call) => call.tool === "click"), false);
	}
});

test("the same element at the same index still passes when only its value changed", async () => {
	const slider = (value: string) => `${header()}0 standard window Mixer\n\t1 slider (settable, float) ${value}\n</app_state>`;
	assert.equal(identity("slider (settable, float) 0.5"), identity("slider (settable, float) 0.7"));
	const { sky, session } = changingSky(slider("0.5"), "set_value", slider("0.7"));
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		await sky.set_value({ app: "Calculator", element_index: "1", value: "0.7" });
		await sky.set_value({ app: "Calculator", element_index: "1", value: "0.9" });
	`, { approve });
	assert.equal(result.error, undefined);
	assert.equal(sky.calls.filter((call) => call.tool === "set_value").length, 2);
});

test("a call that runs at the same time cannot move the layout between the check and the click", async () => {
	const { sky, session: direct } = changingSky(BASIC, "press_key", SCIENTIFIC);
	// As the real session does: one call at a time, in the order they come, each taking a moment.
	let queue: Promise<unknown> = Promise.resolve();
	const session = { call: (tool: string, args: Record<string, unknown>, options: CallOptions) => {
		const next = queue.then(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return direct.call(tool, args, options); });
		queue = next.catch(() => {});
		return next;
	} };
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		await sky.click({ app: "Calculator", element_index: "16" });
		await Promise.allSettled([sky.click({ app: "Calculator", element_index: "15" }), sky.press_key({ app: "Calculator", key: "cmd+2" })]);
	`, { approve });
	assert.equal(result.error, undefined);
	const tools = sky.calls.map((call) => call.tool);
	const click = tools.lastIndexOf("click");
	assert.equal(tools[click - 1], "get_app_state", `the check read comes right before the click: ${tools.join(", ")}`);
	assert.ok(click < tools.indexOf("press_key"), "the click, checked against Basic, goes before the mode switch");
});

test("an app read by its bundle id is checked when the code acts on it by its name, or by a name the guard does not know", async () => {
	for (const name of ["Calculator", "Calculator.app", "Calc"]) {
		const { sky, session } = changingSky(BASIC, "press_key", SCIENTIFIC);
		const executor = new CodeExecutor({ session });
		const result = await executor.execute(`
			await sky.get_app_state({ app: "com.apple.calculator" });
			await sky.press_key({ app: "${name}", key: "cmd+2" });
			await sky.click({ app: "com.apple.calculator", element_index: "15" });
		`, { approve });
		assert.match(result.error ?? "", /element_index "15" is stale/, name);
		assert.equal(sky.calls.some((call) => call.tool === "click"), false, name);
	}
});

test("a new run checks its first element action, since the window can change between tool calls", async () => {
	const screen = { tree: BASIC };
	const sky = fakeSky(screen);
	const executor = new CodeExecutor({ session: sky.session });
	await executor.execute(`await sky.get_app_state({ app: "Calculator" });`, { approve });
	screen.tree = SCIENTIFIC;
	const result = await executor.execute(`await sky.click({ app: "Calculator", element_index: "15" });`, { approve });
	assert.match(result.error ?? "", /element_index "15" is stale/);
	assert.equal(sky.calls.some((call) => call.tool === "click"), false);
});

test("a diff that holds a row 0 is not a full tree", () => {
	assert.equal(parseTree("<app_state_diff>\n0 standard window W2\n\t\t15 button Divide\n</app_state_diff>"), undefined);
	assert.equal(parseTree(`${header()}0 standard window W2\n\t\t15 button Divide\n</app_state>`), undefined, "an indented row out of order is a partial view");
});

test("refusals in a row reuse one check read while no action goes to the app", async () => {
	const { sky, session } = changingSky(BASIC, "press_key", SCIENTIFIC);
	const executor = new CodeExecutor({ session });
	await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		await sky.press_key({ app: "Calculator", key: "cmd+2" });
		for (const index of ["15", "9", "15"]) { try { await sky.click({ app: "Calculator", element_index: index }); } catch {} }
	`, { approve });
	assert.deepEqual(sky.calls.map((call) => call.tool), ["get_app_state", "press_key", "get_app_state"]);
});

test("a second scroll of a list passes, though the scroll changed the rows that the list shows", async () => {
	const list = (first: number) => `${header()}0 standard window Mail\n\t1 scroll area Messages\n\t\t2 cell Item ${first}\n\t\t3 cell Item ${first + 1}\n</app_state>`;
	const { sky, session } = changingSky(list(1), "scroll", list(9));
	const executor = new CodeExecutor({ session });
	const result = await executor.execute(`
		await sky.get_app_state({ app: "Calculator" });
		await sky.scroll({ app: "Calculator", element_index: "1", direction: "down" });
		await sky.scroll({ app: "Calculator", element_index: "1", direction: "down" });
	`, { approve });
	assert.equal(result.error, undefined);
	assert.equal(sky.calls.filter((call) => call.tool === "scroll").length, 2);
});

test("a row passes when one of its two child labels changed with state, and fails when both changed", async () => {
	const row = (unread: number, name = "Inbox") => `${header()}0 standard window Mail\n\t1 row\n\t\t2 text ${name}\n\t\t3 text ${unread} unread\n</app_state>`;
	for (const [next, ok] of [[row(3), true], [row(3, "Sent"), false]] as const) {
		const { sky, session } = changingSky(row(4), "click", next);
		const executor = new CodeExecutor({ session });
		const result = await executor.execute(`
			await sky.get_app_state({ app: "Calculator" });
			await sky.click({ app: "Calculator", element_index: "1" });
			await sky.click({ app: "Calculator", element_index: "1" });
		`, { approve });
		assert.equal(result.error === undefined, ok, result.error);
		assert.equal(sky.calls.filter((call) => call.tool === "click").length, ok ? 2 : 1);
	}
});

test("text after the flags counts as a title, and only a bare number counts as a value", () => {
	assert.notEqual(identity("checkbox (settable) Remember me"), identity("checkbox (settable) Send copies"));
	assert.notEqual(identity("button (disabled) Save"), identity("button (disabled) Delete"));
	assert.equal(identity("splitter (disabled, settable, float) -1"), identity("splitter (settable, float) 240.5"));
	assert.equal(identity("slider (settable) 40%"), identity("slider (settable) 75%"));
});
