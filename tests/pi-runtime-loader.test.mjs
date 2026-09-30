import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

test("the opt-in loader imports the selected runtime, not the pinned development copy", () => {
	const loader = fileURLToPath(new URL("./support/pi-runtime-loader.mjs", import.meta.url));
	const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", `
		import { initTheme } from "@earendil-works/pi-coding-agent";
		import { readFileSync } from "node:fs";
		import { fileURLToPath } from "node:url";
		if (typeof initTheme !== "function") throw new Error("Runtime import failed");
		const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"));
		console.log(JSON.stringify({ version: metadata.version, entry: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")) }));
	`], { env: process.env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const imported = JSON.parse(result.stdout);
	assert.equal(imported.version, JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")).version);
	assert.equal(dirname(dirname(imported.entry)), agentRoot);
});
