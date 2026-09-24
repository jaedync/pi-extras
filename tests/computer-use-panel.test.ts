import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ApprovalPrompt } from "../lib/computer-use/approval-prompt.ts";
import { AppsPanel, type PanelApp, type PanelResult } from "../lib/computer-use/panel.ts";
import type { Approval, ApprovalRequest } from "../lib/computer-use/session.ts";

const paint = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", space: " ", backspace: "\x7f" };
const text = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	app: "Safari", message: "Allow ChatGPT to use Safari?", highRisk: true, canRemember: true,
	warning: "Allowing the agent to use this app introduces new risks, including those related to prompt injection attacks.", signal: new AbortController().signal, ...overrides,
});

test("the approval prompt names the app, shows the risk, and defaults to not allowing", () => {
	const answers: Approval[] = [];
	const prompt = new ApprovalPrompt(request(), paint, (answer) => answers.push(answer));
	const screen = text(prompt.render(80));
	assert.match(screen, /Allow the agent to use Safari\?/);
	assert.match(screen, /High risk\s+Allowing the agent to use this app introduces new risks/);
	assert.match(screen, /→ Don't allow\n\s+Allow for this session\n\s+Always allow\s+also applies to ChatGPT and Codex/);
	prompt.handleInput(KEY.enter);
	assert.deepEqual(answers, ["deny"]);
});

test("the approval prompt returns the chosen answer, and escape means no", () => {
	for (const [keys, expected] of [[[KEY.down, KEY.enter], "once"], [[KEY.down, KEY.down, KEY.enter], "always"], [[KEY.down, KEY.down, KEY.down, KEY.enter], "always"], [[KEY.down, KEY.esc], "deny"]] as const) {
		const answers: Approval[] = [];
		const prompt = new ApprovalPrompt(request(), paint, (answer) => answers.push(answer));
		for (const key of keys) prompt.handleInput(key);
		assert.deepEqual(answers, [expected], keys.join(","));
	}
	const answers: Approval[] = [];
	const plain = new ApprovalPrompt(request({ canRemember: false, warning: undefined, highRisk: false }), paint, (answer) => answers.push(answer));
	assert.doesNotMatch(text(plain.render(80)), /Always allow|High risk/);
	for (const key of [KEY.down, KEY.down, KEY.enter]) plain.handleInput(key);
	assert.deepEqual(answers, ["once"]);
});

test("every rendered line fits the width", () => {
	const prompt = new ApprovalPrompt(request({ warning: "word ".repeat(80) }), paint, () => {});
	for (const line of prompt.render(40)) assert.ok(visibleWidth(line) <= 40, line);
});

const finder: PanelApp = { bundleId: "com.apple.finder", name: "Finder", running: true };
const safari: PanelApp = { bundleId: "com.apple.Safari", name: "Safari", running: true };
const notes: PanelApp = { bundleId: "com.apple.Notes", name: "Notes" };

function panel(options: { apps?: Promise<PanelApp[]>; mode?: "ask" | "all" | "none"; allowed?: PanelApp[] } = {}) {
	const results: Array<PanelResult | "cancel"> = [];
	let renders = 0;
	const component = new AppsPanel({
		status: [{ level: "ok", text: "Client signed by OpenAI" }, { level: "info", text: "Client idle" }],
		mode: options.mode ?? "ask",
		allowed: options.allowed ?? [finder],
		apps: options.apps ?? Promise.resolve([safari, finder, notes]),
		requestRender: () => { renders++; },
	}, paint, (result) => results.push(result));
	const press = (...keys: string[]) => { for (const key of keys) component.handleInput(key); };
	return { component, results, press, renders: () => renders, screen: (width = 90) => text(component.render(width)) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the panel shows status, the mode, and checked apps at once, then merges the app list", async () => {
	let resolve!: (apps: PanelApp[]) => void;
	const { screen, renders } = panel({ apps: new Promise((r) => { resolve = r; }) });
	assert.match(screen(), /✓ Client signed by OpenAI/);
	assert.match(screen(), /● Ask per app\s+○ Allow all\s+○ Allow none/);
	assert.match(screen(), /› \[✓\] Finder\s+com\.apple\.finder/);
	assert.match(screen(), /Loading apps…/);
	resolve([safari, finder, notes]);
	await settle();
	assert.ok(renders() > 0);
	const rows = screen().split("\n").filter((line) => /\[[ ✓]\]/.test(line));
	assert.deepEqual(rows.map((row) => row.replace(/^[›\s]+/, "").split(/\s{2,}/)[0]), ["[✓] Finder", "[ ] Safari", "[ ] Notes"]);
});

test("checking an app asks for confirmation inside the panel before saving", async () => {
	const { press, results, screen } = panel();
	await settle();
	press(KEY.down, KEY.space);
	assert.match(screen(), /Safari.*will allow/);
	press(KEY.enter);
	assert.deepEqual(results, []);
	assert.match(screen(), /Always allow Safari\?/);
	assert.match(screen(), /without asking.*ChatGPT and Codex/s);
	assert.match(screen(), /prompt injection/);
	press(KEY.esc);
	assert.deepEqual(results, []);
	press(KEY.enter, KEY.enter);
	assert.deepEqual(results, [{ mode: "ask", allow: ["com.apple.Safari"], revoke: [] }]);
});

test("unchecking an app saves without a confirmation, since it only takes access away", async () => {
	const { press, results } = panel();
	await settle();
	press(KEY.space, KEY.enter);
	assert.deepEqual(results, [{ mode: "ask", allow: [], revoke: ["com.apple.finder"] }]);
});

test("left and right switch the mode; the checks are kept and shown as overridden", async () => {
	const { press, results, screen } = panel();
	await settle();
	press(KEY.right);
	assert.match(screen(), /○ Ask per app\s+● Allow all/);
	assert.match(screen(), /without asking/);
	assert.match(screen(), /\[✓\] Finder/);
	press(KEY.enter);
	assert.match(screen(), /Turn on Allow all\?/);
	press(KEY.enter);
	assert.deepEqual(results, [{ mode: "all", allow: [], revoke: [] }]);

	const none = panel({ mode: "all" });
	await settle();
	none.press(KEY.right, KEY.enter);
	assert.deepEqual(none.results, [{ mode: "none", allow: [], revoke: [] }]);
	const wrap = panel();
	wrap.press(KEY.left, KEY.enter);
	assert.deepEqual(wrap.results, [{ mode: "none", allow: [], revoke: [] }]);
});

test("typing filters the list, escape clears the filter, and a second escape cancels", async () => {
	const { press, results, screen } = panel();
	await settle();
	press("n", "o");
	assert.match(screen(), /filter: no/);
	assert.match(screen(), /Notes/);
	assert.doesNotMatch(screen(), /Safari/);
	press(KEY.space);
	press(KEY.backspace, KEY.backspace);
	assert.match(screen(), /Safari/);
	press("s");
	assert.match(screen(), /filter: s/);
	press(KEY.esc);
	assert.doesNotMatch(screen(), /filter:/);
	assert.deepEqual(results, []);
	press(KEY.esc);
	assert.deepEqual(results, ["cancel"]);
});

test("a locked checklist says why and ignores space, but the mode still changes", async () => {
	const results: Array<PanelResult | "cancel"> = [];
	const component = new AppsPanel({ status: [], mode: "ask", allowed: [finder], apps: Promise.resolve([finder, safari]), locked: "manage apps in the ChatGPT app instead", requestRender() {} }, paint, (result) => results.push(result));
	await settle();
	for (const key of [KEY.space, KEY.down, KEY.space]) component.handleInput(key);
	const screen = text(component.render(90));
	assert.match(screen, /\[✓\] Finder/);
	assert.match(screen, /\[ \] Safari/);
	assert.match(screen, /Can't change these here: manage apps in the ChatGPT app instead/);
	assert.doesNotMatch(screen, /space check/);
	for (const key of [KEY.left, KEY.enter]) component.handleInput(key);
	assert.deepEqual(results, [{ mode: "none", allow: [], revoke: [] }]);
});

test("a failed app list still shows the checked apps and the reason", async () => {
	const { screen } = panel({ apps: Promise.reject(new Error("client exited")) });
	await settle();
	assert.match(screen(), /\[✓\] Finder/);
	assert.match(screen(), /Couldn't list apps: client exited/);
});

test("a long list scrolls with the cursor and every line fits the width", async () => {
	const many = Array.from({ length: 40 }, (_, index) => ({ bundleId: `com.example.app${index}`, name: `App ${String(index).padStart(2, "0")} with a rather long name`, running: false }));
	const { press, screen, component } = panel({ apps: Promise.resolve(many) });
	await settle();
	assert.match(screen(), /↓ \d+ more/);
	for (let index = 0; index < 30; index++) press(KEY.down);
	assert.match(screen(), /↑ \d+ more/);
	assert.match(screen(), /› \[ \] App 29/);
	for (const line of component.render(50)) assert.ok(visibleWidth(line) <= 50, line);
});
