import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the Codex auth file follows Pi's agent directory, ~ included", (t) => {
	const home = mkdtempSync(join(tmpdir(), "agent-dir-tilde-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const url = new URL("../lib/provider-limits.ts", import.meta.url).href;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); process.stdout.write(m.CODEX_AUTH_FILE);`], {
		env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: "~/agent-x", PI_OFFLINE: "1" }, encoding: "utf8",
	});
	assert.equal(out, join(home, "agent-x", "auth.json"));
});
