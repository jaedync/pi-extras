/** Load Tool Display into the installed SDK and check the agent sees exactly the tools it saw before. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";

import { agentRoot } from "./support/pi-runtime.mjs";
const scratch = mkdtempSync(join(tmpdir(), "tool-display-sdk-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");

const BUILT_INS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function snapshot(session: AgentSession) {
	return {
		active: session.getActiveToolNames(),
		prompt: session.systemPrompt,
		tools: BUILT_INS.map((name) => {
			const definition = session.getToolDefinition(name);
			return definition && {
				name: definition.name,
				description: definition.description,
				parameters: JSON.stringify(definition.parameters),
				promptSnippet: definition.promptSnippet,
				promptGuidelines: definition.promptGuidelines,
			};
		}),
	};
}

async function start(mode: "tui" | "print") {
	const errors: ExtensionError[] = [];
	const settingsManager = sdk.SettingsManager.inMemory();
	const loader = new sdk.DefaultResourceLoader({
		cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/tool-display.ts", import.meta.url))],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({
		cwd: scratch, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(scratch),
	});
	const before = snapshot(session);
	await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
	return { session, before, errors };
}

test("in the terminal UI the built-in tools gain the new rows and nothing the agent sees changes", { timeout: 20_000 }, async () => {
	const { session, before, errors } = await start("tui");
	try {
		assert.deepEqual(errors, []);
		assert.deepEqual(snapshot(session), before);
		// grep, find and ls stay off, as they were.
		assert.deepEqual(session.getActiveToolNames().filter((name) => ["grep", "find", "ls"].includes(name)), []);
		for (const name of BUILT_INS) assert.equal(session.getToolDefinition(name)?.renderShell, "self", name);
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
		assert.ok(bash);
		const result = await bash.execute("call-1", { command: "printf hello" }) as { content: Array<{ text: string }> };
		assert.equal(result.content[0]?.text, "hello");
		// A chained command runs step by step, and Pi's bash tool returns exactly what the command wrote.
		const chained = await bash.execute("call-2", { command: "printf 'a\\n' && printf 'b\\n' ; printf c" }) as { content: Array<{ text: string }> };
		assert.equal(chained.content[0]?.text, "a\nb\nc");
		// A failure reads the same as the one-step command (a subshell isn't split) would.
		const failure = (command: string) => bash.execute("call-3", { command }).then(() => "resolved", (error: Error) => error.message);
		assert.equal(await failure("echo x && (exit 4) && echo never"), await failure("(echo x; exit 4)"));
	} finally {
		session.dispose();
	}
});

test("outside the terminal UI Pi's own tools stay in place", { timeout: 20_000 }, async () => {
	const { session, before, errors } = await start("print");
	try {
		assert.deepEqual(errors, []);
		assert.deepEqual(snapshot(session), before);
		assert.equal(session.getToolDefinition("bash")?.renderShell, undefined);
	} finally {
		session.dispose();
	}
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
