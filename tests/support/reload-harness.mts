/**
 * A real parent session for the /reload tests (subagents-reload-*.test.mts):
 * Pi's own reload, the extension loaded from a copy of this package that a
 * test edits between loads, as an update before /reload does, and Pi's faux
 * provider for every model call. Children wait in bash for a file the test
 * writes. Each test file is its own process with its own scratch home, so
 * the files run side by side.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot } from "./pi-runtime.mjs";

export const scratch = mkdtempSync(join(tmpdir(), "subagents-handover-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
export const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
export const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;

export const SECOND_BUILD = "[second build]";
const repo = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Where a test holds the copied code still: a child's launch before it picks
 * its model, and an old team's retire before it lets its sessions go.
 */
const GATES = {
	launch: { file: join("lib", "subagents", "child.ts"), at: "const { modelRuntime, model } = await childModel(deps, record);", key: "pi-extras.test.launch-gate", with: "record.name" },
	retire: { file: join("lib", "subagents", "host-state.ts"), at: 'await this.team.close("reload", this.inputs.owner);', key: "pi-extras.test.retire-gate", with: "" },
} as const;

/** Holds the copied code at `gate` until `open` is called; `held` says whether anything waits there now. */
export function hold(gate: keyof typeof GATES, only?: string) {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => { open = resolve; });
	let held = 0;
	(globalThis as any)[Symbol.for(GATES[gate].key)] = async (name?: string) => {
		if (only !== undefined && name !== only) return;
		held++;
		await opened;
		held--;
	};
	return { open, held: () => held > 0, done: () => { delete (globalThis as any)[Symbol.for(GATES[gate].key)]; } };
}

/** This package's code, copied so the test can change it under a running session. */
export function copyPackage(): { root: string; rebuild(): void } {
	const root = mkdtempSync(join(scratch, "package-"));
	for (const dir of ["lib", "extensions"]) cpSync(join(repo, dir), join(root, dir), { recursive: true, filter: (path) => !path.includes("__pycache__") });
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
	for (const gate of Object.values(GATES)) {
		const file = join(root, gate.file);
		const source = readFileSync(file, "utf8");
		const gated = source.replace(gate.at, `await (globalThis as any)[Symbol.for(${JSON.stringify(gate.key)})]?.(${gate.with}); ${gate.at}`);
		assert.notEqual(gated, source, `the copy's ${gate.file} has a gate`);
		writeFileSync(file, gated);
	}
	const format = join(root, "lib", "subagents", "format.ts");
	return {
		root,
		rebuild() {
			const source = readFileSync(format, "utf8");
			const changed = source.replace('`# You are the subagent "${name}"`', `\`# You are the subagent "\${name}" ${SECOND_BUILD}\``);
			assert.notEqual(changed, source, "the copy's child instructions changed");
			writeFileSync(format, changed);
		},
	};
}

export interface Parent {
	session: any;
	notices: string[];
	flags: string;
	record(name: string): any;
	transcript(name: string): string;
	reports(text: string): number;
	release(name: string): void;
	spawn(name: string, task: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * The parent and its children share the faux queue in whatever order they ask.
 * A child first waits in bash for its flag, then reports which build of the
 * instructions it was launched with; main only reads what arrives.
 */
export async function parent(packageRoot: string, where: { cwd?: string; trusted?: boolean } = {}): Promise<Parent> {
	const cwd = where.cwd ?? scratch;
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const flags = mkdtempSync(join(scratch, "flags-"));
	const answer = (context: any) => {
		const said = JSON.stringify(context);
		const name = said.match(/You are the subagent \\"([a-z0-9-]+)\\"/)?.[1];
		if (!name) return ai.fauxAssistantMessage("Main read it.");
		if (context.messages.at(-1)?.role !== "toolResult") {
			return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `until [ -f ${join(flags, name)} ]; do sleep 0.05; done; echo released` }));
		}
		// What a child got from a project's .pi/ shows in its report, for the tests that set one up.
		const project = ["PROJECT-SYSTEM", "PROJECT-APPEND", "PROJECT-PREFIX"].filter((marker) => said.includes(`${marker}-SEEN`));
		return ai.fauxAssistantMessage(`${name} done on build ${said.includes(SECOND_BUILD) ? 2 : 1}${project.length ? ` with ${project.join(", ")}` : ""}`);
	};
	faux.setResponses(Array.from({ length: 80 }, () => answer));
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: where.trusted ?? true });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(packageRoot, "extensions", "subagents.ts")] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel("cheap"),
		scopedModels: [{ model: faux.getModel("cheap") }], settingsManager, resourceLoader: loader,
		sessionManager: sdk.SessionManager.create(cwd, join(scratch, "parents")) });
	const notices: string[] = [];
	await session.bindExtensions({ mode: "print", uiContext: { notify: (text: string) => notices.push(text) } } as never);
	const dir = join(agentDir, "sessions", "subagents", session.sessionManager.getSessionId());
	const record = (name: string) => JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).records.find((r: any) => r.name === name);
	const tool = (name: string) => session.agent.state.tools.find((t: any) => t.name === name)!;
	return {
		session, notices, flags, record,
		transcript: (name) => { const file = record(name)?.sessionFile; return file && existsSync(file) ? readFileSync(file, "utf8") : ""; },
		reports: (text) => session.messages.filter((m: any) => m.role === "custom" && m.customType === "subagent-report" && JSON.stringify(m.details).includes(text)).length,
		release: (name) => writeFileSync(join(flags, name), ""),
		async spawn(name, task) { await tool("subagent").execute(`spawn-${name}`, { name, task, model: "faux/cheap" }, undefined); },
		async close() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
	};
}

export async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${what} within ${ms / 1000} s`);
}

export const waitingInBash = (p: Parent, name: string) => until(`${name} waits in bash`, () => p.transcript(name).includes('"name":"bash"'));
export const reloadWarnings = (p: Parent) => p.notices.filter((notice) => /reload|interrupt/i.test(notice));

/** What a reload leaves for the next module, by session (host.ts). */
export const shelf = () => (globalThis as any)[Symbol.for("pi-extras.subagents.host")].parked as WeakMap<object, any>;

/** Lets `name` finish while Pi reloads, before the next module starts, and checks its report waits. */
export async function finishWhileParked(p: Parent, name: string): Promise<void> {
	p.release(name);
	await until(`${name} finishes while parked`, () => p.record(name)?.state === "idle");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(p.reports(`${name} done`), 0, "nothing reaches main while parked");
}

/** A repository whose .pi/ would show in a child's report: its system prompt files and a bash command prefix. */
export function projectWithPi(): string {
	const project = mkdtempSync(join(scratch, "repository-"));
	mkdirSync(join(project, ".pi"));
	writeFileSync(join(project, ".pi", "SYSTEM.md"), "PROJECT-SYSTEM-SEEN\n");
	writeFileSync(join(project, ".pi", "APPEND_SYSTEM.md"), "PROJECT-APPEND-SEEN\n");
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo PROJECT-PREFIX-SEEN;" }));
	return project;
}

/** Removes this process's scratch home; each test file calls it once its tests are done. */
export const removeScratch = (): void => rmSync(scratch, { recursive: true, force: true });
