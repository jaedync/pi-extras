/**
 * Mail to main against Pi's real session, driven by its faux provider: what
 * happens when it lands while main works, as the user presses Esc, or while
 * main compacts. A summary request can be held open, so mail lands mid-compaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";

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
const { MainMail } = await import("../lib/subagents/deliver.ts");
const { watchMain } = await import("../lib/subagents/main-watch.ts");

const NOTE = "NOTE-FROM-SCAN-1";

interface Requests {
	seen: string[];
	gate: Promise<void>;
	release(): void;
	holdTurn?: Promise<void>;
	/** The messages of the last turn request, as JSON. */
	lastTurn?: string;
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
		if (!summary) state.lastTurn = text;
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
	more?: (pi: any, note: () => void, mail: () => InstanceType<typeof MainMail> | undefined) => void;
	/** Another extension, loaded before the mail's. */
	first?: (pi: any) => void;
}

async function setup(state: Requests, options: Options = {}) {
	const box: { mail?: InstanceType<typeof MainMail> } = {};
	const note = () => box.mail!.deliver({ kind: "note", from: "scan-1", text: NOTE });
	// The extension's wiring, without the team: main's mail and where main is.
	const extension = (pi: any) => {
		const watch = watchMain(pi, () => box.mail);
		// extensions/subagents.ts: Pi appended the mail as it went into main's context.
		pi.on("message_end", (event: { message?: { role?: string; details?: { id?: unknown } } }) => { const id = event.message?.details?.id; if (event.message?.role === "custom" && typeof id === "string") box.mail?.acknowledge(id); });
		options.more?.(pi, note, () => box.mail);
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
		noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: options.first ? [options.first, extension] : [extension] });
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
	// pi-ai 1.5 faux counts each prompt token once (1.4 counted cache hits twice), so the reply alone must cross the 3,000-token threshold; 800 is too few.
	const { session, note, close } = await setup(state, { contextWindow: 4_000, compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 200 }, filler: " filler".repeat(1600) });
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

// Findings F1 to F4 of formal/subagents-mail/README.md: each path below once left main with mail it never replied to.

/** Holds main's next turn open until `open` runs: the tests below open it once /compact has started. */
function holdNextTurn(state: Requests): () => void {
	let open!: () => void;
	state.holdTurn = new Promise<void>((resolve) => { open = resolve; });
	return open;
}

/** Runs /compact while main's turn works on the note, then opens `gates`, lets the summary go, and waits for main to settle. */
async function compactWhileWorking(session: any, state: Requests, run: Promise<unknown>, ...gates: Array<() => void>): Promise<string> {
	let compactError = "";
	const compacting = session.compact().catch((error: unknown) => { compactError = (error as Error).message; });
	for (const open of gates) open();
	await until(() => state.seen.some((request) => request.startsWith("summary")) || compactError !== "", "the summary request or the compaction's failure");
	state.release();
	await Promise.all([run, compacting]);
	await until(() => state.seen.some((request) => request.endsWith("(reminded)")), `main woken after the compaction (${compactError || "compacted"}; ${state.seen})`);
	await session.waitForIdle();
	return compactError;
}

/** Whether a turn request read the reminder. */
const REMINDER_TEXT = /was stopped before you replied/;

/**
 * Runs /compact while main's turn works on the note and ends it without a
 * summary: `esc` aborts it as interactive mode does on Esc, else an extension
 * cancels it. No turn may start by itself (owner answer 846). The reminder
 * lands without a turn, the user's next turn reads it, and main replies.
 */
async function cancelWhileWorking(session: any, state: Requests, run: Promise<unknown>, open: () => void, esc: boolean): Promise<string> {
	let compactError = "";
	const compacting = session.compact().catch((error: unknown) => { compactError = (error as Error).message; });
	open();
	await until(() => state.seen.some((request) => request.startsWith("summary")) || compactError !== "", "the summary request or the compaction's cancel");
	if (esc) session.abortCompaction();
	state.release();
	await Promise.all([run, compacting]);
	// Long enough for a deferred or retried send to start a turn, had one been made.
	await sleep(500);
	await session.waitForIdle();
	assert.deepEqual(state.seen.filter((request) => request.startsWith("turn")), ["turn"], "no turn starts after the cancel");
	assert.match(transcript(session), /assistant > note > note$/, "the stopped reply, the note, then the hidden reminder, in the session file");
	await session.prompt("four");
	assert.match(state.lastTurn ?? "", REMINDER_TEXT, `the next turn reads the reminder: ${state.seen}`);
	assert.equal(state.seen.at(-1), "turn (sees note)");
	assert.match(transcript(session), /note > note > user > assistant$/, "the reminder, the user's message, then main's reply");
	return compactError;
}

/** Two quick turns, then a user turn that is still working when the note lands; `open` ends that turn. */
async function noteDuringUserTurn(session: any, state: Requests, note: () => void): Promise<{ run: Promise<unknown>; open: () => void }> {
	for (const text of ["one", "two"]) await session.prompt(text);
	state.seen.length = 0;
	const open = holdNextTurn(state);
	const run = session.prompt("three");
	await until(() => state.seen.length === 1, "main's turn");
	note();
	// Wrapped: an async function that returned the run itself would wait for it.
	return { run, open };
}

