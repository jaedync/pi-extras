/** Auto-pull in Pi's real session: the pulled links reach the model's first request; a subagent's task gets none. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "link-auto-sdk-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });

// The only network: one fake site. Anything else fails the test's reads, never reaches a real host.
const fetched: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = String(input instanceof Request ? input.url : input);
	fetched.push(url);
	if (!url.startsWith("https://e.test/")) throw new Error(`No real network in this test: ${url}`);
	return new Response(`<title>Fixture page</title><article><p>The secret word is marmalade (${url}).</p></article>`, { headers: { "content-type": "text/html" } });
}) as typeof fetch;

const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { default: linkContext } = await import("../extensions/link-context.ts");
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");
const { childInstructions } = await import("../lib/subagents/format.ts");

const textOf = (message: any): string => typeof message.content === "string" ? message.content : (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");

async function fixture(provider: string) {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
	const faux = ai.fauxProvider({ provider, models: [{ id: "model" }] });
	runtime.registerNativeProvider(faux.provider);
	const requests: any[][] = [];
	faux.setResponses([(context: any) => { requests.push(structuredClone(context.messages)); return ai.fauxAssistantMessage("I read it."); }]);
	return { runtime, faux, requests };
}

test("real SDK: a typed prompt with a link reaches the model with the pulled text, and no pull_link call is needed", { timeout: 15_000 }, async () => {
	const { runtime, faux, requests } = await fixture("auto-pull-fixture");
	const cwd = mkdtempSync(join(scratch, "main-"));
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [linkContext] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd) });
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "tui", uiContext: { notify: () => {} }, onError: (error: unknown) => errors.push(error) });
	try {
		await session.prompt("What is the secret word on https://e.test/post?");
		assert.deepEqual(errors, []);
		assert.equal(faux.state.callCount, 1, "one model request answers: no pull_link turn");
		const first = requests[0];
		const userAt = first.findIndex((message: any) => message.role === "user" && textOf(message).includes("What is the secret word"));
		assert.ok(userAt >= 0);
		const pulled = first[userAt + 1];
		assert.ok(pulled, "the pulled links follow the user's message in the first request");
		assert.match(textOf(pulled), /Pull Link read 1 link from the user's message automatically/);
		assert.match(textOf(pulled), /<untrusted-content source="https:\/\/e\.test\/post">[\s\S]*marmalade/);
		const custom = session.messages.find((message: any) => message.role === "custom");
		assert.equal(custom?.customType, "pull-link-auto");
		assert.equal(custom?.details.links[0].state, "read");
		assert.ok(!session.messages.some((message: any) => message.role === "toolResult"), "no tool ran");
		assert.deepEqual(fetched, ["https://e.test/post"]);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

for (const behavior of ["steer", "followUp"]) test(`real SDK: a ${behavior} with a link reaches the model's next request with it, in the same turn`, { timeout: 15_000 }, async () => {
	const { runtime, faux, requests } = await fixture(`auto-pull-${behavior}-fixture`);
	let open!: () => void;
	const gate = new Promise<void>((resolve) => { open = resolve; });
	faux.setResponses([
		async (context: any) => { requests.push(structuredClone(context.messages)); await gate; return ai.fauxAssistantMessage("First answer."); },
		(context: any) => { requests.push(structuredClone(context.messages)); return ai.fauxAssistantMessage("Steered answer."); },
	]);
	const cwd = mkdtempSync(join(scratch, "steer-"));
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [linkContext] });
	await loader.reload();
	const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd) });
	await session.bindExtensions({ mode: "tui", uiContext: { notify: () => {} } });
	try {
		const run = session.prompt("Start some work.");
		while (requests.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
		await session.prompt("Also read https://e.test/steer", { streamingBehavior: behavior });
		// The read is local and fast; give it time to finish while the first turn still runs.
		await new Promise((resolve) => setTimeout(resolve, 100));
		open();
		await run;
		assert.equal(requests.length, 2, "no turn of its own for the pulled text");
		const second = requests[1];
		const steerAt = second.findIndex((message: any) => message.role === "user" && textOf(message).includes("Also read"));
		assert.equal(steerAt, second.length - 1, "the queued message is the last message before the model's reply");
		// Pi adds a context message at the end of the current turn, which comes before the queued message.
		assert.match(textOf(second[steerAt - 1]), /Pull Link read 1 link[\s\S]*marmalade/);
		assert.equal(second[steerAt - 2].role, "assistant");
		assert.ok(session.messages.some((message: any) => message.customType === "pull-link-auto"));
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("real SDK: a subagent's task with a link is not auto-pulled, even with pull_link loaded", { timeout: 15_000 }, async () => {
	const { runtime, requests } = await fixture("auto-pull-child-fixture");
	fetched.length = 0;
	const errors: unknown[] = [];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => {},
		launcher: createLauncher({ sdk, agentDir, cwd: scratch, sessionDir: null, modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: ["pull_link"], customTools: [], extensionPaths: [fileURLToPath(new URL("../extensions/link-context.ts", import.meta.url))] }),
			instructions: (record: any) => childInstructions({ name: record.name, parent: record.parent, readOnly: false, canSpawn: false, roster: "" }),
			onExtensionError: (error: unknown) => errors.push(error),
		}),
	});
	try {
		assert.equal(team.spawn({ name: "reader", task: "Summarize https://e.test/child-task", parent: "main", model: "auto-pull-child-fixture/model", readOnly: false, fork: false, blocking: false }).ok, true);
		const done = await team.whenDone("reader");
		assert.equal(done.state, "idle", String(done.error ?? done.state));
		assert.match(done.report ?? "", /I read it/);
		assert.deepEqual(errors, []);
		const first = requests[0];
		assert.ok(first.some((message: any) => textOf(message).includes("https://e.test/child-task")), "the task reached the child");
		assert.ok(!first.some((message: any) => /Pull Link read/.test(textOf(message))));
		assert.deepEqual(fetched, []);
	} finally { await team.close(); }
});

test.after(() => {
	globalThis.fetch = originalFetch;
	rmSync(scratch, { recursive: true, force: true });
});
