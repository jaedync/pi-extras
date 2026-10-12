/** A child launch reads settings.json and models.json as they are now; real SDK sessions, Pi's faux provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-fresh-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");
const { childMessageTool } = await import("../lib/subagents/tools.ts");

const settings = (reserveTokens: number) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens } }));
const models = (contextWindow: number) => writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { faux: { modelOverrides: { cheap: { contextWindow } } } } }));
const wait = async (condition: () => boolean) => {
	for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(condition(), "condition did not become true within 5s");
};

test("an edited reserveTokens and contextWindow reach a new launch, and a resume that would reuse the open session relaunches", { timeout: 20_000 }, async () => {
	settings(1_000);
	models(50_000);
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	// What each launch handed Pi: its settings and its model.
	const launched: Array<{ reserveTokens: number; contextWindow: number }> = [];
	const watched = {
		...sdk,
		createAgentSession: (options: any) => {
			launched.push({ reserveTokens: options.settingsManager.getCompactionSettings(options.model).reserveTokens, contextWindow: options.model.contextWindow });
			return sdk.createAgentSession(options);
		},
	};
	let tools: any;
	const team = new Team({
		maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 5_000,
		deliverToMain: () => undefined,
		sessionFileFor: (name) => join(agentDir, "sessions", "subagents", "parent-fresh", `${name}.jsonl`),
		launcher: createLauncher({
			sdk: watched as never, agentDir, cwd: scratch, sessionDir: join(agentDir, "sessions", "subagents", "parent-fresh"), generation: 1,
			modelRuntime: async () => runtime,
			toolsFor: (record) => ({ tools: ["read"], customTools: [childMessageTool(tools, record.name)] }),
			instructions: () => "",
		}),
	});
	tools = { team, replyTimeoutMs: 5_000 };
	try {
		faux.setResponses([ai.fauxAssistantMessage("First."), ai.fauxAssistantMessage("Follow-up on the same session."), ai.fauxAssistantMessage("Relaunched."), ai.fauxAssistantMessage("New child.")]);
		assert.ok(team.spawn({ name: "fresh", task: "Look", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
		await team.whenDone("fresh");
		assert.deepEqual(launched, [{ reserveTokens: 1_000, contextWindow: 50_000 }], "the first launch reads both files");
		assert.equal(team.get("fresh")?.contextWindow, 50_000);
		await team.send("main", "fresh", "Again.");
		await wait(() => team.get("fresh")?.runs === 2 && team.get("fresh")?.state === "idle");
		assert.equal(launched.length, 1, "nothing changed, so the open session is reused");
		settings(9_000);
		models(70_000);
		await team.send("main", "fresh", "Once more.");
		await wait(() => team.get("fresh")?.runs === 3 && team.get("fresh")?.state === "idle");
		assert.deepEqual(launched.at(-1), { reserveTokens: 9_000, contextWindow: 70_000 }, "the resume relaunched on the edited files");
		const record = team.get("fresh")!;
		assert.equal(record.report, "Relaunched.");
		assert.equal(record.contextWindow, 70_000);
		assert.equal(runtime.getModel("faux", "cheap")?.contextWindow, 70_000, "main's runtime reads the edit too, as /model would");
		settings(4_000);
		assert.ok(team.spawn({ name: "second", task: "Look too", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
		await team.whenDone("second");
		assert.deepEqual(launched.at(-1), { reserveTokens: 4_000, contextWindow: 70_000 }, "a new child reads the files as they are now");
	} finally {
		await team.close();
	}
});

test("a models.json that parses but fails Pi's schema is not read into main's runtime: its custom provider stays, and the user is told once", { timeout: 20_000 }, async () => {
	const mine = { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "m1" }] };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mine } }));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	assert.ok(runtime.getModel("mine", "m1"), "main starts with its custom model");
	const warnings: string[] = [];
	const team = new Team({
		maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 5_000,
		deliverToMain: () => undefined,
		sessionFileFor: (name) => join(agentDir, "sessions", "subagents", "parent-schema", `${name}.jsonl`),
		launcher: createLauncher({
			sdk, agentDir, cwd: scratch, sessionDir: join(agentDir, "sessions", "subagents", "parent-schema"), generation: 1,
			modelRuntime: async () => runtime,
			warn: (message) => warnings.push(message),
			toolsFor: () => ({ tools: ["read"], customTools: [] }),
			instructions: () => "",
		}),
	});
	try {
		faux.setResponses([ai.fauxAssistantMessage("One."), ai.fauxAssistantMessage("Two."), ai.fauxAssistantMessage("Three.")]);
		assert.ok(team.spawn({ name: "one", task: "Look", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
		await team.whenDone("one");
		// A save in the middle of an edit: valid JSON that Pi's schema refuses, which Pi would load as no custom models at all.
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mine: { baseUrl: 42 } } }));
		for (const name of ["two", "three"]) {
			assert.ok(team.spawn({ name, task: "Look", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
			await team.whenDone(name);
			assert.equal(team.get(name)?.state, "idle");
		}
		assert.ok(runtime.getModel("mine", "m1"), "main keeps its custom model");
		assert.ok(runtime.getProvider("mine"), "and its custom provider");
		assert.equal(warnings.length, 1, warnings.join("\n"));
		assert.match(warnings[0]!, /models\.json.*schema/s);
	} finally {
		await team.close();
	}
});

test("a models.json that adds a model to a provider an extension registered is read, though Pi's loader alone can't place it", { timeout: 20_000 }, async () => {
	writeFileSync(join(agentDir, "models.json"), "{}");
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const warnings: string[] = [];
	const launcher = createLauncher({
		sdk, agentDir, cwd: scratch, sessionDir: null, generation: 1,
		modelRuntime: async () => runtime,
		warn: (message) => warnings.push(message),
		toolsFor: () => ({ tools: ["read"], customTools: [] }),
		instructions: () => "",
	});
	// The api and baseUrl come from the registered provider, which a check of the file alone does not have.
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { faux: { models: [{ id: "extra" }] } } }));
	const record = { name: "extra", task: "Look", parent: "main", model: "faux/extra", readOnly: false, fork: false, blocking: false, state: "starting", runs: 0, depth: 1, startedAt: Date.now() };
	faux.setResponses([ai.fauxAssistantMessage("Seen.")]);
	const handle = await launcher.launch(record as never, { onEvent: () => undefined } as never);
	try {
		assert.ok(runtime.getModel("faux", "extra"), "main's runtime has the added model");
		assert.deepEqual(warnings, []);
	} finally { await handle.dispose(); }
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
