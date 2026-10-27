/** A real child session: a lone sleep lends its slot, and one beside another call of the same turn keeps it (bash-rest.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "bash-rest-sdk-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
// One slot, so a second child runs only while the first lends its slot.
writeFileSync(join(agentDir, "pi-extras.json"), JSON.stringify({ subagents: { maxConcurrent: 1 } }));
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;

async function parent() {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "rest-faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/subagents.ts", import.meta.url))] });
	await loader.reload();
	const manager = sdk.SessionManager.create(scratch, join(scratch, "parents"));
	manager.appendMessage(ai.fauxAssistantMessage("Parent fixture."));
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("cheap"),
		scopedModels: [{ model: faux.getModel("cheap") }], settingsManager, resourceLoader: loader, sessionManager: manager });
	await session.bindExtensions({ mode: "print", uiContext: { notify: () => undefined } } as never);
	return { faux, session };
}

const close = async (session: any) => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); };

const recordsOf = (file: string): Array<{ name: string; state: string; activity?: string }> => {
	try { return JSON.parse(readFileSync(file, "utf8")).records; }
	catch { return []; }
};

/** Polls the index until `done` holds or `ms` pass; the last records read. */
async function until(file: string, ms: number, done: (records: ReturnType<typeof recordsOf>) => boolean) {
	let records = recordsOf(file);
	for (const end = Date.now() + ms; Date.now() < end && !done(records);) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		records = recordsOf(file);
	}
	return records;
}

const stateOf = (records: ReturnType<typeof recordsOf>, name: string) => records.find((record) => record.name === name)?.state;

for (const [label, calls, lends] of [
	["a lone sleep lends its slot to the next in line", [{ command: "sleep 20; echo a" }], true],
	["a sleep beside another call of the same turn keeps its slot", [{ command: "sleep 20; echo a" }, { command: "sleep 20; echo b" }], false],
] as const) {
	test(label, { timeout: 30_000 }, async () => {
		const { faux, session } = await parent();
		try {
			faux.setResponses([ai.fauxAssistantMessage(calls.map((args) => ai.fauxToolCall("bash", args))), ai.fauxAssistantMessage("Done.")]);
			const spawn = session.agent.state.tools.find((tool: any) => tool.name === "subagent") as any;
			await spawn.execute("spawn", { name: "sleeper", task: "Wait for CI", model: "rest-faux/cheap" });
			await spawn.execute("spawn", { name: "next", task: "Other work", model: "rest-faux/cheap" });
			const index = join(agentDir, "sessions", "subagents", session.sessionManager.getSessionId(), "index.json");
			const sleeping = await until(index, 10_000, (records) => records.find((record) => record.name === "sleeper")?.activity?.startsWith("bash sleep 20") === true);
			assert.equal(stateOf(sleeping, "sleeper"), "running", JSON.stringify(sleeping));
			const after = await until(index, lends ? 10_000 : 1_500, (records) => stateOf(records, "next") !== "queued");
			assert.equal(stateOf(after, "next") !== "queued", lends, JSON.stringify(after));
		} finally { await close(session); }
	});
}

test.after(() => rmSync(scratch, { recursive: true, force: true }));
