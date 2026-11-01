/**
 * The model scope in a real parent session: /scoped-models changes it at once
 * (Pi's `setScopedModels`, as the selector calls it), and a /reload after an
 * `enabledModels` edit allows the new model though Pi keeps its old list.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, ai, removeScratch, scratch, sdk } from "./support/reload-harness.mts";

after(removeScratch);
const extension = fileURLToPath(new URL("../extensions/subagents.ts", import.meta.url));

function settings(enabledModels: string[]): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels }));
}

/** A parent on faux/cheap whose session scope is what Pi's start resolved from `enabledModels`: faux/cheap only. */
async function parent() {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }, { id: "other", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	faux.setResponses(Array.from({ length: 20 }, () => ai.fauxAssistantMessage("done")));
	const settingsManager = sdk.SettingsManager.create(scratch, agentDir);
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [extension] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("cheap"),
		scopedModels: [{ model: faux.getModel("cheap") }], settingsManager, resourceLoader: loader,
		sessionManager: sdk.SessionManager.create(scratch, join(scratch, "parents")) });
	const notices: string[] = [];
	await session.bindExtensions({ mode: "print", uiContext: { notify: (text: string) => notices.push(text) } } as never);
	const tool = (name: string) => (session as any).agent.state.tools.find((t: any) => t.name === name)!;
	const spawn = (model: string) => tool("subagent").execute(`spawn-${model}`, { task: "Say done.", model }, undefined);
	return { session, faux, notices, tool, spawn, close: async () => {
		await (session as any).extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	} };
}

test("/scoped-models allows a model at once, and the next prompt's tool description lists it", { timeout: 30_000 }, async () => {
	settings(["faux/cheap"]);
	const p = await parent();
	try {
		await assert.rejects(p.spawn("faux/other"),
			/"faux\/other" is not one of the allowed models: faux\/cheap\. faux\/other is not in this session's model scope\. Enable it with \/scoped-models, or add it to enabledModels in settings\.json and run \/reload\./);
		assert.doesNotMatch(p.tool("subagent").description, /faux\/other/);
		p.session.setScopedModels([{ model: p.faux.getModel("cheap") }, { model: p.faux.getModel("other") }]);
		const started = await p.spawn("faux/other");
		assert.match(started.content[0].text, /Started .* on faux\/other/);
		await p.session.prompt("Hello");
		assert.match(p.tool("subagent").description, /- faux\/other/, "registered again before the prompt");
	} finally { await p.close(); }
});

test("a /reload after an enabledModels edit allows the new model, while Pi keeps its old session scope", { timeout: 30_000 }, async () => {
	settings(["faux/cheap"]);
	const p = await parent();
	try {
		settings(["faux/cheap", "faux/other"]);
		await p.session.reload();
		assert.deepEqual(p.session.scopedModels.map((entry: any) => entry.model.id), ["cheap"], "Pi 1.4.0 does not resolve enabledModels again on reload");
		const started = await p.spawn("faux/other");
		assert.match(started.content[0].text, /Started .* on faux\/other/);
		assert.match(p.tool("subagent").description, /- faux\/other/);
		assert.deepEqual(p.notices.filter((notice) => /enabledModels/.test(notice)), []);
	} finally { await p.close(); }
});
