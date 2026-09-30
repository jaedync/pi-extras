/** Synthetic argument fragments through Pi's parser and real tool row, with no provider or session. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codemodeRenderers } from "../lib/tool-display/codemode.ts";
import { harness } from "./support/tool-rows.ts";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "codemode-stream-"));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const require = createRequire(join(agentRoot, "package.json"));
const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as any;
const { parseStreamingJson } = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js")).href) as any;
sdk.initTheme("dark");
const plain = (component: any, width = 100): string[] => component.render(width).map((line: string) => tui.stripTerminalSequences(line).trimEnd()).filter(Boolean);

function setup() {
	const h = harness();
	const renderers = codemodeRenderers(h.kit, { name: "codemode" });
	const component = new sdk.ToolExecutionComponent("codemode", "stream-fixture", {}, {}, { ...renderers, renderShell: "self" }, { requestRender() {} }, "/synthetic");
	return { ...h, component };
}

test("real Pi row shows writing fallback, then incremental decoded JavaScript even while collapsed", () => {
	const h = setup();
	try {
		assert.match(plain(h.component).join("\n"), /Writing JavaScript…/);
		for (const code of ["await tools.", 'await tools.bash({ command: "printf', 'await tools.bash({ command: "printf \\\"界😀\\\"" });\nreturn']) {
			const partial = JSON.stringify({ code }).slice(0, -2);
			h.component.updateArgs(parseStreamingJson(partial));
			const output = plain(h.component).join("\n");
			assert.match(output, /Writing JavaScript…/);
			assert.ok(output.includes(code.split("\n")[0]!), output);
			assert.doesNotMatch(output, /ƒ\d|queued|running|\d+ calls/);
		}
		h.component.updateArgs({ code: "return 'complete';" });
		h.component.setArgsComplete();
		assert.doesNotMatch(plain(h.component).join("\n"), /Writing JavaScript/);
		assert.match(plain(h.component).join("\n"), /queued/);
		h.component.markExecutionStarted();
		assert.doesNotMatch(plain(h.component).join("\n"), /Writing JavaScript|ƒ\d/);
	} finally { h.kit.clock.stop(); }
});

test("streaming source preview is bounded, sanitized, updates after invalidation and handles aliases", () => {
	const h = setup();
	try {
		for (const expanded of [false, true]) {
			h.component.setExpanded(expanded);
			for (const key of ["code", "script", "source"]) {
				h.component.updateArgs({ [key]: Array.from({ length: 100 }, (_, i) => `// ${i} ${"界😀".repeat(200)}`).join("\n") + "\nawait tools.read({" });
				const lines = plain(h.component);
				assert.ok(lines.length <= 7, `preview stays restrained: ${lines.length} lines`);
				assert.match(lines.join("\n"), /preview truncated/);
				assert.match(lines.join("\n"), /await tools.read/);
				for (const width of [1, 2, 4, 8, 20, 40]) assert.ok(h.component.render(width).every((line: string) => tui.visibleWidth(line) <= width), `width ${width}`);
			}
		}
		h.component.updateArgs({ code: "return '\x1b]52;c;private\x07界😀';\x00" });
		h.component.invalidate();
		assert.doesNotMatch(plain(h.component).join("\n"), /private|\x00|\x07/);
		h.component.updateResult({ content: [{ type: "text", text: "cancelled" }], isError: true }, false);
		assert.doesNotMatch(plain(h.component).join("\n"), /Writing JavaScript|queued|ƒ\d/);
	} finally { h.kit.clock.stop(); }
});
