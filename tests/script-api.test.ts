import assert from "node:assert/strict";
import test from "node:test";
import { CodeExecutor, type ScriptApi } from "../lib/computer-use/executor.ts";
import type { CallOptions, ToolResult } from "../lib/computer-use/session.ts";

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }], isError: false });
const approve = async () => "once" as const;

/** A second API on the same executor: nested methods, its own name, images from more than one method. */
const API: ScriptApi = {
	tool: "windows_use",
	global: "win",
	methods: ["vms", "snapshot", "console.click", "console.screenshot"],
	label: "Windows",
	imageHint: "win.snapshot or win.console.screenshot",
	describe: (method, args) => ({ app: typeof args.vm === "string" ? args.vm : undefined, detail: method === "console.click" ? `(${args.x}, ${args.y})` : "" }),
	value(method, _args, result, keep) {
		const body = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		const image = result.content.find((block) => block.type === "image");
		if (method === "snapshot" || method === "console.screenshot") return { text: body, screenshot: image && image.type === "image" ? keep(image) : null };
		return body || null;
	},
};

function session(handler: (tool: string, args: Record<string, unknown>) => ToolResult = (tool) => text(`${tool} ok`)) {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	return {
		calls,
		session: {
			async call(tool: string, args: Record<string, unknown>, _options: CallOptions) {
				calls.push({ tool, args });
				return handler(tool, args);
			},
		},
	};
}

test("a custom API exposes its methods under its own global, nested by dots", async () => {
	const { session: s, calls } = session();
	const executor = new CodeExecutor({ session: s, api: API });
	const result = await executor.execute(`emit(await win.vms()); await win.console.click({ vm: "A", x: 1, y: 2 }); emit(typeof sky);`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(calls.map((call) => call.tool), ["vms", "console.click"]);
	assert.deepEqual(result.content, [{ type: "text", text: "vms ok" }, { type: "text", text: "undefined" }]);
	assert.deepEqual(result.calls.map((call) => [call.method, call.app, call.detail]), [["vms", undefined, ""], ["console.click", "A", "(1, 2)"]]);
});

test("a custom API decides which results carry screenshot handles", async () => {
	const { session: s } = session(() => ({ content: [{ type: "text", text: "tree" }, { type: "image", data: "BBBB", mimeType: "image/png" }], isError: false }));
	const executor = new CodeExecutor({ session: s, api: API });
	const result = await executor.execute(`const a = await win.snapshot({ vm: "A" }); const b = await win.console.screenshot({ vm: "A" }); emit(a.text); emitImage(a.screenshot); emitImage(b.screenshot);`, { approve });
	assert.deepEqual(result.content, [{ type: "text", text: "tree" }, { type: "image", data: "BBBB", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/png" }]);
});

test("emitImage also takes the whole result that carries the screenshot", async () => {
	const { session: s } = session(() => ({ content: [{ type: "text", text: "tree" }, { type: "image", data: "BBBB", mimeType: "image/png" }], isError: false }));
	const executor = new CodeExecutor({ session: s, api: API });
	const result = await executor.execute(`emitImage(await win.console.screenshot({ vm: "A" }));`, { approve });
	assert.equal(result.error, undefined);
	assert.deepEqual(result.content, [{ type: "image", data: "BBBB", mimeType: "image/png" }]);
});

test("a custom API's errors and limits use its label and image hint", async () => {
	const executor = new CodeExecutor({ session: session().session, api: API, sliceMs: 100 });
	const bad = await executor.execute(`emitImage({});`, { approve });
	assert.match(bad.error ?? "", /win\.snapshot or win\.console\.screenshot/);
	const slow = await executor.execute(`while (true) {}`, { approve });
	assert.match(slow.error ?? "", /100 ms between Windows calls/);
	const last = slow.content.at(-1);
	assert.match(last?.type === "text" ? last.text : "", /^Windows code stopped:/);
});

test("the default API is still sky, unchanged", async () => {
	const { session: s } = session();
	const executor = new CodeExecutor({ session: s });
	const result = await executor.execute(`emit(typeof win); emit(await sky.list_apps());`, { approve });
	assert.deepEqual(result.content, [{ type: "text", text: "undefined" }, { type: "text", text: "list_apps ok" }]);
	const bad = await executor.execute(`emitImage({});`, { approve });
	assert.match(bad.error ?? "", /emitImage needs the screenshot from sky\.get_app_state/);
});
