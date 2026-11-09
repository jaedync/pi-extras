/**
 * Live repro of finding F1 (formal/subagents-mail/README.md), in Pi's real
 * AgentSession with its faux provider and the real MainMail and watchMain,
 * wired as tests/subagents-main-mail-sdk.test.mts wires them.
 *
 * Bug path: main is idle. A child's note wakes main (it starts a run). The
 * user runs /compact while main still works on that turn. Compaction stops
 * the turn. Then nothing wakes main for the note: no reminder, no turn.
 *
 *   node formal/subagents-mail/repro-f1.mts            # the bug path
 *   node formal/subagents-mail/repro-f1.mts --control  # the note lands during a user turn instead
 *
 * It prints the requests the faux model saw and the transcript.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "main-mail-sdk-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const { MainMail } = await import("../../lib/subagents/deliver.ts");
const { watchMain } = await import("../../lib/subagents/main-watch.ts");

const NOTE = "NOTE-FROM-SCAN-1";

interface Requests {
	seen: string[];
	gate: Promise<void>;
	release(): void;
	holdTurn?: Promise<void>;
	/** The next turn calls slow_tool instead of answering. */
	toolTurn?: boolean;
}

function requests(): Requests {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	return { seen: [], gate, release };
}

/** Answers every request: summaries wait for the gate, turns answer, and each records whether it saw the note. */
function steps(state: Requests, filler = "") {
	const step = async (context: any) => {
		const text = JSON.stringify(context.messages);
		const summary = /^\[\{"type":"text","text":"(<conversation>|# Conversation)/.test(JSON.stringify(context.messages.at(-1)?.content ?? ""));
		const reminded = /was stopped before you replied/.test(JSON.stringify(context.messages.at(-1)?.content ?? ""));
		state.seen.push(`${summary ? "summary" : "turn"}${text.includes(NOTE) ? " (sees note)" : ""}${reminded ? " (reminded)" : ""}`);
		if (summary) {
			await state.gate;
			return ai.fauxAssistantMessage("## Summary\nEarlier work.");
		}
		if (state.toolTurn) {
			state.toolTurn = false;
			return ai.fauxAssistantMessage(ai.fauxToolCall("slow_tool", {}));
		}
		const hold = state.holdTurn;
		state.holdTurn = undefined;
		await hold;
		return ai.fauxAssistantMessage(text.includes(NOTE) ? `Got the note.${filler}` : `Answer.${filler}`);
	};
	return Array.from({ length: 20 }, () => step);
}

interface Options {
	contextWindow?: number;
	compaction?: object;
	filler?: string;
	/** More of another extension's handlers, registered after the mail's own. */
	more?: (pi: any, note: () => void) => void;
}

async function setup(state: Requests, options: Options = {}) {
	const box: { mail?: InstanceType<typeof MainMail> } = {};
	const note = () => box.mail!.deliver({ kind: "note", from: "scan-1", text: NOTE });
	// The extension's wiring, without the team: main's mail and where main is.
	const extension = (pi: any) => {
		const watch = watchMain(pi, () => box.mail);
		options.more?.(pi, note);
		pi.on("session_start", async (_event: unknown, ctx: any) => {
			box.mail?.dispose();
			box.mail = new MainMail({ batchMs: 0, retryMs: 20, port: { send: (message, sendOptions) => pi.sendMessage(message, sendOptions) }, route: () => watch.route(ctx) });
		});
	};
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: options.contextWindow ?? 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	faux.setResponses(steps(state, options.filler));
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: options.compaction ?? { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
	await loader.reload();
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "m"),
		settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
	await session.bindExtensions({ mode: "print", uiContext: { notify: () => undefined } });
	return { session, note, close: () => { box.mail?.dispose(); session.dispose(); } };
}

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 500 && !check(); i++) await sleep(20);
	assert.ok(check(), `timed out waiting for ${what}`);
}

/** The branch as a readable trail, and whether the note is in what main sends next. */
function transcript(session: any): string {
	return session.sessionManager.getBranch()
		.map((entry: any) => entry.type === "compaction" ? "COMPACTION" : entry.type === "custom_message" ? "note" : entry.type === "message" ? entry.message.role : undefined)
		.filter(Boolean).join(" > ");
}


const control = process.argv.includes("--control");
const state = requests();
const { session, note, close } = await setup(state);
try {
	for (const text of ["one", "two"]) await session.prompt(text);
	state.seen.length = 0;
	state.holdTurn = new Promise<void>((resolve) => { setTimeout(resolve, 300); });
	let run: Promise<unknown>;
	if (control) {
		// The note lands while a user turn works: it is sent without a turn and kept as owed.
		run = session.prompt("three").catch(() => undefined);
		await until(() => state.seen.length === 1, "main's turn");
		note();
	} else {
		// Main is idle: the note starts the turn itself.
		note();
		await until(() => state.seen.length === 1, "the turn the note started");
		run = session.waitForIdle();
	}
	// /compact while that turn works: Pi stops it first (agent-session.js:2230-2232).
	const compacting = session.compact();
	await until(() => state.seen.includes("summary"), "the summary request");
	state.release();
	await Promise.all([run, compacting]);
	await sleep(1_000);
	await session.waitForIdle();
	const reminded = state.seen.some((request) => request.endsWith("(reminded)"));
	const after = state.seen.slice(state.seen.indexOf("summary") + 1);
	console.log(JSON.stringify({ path: control ? "control: note during a user turn" : "bug: note started the turn", seen: state.seen, turnsAfterCompaction: after.length, reminded, transcript: transcript(session) }, null, 2));
	process.exitCode = reminded ? 0 : 1;
} finally {
	close();
}
