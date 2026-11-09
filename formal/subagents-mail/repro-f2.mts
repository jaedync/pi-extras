/**
 * Live repro of finding F2 (formal/subagents-mail/README.md), in Pi's real
 * AgentSession with its faux provider and the real MainMail and watchMain.
 *
 * Path: a note lands while main works on a user turn, so main owes a reply.
 * The user runs /compact, which stops the turn. As the stopped run settles, a
 * relay (what the user told a child, which does not wake main) is appended.
 * The compaction then no longer counts as one that stopped main, and no
 * reminder wakes main for the note.
 *
 *   node formal/subagents-mail/repro-f2.mts            # with the relay
 *   node formal/subagents-mail/repro-f2.mts --control  # no relay: main is reminded
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

let relayOnSettle = false;
async function setup(state: Requests, options: Options = {}) {
	const box: { mail?: InstanceType<typeof MainMail> } = {};
	const note = () => box.mail!.deliver({ kind: "note", from: "scan-1", text: NOTE });
	// The extension's wiring, without the team: main's mail and where main is.
	const extension = (pi: any) => {
		const watch = watchMain(pi, () => box.mail);
		options.more?.(pi, note);
		// Another handler of agent_settled, after main-watch's: a child relays what the user told it.
		pi.on("agent_settled", async () => { if (relayOnSettle) { relayOnSettle = false; box.mail!.deliver({ kind: "relay", from: "user", to: "scan-1", text: "RELAY", answered: false }); } });
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
	const run = session.prompt("three").catch(() => undefined);
	await until(() => state.seen.length === 1, "main's turn");
	note();
	relayOnSettle = !control;
	let compactError: unknown;
	const compacting = session.compact().catch((error: unknown) => { compactError = error; });
	// The summary request sees the note too, so its label can carry "(sees note)".
	await until(() => state.seen.some((request) => request.startsWith("summary")) || compactError !== undefined, "the summary request");
	if (compactError) console.log("compact failed:", (compactError as Error).message, transcript(session), state.seen);
	state.release();
	await Promise.all([run, compacting]);
	await sleep(1_000);
	await session.waitForIdle();
	const reminded = state.seen.some((request) => request.endsWith("(reminded)"));
	const after = state.seen.slice(state.seen.findIndex((request) => request.startsWith("summary")) + 1);
	console.log(JSON.stringify({ path: control ? "control: no relay" : "relay appended as the stopped run settles", seen: state.seen, turnsAfterCompaction: after.length, reminded, transcript: transcript(session) }, null, 2));
	process.exitCode = reminded ? 0 : 1;
} finally {
	close();
}
