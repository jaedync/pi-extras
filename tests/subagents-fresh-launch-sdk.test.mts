/** A child launch reads settings.json and models.json as they are now; real SDK sessions, Pi's faux provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		assert.deepEqual([team.get("fresh")?.contextWindow, team.get("fresh")?.compactAt], [50_000, 49_000]);
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
		assert.deepEqual([record.contextWindow, record.compactAt], [70_000, 61_000], "the relaunch replaces the older point");
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

test("a child reads APPEND_SYSTEM.md before its own instructions, and a session stops being current when a context file, SYSTEM.md, APPEND_SYSTEM.md or a skill changes, not an extension file", { timeout: 20_000 }, async () => {
	writeFileSync(join(agentDir, "models.json"), "{}");
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	mkdirSync(join(agentDir, "skills", "demo"), { recursive: true });
	const inputs = {
		context: join(agentDir, "AGENTS.md"),
		system: join(agentDir, "SYSTEM.md"),
		append: join(agentDir, "APPEND_SYSTEM.md"),
		skill: join(agentDir, "skills", "demo", "SKILL.md"),
	};
	writeFileSync(inputs.context, "Be brief.\n");
	writeFileSync(inputs.system, "You help.\n");
	writeFileSync(inputs.append, "Say thanks.\n");
	writeFileSync(inputs.skill, "---\nname: demo\ndescription: A demo skill.\n---\nDo the demo.\n");
	// An extension that owns a tool: Pi's extension cache decides when its code reaches a child, so its file is no input.
	const extension = join(scratch, "owner-extension.ts");
	writeFileSync(extension, "export default function (pi: any) { pi.registerTool({ name: 'owned', label: 'owned', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) }); }\n");
	// What each launch appended to the system prompt.
	const appended: string[][] = [];
	const watched = { ...sdk, createAgentSession: (options: any) => { appended.push(options.resourceLoader.getAppendSystemPrompt()); return sdk.createAgentSession(options); } };
	const launcher = createLauncher({
		sdk: watched as never, agentDir, cwd: scratch, sessionDir: null, generation: 1,
		modelRuntime: async () => runtime,
		toolsFor: () => ({ tools: ["read", "owned"], customTools: [], extensionPaths: [extension] }),
		instructions: () => "You are the subagent.",
	});
	// A file written in the millisecond a launch begins counts as read during it, so each launch starts a little later.
	const launch = async () => (await new Promise((resolve) => setTimeout(resolve, 5)), launcher.launch({ name: "reader", task: "Look", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, state: "starting", runs: 0, depth: 1, startedAt: Date.now() } as never, { onEvent: () => undefined } as never));
	const first = await launch();
	try {
		const stamped = first.stamp!.files.map(([path]) => path);
		for (const path of Object.values(inputs)) assert.ok(stamped.includes(path), `${path} is in the stamp`);
		assert.ok(!stamped.includes(extension), "the extension file is not");
		assert.deepEqual(appended[0]?.map((text) => text.trim()), ["Say thanks.", "You are the subagent."], "APPEND_SYSTEM.md, then the child's instructions");
		writeFileSync(extension, readFileSync(extension, "utf8") + "// edited\n");
		assert.equal(launcher.current!(first), true, "so editing it leaves the session current");
	} finally { await first.dispose(); }
	for (const [input, path] of Object.entries(inputs)) {
		const handle = await launch();
		try {
			assert.equal(launcher.current!(handle), true);
			writeFileSync(path, readFileSync(path, "utf8") + "More.\n");
			assert.equal(launcher.current!(handle), false, `an edited ${input} file makes it stale`);
		} finally { await handle.dispose(); }
	}
});

test("a child in a project of its own reads that project's APPEND_SYSTEM.md only when Pi would trust the project", { timeout: 20_000 }, async () => {
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
	writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Global append.\n");
	const project = mkdtempSync(join(scratch, "project-"));
	mkdirSync(join(project, ".pi"));
	writeFileSync(join(project, ".pi", "APPEND_SYSTEM.md"), "Project append.\n");
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const appended: string[][] = [];
	const watched = { ...sdk, createAgentSession: (options: any) => { appended.push(options.resourceLoader.getAppendSystemPrompt()); return sdk.createAgentSession(options); } };
	const launcher = createLauncher({
		sdk: watched as never, agentDir, cwd: scratch, sessionDir: null, generation: 1,
		modelRuntime: async () => runtime,
		toolsFor: () => ({ tools: ["read"], customTools: [] }),
		instructions: () => "You are the subagent.",
	});
	const launch = async () => {
		const handle = await launcher.launch({ name: "visitor", task: "Look", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, state: "starting", runs: 0, depth: 1, startedAt: Date.now(), cwd: project, checkout: project } as never, { onEvent: () => undefined } as never);
		await handle.dispose();
		return appended.at(-1)?.map((text) => text.trim());
	};
	try {
		assert.deepEqual(await launch(), ["Global append.", "You are the subagent."], "no one trusted the project, and no one is there to ask");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		assert.deepEqual(await launch(), ["Project append.", "You are the subagent."], "a trusted project's file wins, as for main");
	} finally {
		rmSync(join(agentDir, "settings.json"), { force: true });
		rmSync(join(agentDir, "APPEND_SYSTEM.md"), { force: true });
	}
});

test("a child in main's directory follows main's trust in the project: its .pi/ SYSTEM.md, APPEND_SYSTEM.md and shellCommandPrefix apply only when main trusts it", { timeout: 20_000 }, async () => {
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
	const project = mkdtempSync(join(scratch, "main-project-"));
	mkdirSync(join(project, ".pi"));
	writeFileSync(join(project, ".pi", "SYSTEM.md"), "Project system.\n");
	writeFileSync(join(project, ".pi", "APPEND_SYSTEM.md"), "Project append.\n");
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo from-the-repository;" }));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	// What each launch handed Pi: the project files its loader read, and the prefix its bash would run.
	const seen: Array<{ system?: string; append: string[]; prefix?: string }> = [];
	const watched = { ...sdk, createAgentSession: (options: any) => {
		seen.push({ system: options.resourceLoader.getSystemPromptSource()?.path, append: options.resourceLoader.getAppendSystemPromptSources().map((source: { path: string }) => source.path),
			prefix: options.settingsManager.getShellCommandPrefix() });
		return sdk.createAgentSession(options);
	} };
	const launch = async (projectTrusted: boolean) => {
		const launcher = createLauncher({
			sdk: watched as never, agentDir, cwd: project, sessionDir: null, generation: 1, projectTrusted,
			modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: ["read", "bash"], customTools: [] }),
			instructions: () => "You are the subagent.",
		});
		const handle = await launcher.launch({ name: "local", task: "Look", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, state: "starting", runs: 0, depth: 1, startedAt: Date.now() } as never, { onEvent: () => undefined } as never);
		await handle.dispose();
		return seen.at(-1)!;
	};
	const untrusted = await launch(false);
	assert.notEqual(untrusted.system, join(project, ".pi", "SYSTEM.md"), "no project SYSTEM.md");
	assert.ok(!untrusted.append.includes(join(project, ".pi", "APPEND_SYSTEM.md")), "no project APPEND_SYSTEM.md");
	assert.equal(untrusted.prefix, undefined, "no command prefix from the repository in its bash");
	const trusted = await launch(true);
	assert.equal(trusted.system, join(project, ".pi", "SYSTEM.md"));
	assert.deepEqual(trusted.append, [join(project, ".pi", "APPEND_SYSTEM.md")]);
	assert.equal(trusted.prefix, "echo from-the-repository;");
});

test("an overlay for a provider an extension registered from config is checked as main would compose it", { timeout: 20_000 }, async () => {
	const { freshModels, piModelsCheck } = await import("../lib/subagents/fresh-models.ts");
	const e1 = { id: "e1", name: "e1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 };
	const cases: Array<[string, unknown, boolean]> = [
		["an api that does not exist", { providers: { ext: { api: "no-such-api" } } }, false],
		["models with no api of their own", { providers: { ext: { models: [{ id: "e2" }] } } }, false],
		["a good modelOverrides", { providers: { ext: { modelOverrides: { e1: { contextWindow: 5_000 } } } } }, true],
	];
	for (const [label, overlay, good] of cases) {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
		// No base provider in main: only its config, so an overlay that breaks it would take it away.
		runtime.registerProvider("ext", { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [e1] } as never);
		const warnings: string[] = [];
		await freshModels(runtime, join(agentDir, "models.json"), piModelsCheck(sdk, runtime), (message) => warnings.push(message));
		await new Promise((resolve) => setTimeout(resolve, 20));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(overlay));
		await freshModels(runtime, join(agentDir, "models.json"), piModelsCheck(sdk, runtime), (message) => warnings.push(message));
		assert.ok(runtime.getProvider("ext"), `${label}: main keeps the provider`);
		assert.ok(runtime.getModel("ext", "e1"), `${label}: and its model`);
		if (good) {
			assert.deepEqual(warnings, [], `${label}: read`);
			assert.equal(runtime.getModel("ext", "e1")?.contextWindow, 5_000, `${label}: and applied`);
		} else assert.equal(warnings.length, 1, `${label}: told once (${warnings.join(" | ")})`);
	}
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
