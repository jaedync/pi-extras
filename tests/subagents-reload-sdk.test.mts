/**
 * A real parent session reloads with children at work: Pi's own reload, the
 * extension loaded from a copy of this package that the test edits between
 * loads, as an update before /reload does, and Pi's faux provider for every
 * model call. Children wait in bash for a file the test writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-handover-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;

const SECOND_BUILD = "[second build]";
const repo = fileURLToPath(new URL("..", import.meta.url));

/** This package's code, copied so the test can change it under a running session. */
function copyPackage(): { root: string; rebuild(): void } {
	const root = mkdtempSync(join(scratch, "package-"));
	for (const dir of ["lib", "extensions"]) cpSync(join(repo, dir), join(root, dir), { recursive: true, filter: (path) => !path.includes("__pycache__") });
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
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

interface Parent {
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
async function parent(packageRoot: string): Promise<Parent> {
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
		return ai.fauxAssistantMessage(`${name} done on build ${said.includes(SECOND_BUILD) ? 2 : 1}`);
	};
	faux.setResponses(Array.from({ length: 80 }, () => answer));
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(packageRoot, "extensions", "subagents.ts")] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("cheap"),
		scopedModels: [{ model: faux.getModel("cheap") }], settingsManager, resourceLoader: loader,
		sessionManager: sdk.SessionManager.create(scratch, join(scratch, "parents")) });
	const notices: string[] = [];
	await session.bindExtensions({ mode: "print", uiContext: { notify: (text: string) => notices.push(text) } } as never);
	const dir = join(agentDir, "sessions", "subagents", session.sessionManager.getSessionId());
	const record = (name: string) => JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).records.find((r: any) => r.name === name);
	const tool = (name: string) => session.agent.state.tools.find((t: any) => t.name === name);
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

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${what} within ${ms / 1000} s`);
}

const waitingInBash = (p: Parent, name: string) => until(`${name} waits in bash`, () => p.transcript(name).includes('"name":"bash"'));
const reloadWarnings = (p: Parent) => p.notices.filter((notice) => /reload|interrupt/i.test(notice));

test("/reload interrupts no child; new children and the next run of a paused one use the new code; each report reaches main once", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root);
	try {
		p.release("delta");
		await p.spawn("delta", "Finish at once");
		await until("delta finishes", () => p.record("delta")?.state === "idle");
		await p.spawn("alpha", "Work across the reload");
		await waitingInBash(p, "alpha");
		code.rebuild();
		await p.session.reload();
		assert.equal(p.record("alpha")?.state, "running", "the reload interrupts nothing");
		assert.equal(p.record("alpha")?.interruptedBy, undefined);
		// delta's session is still open, but a launch now would use the new code, so its next run relaunches.
		await p.session.agent.state.tools.find((t: any) => t.name === "message").execute("again", { to: "delta", text: "Once more" }, undefined);
		await until("delta's second run", () => p.record("delta")?.report === "delta done on build 2");
		await p.spawn("beta", "Start after the reload");
		await waitingInBash(p, "beta");
		p.release("beta");
		p.release("alpha");
		await until("alpha and beta finish", () => p.record("alpha")?.state === "idle" && p.record("beta")?.state === "idle");
		assert.equal(p.record("alpha")?.report, "alpha done on build 1", "a running child keeps the code it started with");
		assert.equal(p.record("alpha")?.runs, 1);
		assert.equal(p.record("beta")?.report, "beta done on build 2", "a child started after the reload runs the new code");
		await until("every report reaches main", () => ["alpha done", "beta done", "delta done on build 1", "delta done on build 2"].every((text) => p.reports(text) > 0));
		// Quiet now: a team from the new code takes over from the index, which marks what it restored.
		await until("the new code's team takes over", () => ["alpha", "beta", "delta"].every((name) => p.record(name)?.restored === true));
		await p.spawn("gamma", "Start after the new team");
		p.release("gamma");
		await until("gamma finishes", () => p.record("gamma")?.state === "idle");
		assert.equal(p.record("gamma")?.report, "gamma done on build 2");
		await until("gamma's report reaches main", () => p.reports("gamma done") > 0);
		await p.session.agent.state.tools.find((t: any) => t.name === "message").execute("alpha-again", { to: "alpha", text: "Once more" }, undefined);
		await until("alpha's second run, from its file", () => p.record("alpha")?.report === "alpha done on build 2");
		assert.equal(p.record("alpha")?.runs, 2);
		await until("its report reaches main", () => p.reports("alpha done on build 2") > 0);
		for (const text of ["alpha done on build 1", "alpha done on build 2", "beta done", "delta done on build 1", "delta done on build 2", "gamma done"]) assert.equal(p.reports(text), 1, `${text}: reported once`);
		assert.equal(p.session.messages.filter((m: any) => m.customType === "subagent-restore").length, 0, "nothing to announce");
		assert.deepEqual(reloadWarnings(p), []);
	} finally { await p.close(); }
});

test("a second /reload while the adopted team still works hands the same children on again", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const code = copyPackage();
	const p = await parent(code.root);
	try {
		await p.spawn("long", "Work across two reloads");
		await waitingInBash(p, "long");
		await p.session.reload();
		code.rebuild();
		await p.session.reload();
		assert.equal(p.record("long")?.state, "running");
		await p.spawn("late", "Start after both reloads");
		await waitingInBash(p, "late");
		p.release("long");
		p.release("late");
		await until("both finish", () => p.record("long")?.state === "idle" && p.record("late")?.state === "idle");
		assert.equal(p.record("long")?.report, "long done on build 1");
		assert.equal(p.record("late")?.report, "late done on build 2");
		await until("the reports reach main", () => p.reports("long done") > 0 && p.reports("late done") > 0);
		await until("the newest code's team takes over", () => p.record("long")?.restored === true);
		assert.equal(p.reports("long done"), 1);
		assert.equal(p.reports("late done"), 1);
		assert.deepEqual(reloadWarnings(p), []);
	} finally { await p.close(); }
});

/** What the reload before `session_start` left on the shelf for this session. */
const shelf = (p: Parent) => (globalThis as any)[Symbol.for("pi-extras.subagents.host")].parked as WeakMap<object, any>;

test("a parked host of another version is closed with its own code, and its children resume as after a reload before", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("old", "Work when the version changes");
		await waitingInBash(p, "old");
		await p.session.reload({ beforeSessionStart: async () => {
			const parked = shelf(p).get(p.session.sessionManager);
			assert.ok(parked, "the reload parked the host");
			shelf(p).set(p.session.sessionManager, { ...parked, version: parked.version + 1 });
		} });
		const notice = p.session.messages.filter((m: any) => m.customType === "subagent-restore");
		assert.equal(notice.length, 1);
		assert.match(JSON.stringify(notice), /Auto-resuming.*old/);
		assert.match(p.notices.join("\n"), /can't take over/);
		p.release("old");
		await until("old finishes its resumed run", () => p.record("old")?.state === "idle");
		assert.equal(p.record("old")?.runs, 2, "interrupted, then resumed");
	} finally { await p.close(); }
});

test("a takeover that throws closes the parked host with its own code, and its children resume as after a reload before", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	try {
		await p.spawn("fragile", "Work when the takeover fails");
		await waitingInBash(p, "fragile");
		await p.session.reload({ beforeSessionStart: async () => {
			const parked = shelf(p).get(p.session.sessionManager);
			shelf(p).set(p.session.sessionManager, { ...parked, claim: () => ({ ...parked.claim(), rebind() { throw new Error("synthetic takeover failure"); } }) });
		} });
		assert.match(p.notices.join("\n"), /could not take over.*synthetic takeover failure/);
		const notice = p.session.messages.filter((m: any) => m.customType === "subagent-restore");
		assert.equal(notice.length, 1);
		assert.match(JSON.stringify(notice), /Auto-resuming.*fragile/);
		p.release("fragile");
		await until("fragile finishes its resumed run", () => p.record("fragile")?.state === "idle");
		assert.equal(p.record("fragile")?.runs, 2);
	} finally { await p.close(); }
});

test("a shutdown other than a reload interrupts children as before", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root);
	await p.spawn("quitter", "Work when Pi quits");
	await waitingInBash(p, "quitter");
	await p.close();
	assert.equal(p.record("quitter")?.state, "interrupted");
	assert.equal(p.record("quitter")?.interruptedBy, "quit");
	assert.equal(shelf(p).get(p.session.sessionManager), undefined, "nothing is parked");
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
