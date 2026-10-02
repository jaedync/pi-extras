/**
 * Mail to main against Pi's real session, driven by its faux provider: what
 * happens when it lands while main works, as the user presses Esc, or while
 * main compacts. A summary request can be held open, so mail lands mid-compaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "main-mail-sdk-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { MainMail } = await import("../lib/subagents/deliver.ts");
const { watchMain } = await import("../lib/subagents/main-watch.ts");

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

test("mail that lands while main works survives Esc, which clears Pi's queues", { timeout: 20_000 }, async () => {
	const state = requests();
	state.holdTurn = new Promise<void>((resolve) => { setTimeout(resolve, 300); });
	const { session, note, close } = await setup(state);
	try {
		const run = session.prompt("work");
		await until(() => state.seen.length === 1, "main's turn");
		note();
		// What interactive mode does on Esc while main works: queued input back to the editor, then abort.
		session.clearQueue();
		await session.abort();
		await run;
		await session.waitForIdle();
		assert.match(transcript(session), /note/, "the note is in the transcript for main's next turn");
		assert.deepEqual(state.seen, ["turn"], "Esc stops main; the note doesn't start it again");
	} finally {
		close();
	}
});

test("mail that lands during main's last turn is read before main stops", { timeout: 20_000 }, async () => {
	const state = requests();
	let unhold!: () => void;
	state.holdTurn = new Promise<void>((resolve) => { unhold = resolve; });
	const { session, note, close } = await setup(state);
	try {
		const run = session.prompt("work");
		await until(() => state.seen.length === 1, "main's turn");
		note();
		unhold();
		await run;
		await session.waitForIdle();
		assert.deepEqual(state.seen, ["turn", "turn (sees note)"]);
		assert.match(transcript(session), /user > assistant > note > assistant$/);
	} finally {
		close();
	}
});

test("mail during a manual compaction waits for it, then wakes main on the compacted context", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state);
	try {
		for (const text of ["one", "two", "three"]) await session.prompt(text);
		state.seen.length = 0;
		const compacting = session.compact();
		await until(() => state.seen.includes("summary"), "the summary request");
		note();
		await sleep(150);
		assert.ok(!state.seen.some((request) => request.startsWith("turn")), `no turn races the summary: ${state.seen}`);
		assert.doesNotMatch(transcript(session), /note/);
		state.release();
		await compacting;
		await until(() => state.seen.includes("turn (sees note)"), "main's turn on the note");
		await session.waitForIdle();
		assert.match(transcript(session), /COMPACTION > note > assistant$/);
	} finally {
		close();
	}
});

test("mail during an automatic compaction at the end of a run is read once it finishes", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state, { contextWindow: 4_000, compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 200 }, filler: " filler".repeat(400) });
	try {
		const run = session.prompt("start");
		await until(() => state.seen.includes("summary"), "the automatic summary");
		note();
		await sleep(100);
		state.release();
		await run;
		await session.waitForIdle();
		const summary = state.seen.indexOf("summary");
		assert.ok(state.seen.slice(summary + 1).includes("turn (sees note)"), `main read the note after the compaction: ${state.seen}`);
		assert.match(transcript(session), /COMPACTION > note > assistant/);
	} finally {
		close();
	}
});

test("a /compact that stops main's turn wakes main afterwards for the mail it hadn't replied to", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state);
	try {
		for (const text of ["one", "two"]) await session.prompt(text);
		state.seen.length = 0;
		state.holdTurn = new Promise<void>((resolve) => { setTimeout(resolve, 300); });
		const run = session.prompt("three").catch(() => undefined);
		await until(() => state.seen.length === 1, "main's turn");
		note();
		// /compact stops the turn first; the note lands in the transcript as it stops.
		const compacting = session.compact();
		await until(() => state.seen.includes("summary"), "the summary request");
		state.release();
		await Promise.all([run, compacting]);
		await until(() => state.seen.some((request) => request.endsWith("(reminded)")), "main woken after the compaction");
		await session.waitForIdle();
		assert.match(transcript(session), /COMPACTION > note > assistant$/, "the reminder, then main's reply");
	} finally {
		close();
	}
});

test("mail that lands while main is settling, after it was checked, still wakes main", { timeout: 20_000 }, async () => {
	const state = requests();
	let sent = false;
	const { session, close } = await setup(state, {
		// Another extension's settle handler running after the mail's check: the note lands then.
		more: (pi, note) => pi.on("agent_before_settle", async () => { if (!sent) { sent = true; note(); } return undefined; }),
	});
	try {
		await session.prompt("work");
		await until(() => state.seen.includes("turn (sees note)"), "main's turn on the note");
		await session.waitForIdle();
		assert.match(transcript(session), /note > assistant$/);
	} finally {
		close();
	}
});

test("held mail waits for the prompt the user sent as the compaction ended, instead of colliding with it", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state, {
		// A slow input handler holds the prompt in its preflight, when Pi still looks idle.
		more: (pi) => pi.on("input", async () => { await sleep(150); return { action: "continue" }; }),
	});
	try {
		for (const text of ["one", "two", "three"]) await session.prompt(text);
		state.seen.length = 0;
		const compacting = session.compact();
		await until(() => state.seen.includes("summary"), "the summary request");
		note();
		state.release();
		await compacting;
		// What interactive mode does with text typed during the compaction.
		await session.prompt("typed during the compaction");
		await until(() => state.seen.includes("turn (sees note)"), "main's turn on the note");
		await session.waitForIdle();
		assert.doesNotMatch(transcript(session), /COMPACTION > note > assistant > user/, "the note didn't start a turn of its own ahead of the prompt");
	} finally {
		close();
	}
});

test("Esc, then a prompt, then a /compact, sends no reminder: the user stopped main and moved on", { timeout: 20_000 }, async () => {
	const state = requests();
	state.release();
	const { session, note, close } = await setup(state);
	try {
		for (const text of ["one", "two"]) await session.prompt(text);
		state.holdTurn = new Promise<void>((resolve) => { setTimeout(resolve, 300); });
		const run = session.prompt("three");
		await until(() => state.seen.length === 3, "main's turn");
		note();
		session.clearQueue();
		await session.abort();
		await run;
		await session.prompt("something else");
		await session.compact();
		await sleep(300);
		await session.waitForIdle();
		assert.ok(!state.seen.some((request) => request.endsWith("(reminded)")), `no reminder: ${state.seen}`);
	} finally {
		close();
	}
});

test("a /compact that stops main inside a tool call wakes main afterwards too", { timeout: 20_000 }, async () => {
	const state = requests();
	let toolStarted = false;
	const { session, note, close } = await setup(state, {
		more: (pi) => pi.registerTool({
			name: "slow_tool", label: "Slow tool", description: "Waits a while.", parameters: { type: "object", properties: {} },
			execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
				toolStarted = true;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 3_000);
					signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
				});
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		}),
	});
	try {
		for (const text of ["one", "two"]) await session.prompt(text);
		state.seen.length = 0;
		state.toolTurn = true;
		const run = session.prompt("three").catch(() => undefined);
		await until(() => toolStarted, "main inside its tool call");
		note();
		// The run ends on the tool's result, not on a stopped reply.
		const compacting = session.compact();
		await until(() => state.seen.includes("summary"), "the summary request");
		state.release();
		await Promise.all([run, compacting]);
		await until(() => state.seen.some((request) => request.endsWith("(reminded)")), "main woken after the compaction");
		await session.waitForIdle();
	} finally {
		close();
	}
});
