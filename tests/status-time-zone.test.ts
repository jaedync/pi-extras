import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTimeZone } from "../lib/status-plus-logic.ts";

const SYSTEM = Intl.DateTimeFormat().resolvedOptions().timeZone;

test("an unknown STATUSLINE_TZ falls back to the system zone and says why", () => {
	assert.deepEqual(resolveTimeZone("America/Chicago"), { timeZone: "America/Chicago" });
	assert.deepEqual(resolveTimeZone(undefined), { timeZone: SYSTEM });
	assert.deepEqual(resolveTimeZone(""), { timeZone: SYSTEM });
	const bad = resolveTimeZone("Not/AZone");
	assert.equal(bad.timeZone, SYSTEM);
	assert.match(bad.problem ?? "", /STATUSLINE_TZ/);
});

// The zone is read once at import, so a fresh process sees the bad value the way Pi would.
test("with an unknown STATUSLINE_TZ the clock, reset labels, usage report and footer still work, and status-plus logs it once", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "status-tz-"));
	try {
		const script = `
			const { hhmm } = await import(${JSON.stringify(new URL("../lib/status-plus-logic.ts", import.meta.url).href)});
			const { resetLabel } = await import(${JSON.stringify(new URL("../lib/status-plus-render.ts", import.meta.url).href)});
			const { usageReport, normalizeGuardConfig } = await import(${JSON.stringify(new URL("../lib/usage-guard-core.ts", import.meta.url).href)});
			const { default: statusPlus } = await import(${JSON.stringify(new URL("../extensions/status-plus.ts", import.meta.url).href)});
			const now = Date.now();
			hhmm(now);
			resetLabel(now + 3_600_000, now);
			const entries = [{ label: "5h", key: "five_hour", windowSeconds: 18000, usedPct: 50, resetMs: now + 3_600_000 }];
			usageReport([["anthropic", { entries, atMs: now, source: "poll" }]], { provider: "anthropic", id: "x" }, normalizeGuardConfig({}), undefined, now);
			const handlers = new Map();
			const ctx = { mode: "print", sessionManager: { getBranch: () => [], getSessionDir: () => "/nonexistent", getSessionFile: () => undefined },
				ui: { setWidget() {}, setStatus() {} } };
			statusPlus({ on: (name, handler) => handlers.set(name, handler) });
			await handlers.get("session_start")({}, ctx);
			await handlers.get("session_shutdown")({}, ctx);
			await handlers.get("session_start")({}, ctx);
			await handlers.get("session_shutdown")({}, ctx);
			console.log("ok");
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			env: { ...process.env, STATUSLINE_TZ: "Not/AZone", PI_CODING_AGENT_DIR: agentDir, STATUS_PLUS_POLL_LIMITS: "0" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /ok/);
		const log = readFileSync(join(agentDir, "status-plus.log"), "utf8");
		assert.equal(log.match(/STATUSLINE_TZ/g)?.length, 1, log);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

// With TZ="" ICU reports Etc/Unknown, a zone no formatter accepts.
test("a system zone no formatter accepts falls back to UTC", () => {
	assert.deepEqual(resolveTimeZone(undefined, "Etc/Unknown"), { timeZone: "UTC", problem: "the system time zone is not a known time zone; times use UTC" });
	assert.equal(resolveTimeZone("Not/AZone", "Etc/Unknown").timeZone, "UTC");
	assert.deepEqual(resolveTimeZone("America/Chicago", "Etc/Unknown"), { timeZone: "America/Chicago" });
	const agentDir = mkdtempSync(join(tmpdir(), "status-tz-"));
	try {
		const script = `
			const { hhmm, STATUS_TIME_ZONE } = await import(${JSON.stringify(new URL("../lib/status-plus-logic.ts", import.meta.url).href)});
			const { localTime } = await import(${JSON.stringify(new URL("../lib/usage-time.ts", import.meta.url).href)});
			const { resetLabel } = await import(${JSON.stringify(new URL("../lib/status-plus-render.ts", import.meta.url).href)});
			const now = Date.now();
			hhmm(now); localTime(now); resetLabel(now + 3_600_000, now);
			console.log(STATUS_TIME_ZONE);
		`;
		const env: NodeJS.ProcessEnv = { ...process.env, TZ: "", PI_CODING_AGENT_DIR: agentDir };
		delete env.STATUSLINE_TZ;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "UTC");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
