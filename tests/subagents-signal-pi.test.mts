/** Exercise Pi's pinned interactive registerSignalHandlers and shutdown, not a replacement host handler. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

test("Pi's real interactive SIGHUP path records before disposal finishes and exits normally", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-signal-path-"));
	const file = join(dir, "events.json");
	const piModule = pathToFileURL(join(agentRoot, "dist/modes/interactive/interactive-mode.js")).href;
	const recorder = new URL("../lib/subagents/signals.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { writeFileSync } from "node:fs";
		import { InteractiveMode } from ${JSON.stringify(piModule)};
		import { installSignalRecorder } from ${JSON.stringify(recorder)};
		const events = [];
		const host = Object.create(InteractiveMode.prototype);
		host.signalCleanupHandlers = [];
		host.isShuttingDown = false;
		host.runtimeHost = { async dispose() { events.push("dispose:start"); await Promise.resolve(); events.push("dispose:end"); } };
		host.themeController = { disableAutoSync() {} };
		host.ui = { terminal: { async drainInput() {} } };
		host.stop = () => { events.push("terminal:stop"); writeFileSync(${JSON.stringify(file)}, JSON.stringify(events)); };
		host.registerSignalHandlers();
		installSignalRecorder((signal) => events.push("record:" + signal));
		console.log("ready"); setInterval(() => {}, 1000);
	`], { env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr += data; });
	try {
		await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => assert.fail(stderr))]);
		const exited = once(child, "exit");
		child.kill("SIGHUP");
		const [code, signal] = await exited;
		assert.equal(code, 0, stderr);
		assert.equal(signal, null);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["record:SIGHUP", "dispose:start", "dispose:end", "terminal:stop"]);
	} finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});
