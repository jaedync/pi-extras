import assert from "node:assert/strict";
import test from "node:test";
import { computerUseEnabled, registerComputerUse } from "../lib/computer-use/index.ts";
import type { RunOptions } from "../lib/computer-use/executor.ts";

test("computer use is off unless opted in, and only on macOS", () => {
	assert.equal(computerUseEnabled("darwin", {}), false);
	assert.equal(computerUseEnabled("darwin", { PI_COMPUTER_USE: "off" }), false);
	assert.equal(computerUseEnabled("linux", { PI_COMPUTER_USE: "on" }), false);
	for (const value of ["on", "1", "true", "YES"]) assert.equal(computerUseEnabled("darwin", { PI_COMPUTER_USE: value }), true);
});

function fakePi() {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const handlers = new Map<string, () => unknown>();
	return {
		tools, commands, handlers,
		pi: {
			registerTool: (tool: unknown) => tools.push(tool),
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			on: (event: string, handler: () => unknown) => handlers.set(event, handler),
		},
	};
}

function register(runs: RunOptions[] = [], answer?: string) {
	const fake = fakePi();
	let closed = 0;
	registerComputerUse(fake.pi as never, {
		executor: {
			async execute(code: string, options: RunOptions) {
				runs.push(options);
				const approval = await options.approve("Allow ChatGPT to use Finder?", true);
				return { content: [{ type: "text" as const, text: `ran ${code.length} chars, ${approval}` }], calls: ["get_app_state"] };
			},
		},
		close: async () => { closed++; },
		status: () => ["Computer Use: ready"],
	});
	const ui = { select: async (_title: string, options: string[]) => answer ?? options[0], notify: (message: string) => fake.tools.push({ notified: message }) };
	return { ...fake, ui, closed: () => closed };
}

test("registers one computer_use tool and a status command", () => {
	const { tools, commands, handlers } = register();
	assert.deepEqual(tools.map((tool) => tool.name), ["computer_use"]);
	assert.match(tools[0].description, /sky\.get_app_state/);
	assert.match(tools[0].description, /element_index/);
	assert.ok(commands.has("computer-use"));
	assert.ok(handlers.has("session_shutdown"));
});

test("app approvals are asked in Pi, and denied when nobody can answer", async () => {
	const { tools, ui } = register([], "Always allow");
	const withUi = await tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: true, ui });
	assert.deepEqual(withUi.content, [{ type: "text", text: "ran 1 chars, always" }]);
	assert.deepEqual(withUi.details.calls, ["get_app_state"]);

	const headless = await tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: false, ui });
	assert.match(headless.content[0].text, /deny/);

	const dismissed = register([], undefined);
	const escaped = await dismissed.tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: true, ui: { select: async () => undefined } });
	assert.match(escaped.content[0].text, /deny/);
});

test("a failed run is reported as a tool error", async () => {
	const fake = fakePi();
	registerComputerUse(fake.pi as never, {
		executor: { execute: async () => ({ content: [{ type: "text" as const, text: "Computer Use code stopped: boom" }], calls: [], error: "boom" }) },
		close: async () => {},
		status: () => [],
	});
	await assert.rejects(fake.tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: false }), /boom/);
});

test("shutting Pi down closes the session", async () => {
	const { handlers, closed } = register();
	await handlers.get("session_shutdown")!();
	assert.equal(closed(), 1);
});