test("F1: a /compact that stops the turn a note started wakes main afterwards for that note", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state);
	try {
		for (const text of ["one", "two"]) await session.prompt(text);
		state.seen.length = 0;
		const open = holdNextTurn(state);
		// Main is idle, so the note starts the turn itself.
		note();
		await until(() => state.seen.length === 1, "the turn the note started");
		await compactWhileWorking(session, state, session.waitForIdle(), open);
		assert.match(transcript(session), /note > assistant > COMPACTION > note > assistant$/, "the stopped reply, the compaction, the reminder, then main's reply");
	} finally {
		close();
	}
});

test("F2: a relay appended as the stopped run settles does not cancel the reminder", { timeout: 20_000 }, async () => {
	const state = requests();
	let relay = false;
	const { session, note, close } = await setup(state, {
		// Another agent_settled handler, after main-watch's: a child relays what the user told it, which does not wake main.
		more: (pi, _note, mail) => pi.on("agent_settled", async () => {
			if (!relay) return;
			relay = false;
			mail()!.deliver({ kind: "relay", from: "user", to: "scan-1", text: "RELAY", answered: false });
		}),
	});
	try {
		const { run, open } = await noteDuringUserTurn(session, state, note);
		relay = true;
		await compactWhileWorking(session, state, run, open);
		assert.match(transcript(session), /note > note > COMPACTION > note > assistant$/, "the note, the relay, the compaction, the reminder, then main's reply");
	} finally {
		close();
	}
});

test("F3: a /compact during the settle check, after main-watch asked for a turn, wakes main afterwards", { timeout: 20_000 }, async () => {
	const state = requests();
	let slow = false;
	let inCheck!: () => void;
	const checking = new Promise<void>((resolve) => { inCheck = resolve; });
	let ioDone!: () => void;
	const io = new Promise<void>((resolve) => { ioDone = resolve; });
	const { session, note, close } = await setup(state, {
		// Another extension's settle check, after main-watch's, whose I/O ends once the user has run /compact.
		more: (pi) => pi.on("agent_before_settle", async () => { if (slow) { slow = false; inCheck(); await io; } }),
	});
	try {
		const { run, open } = await noteDuringUserTurn(session, state, note);
		slow = true;
		// The turn ends with the note held for its boundary, so the settle check starts with the note owed.
		open();
		await checking;
		await compactWhileWorking(session, state, run, ioDone);
		assert.match(transcript(session), /note > COMPACTION > note > assistant$/);
	} finally {
		close();
	}
});

for (const order of ["after", "before"] as const) {
	// Pi says `aborted` for an extension's cancel as for Esc, so it waits for the next turn too.
	test(`F4: a /compact that an extension loaded ${order} the mail's cancels reminds main with its next turn`, { timeout: 20_000 }, async () => {
		const state = requests();
		const cancel = (pi: any) => pi.on("session_before_compact", async () => ({ cancel: true }));
		const { session, note, close } = await setup(state, order === "before" ? { first: cancel } : { more: cancel });
		try {
			const { run, open } = await noteDuringUserTurn(session, state, note);
			assert.equal(await cancelWhileWorking(session, state, run, open, false), "Compaction cancelled");
		} finally {
			close();
		}
	});
}

test("Esc during the summary of a /compact that stopped main starts no turn; the next user message carries the reminder", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state);
	try {
		const { run, open } = await noteDuringUserTurn(session, state, note);
		assert.equal(await cancelWhileWorking(session, state, run, open, true), "Compaction cancelled");
		assert.ok(state.seen.includes("summary"), "Esc came during the summary");
	} finally {
		close();
	}
});

test("a message typed during the summary, then Esc: that message's run reads the reminder and main replies in it", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state);
	try {
		const { run, open } = await noteDuringUserTurn(session, state, note);
		// Interactive mode queues what the user types during a compaction and sends it on compaction_end.
		let typed: Promise<unknown> | undefined;
		const unsubscribe = session.subscribe((event: { type: string; aborted?: boolean }) => {
			if (event.type === "compaction_end" && event.aborted && !typed) typed = session.prompt("four");
		});
		let compactError = "";
		const compacting = session.compact().catch((error: unknown) => { compactError = (error as Error).message; });
		open();
		await until(() => state.seen.some((request) => request.startsWith("summary")), "the summary request");
		session.abortCompaction();
		state.release();
		await Promise.all([run, compacting]);
		assert.equal(compactError, "Compaction cancelled");
		await until(() => typed !== undefined, "the typed message");
		await typed;
		await session.waitForIdle();
		unsubscribe();
		const turns = state.seen.filter((request) => request.startsWith("turn"));
		assert.equal(turns.length, 3, `the stopped turn, the typed message's turn, then the reply to the reminder in the same run: ${state.seen}`);
		assert.match(transcript(session), /user > assistant > note > assistant$/, "the typed message, main's answer, the reminder at the turn boundary, main's reply");
		assert.match(state.lastTurn ?? "", REMINDER_TEXT);
	} finally {
		close();
	}
});

test("F4: a /compact of a session too small to compact still wakes main for the turn it stopped", { timeout: 20_000 }, async () => {
	const state = requests();
	const { session, note, close } = await setup(state, { compaction: { enabled: false, keepRecentTokens: 20_000 } });
	try {
		const { run, open } = await noteDuringUserTurn(session, state, note);
		assert.match(await compactWhileWorking(session, state, run, open), /Nothing to compact/);
		assert.match(transcript(session), /assistant > note > note > assistant$/);
	} finally {
		close();
	}
});
