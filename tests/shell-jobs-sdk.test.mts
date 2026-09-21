/** Exercise the installed SDK's real reload, loader, stale-context guards and history. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";

import { agentRoot } from './support/pi-runtime.mjs';
const scratch = mkdtempSync(join(tmpdir(), "shell-jobs-sdk-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");

async function execute(session: AgentSession, name: string, params: unknown) {
	const tool = session.agent.state.tools.find((entry) => entry.name === name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("test-call", params) as { details: Record<string, any>; content: Array<{ text: string }> };
}

test("SDK reload retains running groups and delivers a gap completion through the fresh runner", { timeout: 20_000 }, async () => {
	const errors: ExtensionError[] = [];
	const settingsManager = sdk.SettingsManager.inMemory();
	const loader = new sdk.DefaultResourceLoader({
		cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/shell-jobs.ts", import.meta.url))],
	});
	let session: AgentSession | undefined;
	const pids = new Set<number>();
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await sdk.createAgentSession({
			cwd: scratch, agentDir,
			resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(scratch),
		}));
		// Keep real message ingestion/history/events, but do not start a model turn.
		const send = session.sendCustomMessage.bind(session);
		session.sendCustomMessage = (message, options) => send(message, { ...options, triggerTurn: false });
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		const running = await execute(session, "shell_job_start", { command: "echo continuous; sleep 30" });
		pids.add(running.details.pid);
		const oldRunner = session.extensionRunner;
		const identity = oldRunner.createContext().sessionManager;
		await session.reload();
		assert.notEqual(session.extensionRunner, oldRunner);
		assert.equal(session.extensionRunner.createContext().sessionManager, identity);
		assert.throws(() => oldRunner.createContext().sessionManager, /stale|invalid|reload/i);
		assert.doesNotThrow(() => process.kill(-running.details.pid, 0));
		assert.ok(existsSync(running.details.logPath));
		assert.equal((await execute(session, "shell_job", { op: "list" })).details.jobs.length, 1);

		const release = join(scratch, "release");
		const completed = await execute(session, "shell_job_start", {
			command: `while [ ! -f '${release}' ]; do sleep 0.02; done; echo gap-complete`,
		});
		pids.add(completed.details.pid);
		assert.equal(completed.details.id, "j2");
		// The SDK has invalidated the old API but has not emitted session_start yet.
		await session.reload({ beforeSessionStart: async () => {
			writeFileSync(release, "");
			await sleep(200);
		} });
		const completions = () => session!.sessionManager.getBranch().filter((entry) =>
			entry.type === "custom_message" && entry.customType === "shell-job-complete");
		assert.equal(completions().length, 1);
		assert.match(JSON.stringify(completions()), /gap-complete/);
		await session.reload();
		assert.equal(completions().length, 1);
		assert.doesNotThrow(() => process.kill(-running.details.pid, 0));
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.throws(() => process.kill(-running.details.pid, 0));
		assert.equal(existsSync(running.details.logPath), false);
		assert.deepEqual(errors, []);
	} finally {
		await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		for (const pid of pids) {
			try { process.kill(-pid, "SIGKILL"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		rmSync(scratch, { recursive: true, force: true });
	}
});
