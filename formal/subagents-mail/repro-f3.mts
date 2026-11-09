/**
 * Live repros of findings F3 and F4 (formal/subagents-mail/README.md), first
 * written by the review of this record (R1 and R2). Real Pi 1.4.0
 * AgentSession, faux provider, the real MainMail and watchMain. A note lands
 * while main works on a user turn, so main owes a reply; the user runs /compact.
 *   node formal/subagents-mail/repro-f3.mts boundary  # F3: /compact lands in agent_before_settle after main-watch said continue
 *   node formal/subagents-mail/repro-f3.mts cancel    # F4: another extension cancels the /compact that stopped the turn
 *   node formal/subagents-mail/repro-f3.mts control   # /compact while the turn streams: main is reminded
 * Exit 1: main never replies to the note.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const mode = process.argv[2] ?? "boundary";
const scratch = mkdtempSync(join(tmpdir(), "main-mail-review-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
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
const seen: string[] = [];
let releaseSummary!: () => void;
const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
let holdTurn: Promise<void> | undefined;
const step = async (context: any) => {
	const text = JSON.stringify(context.messages);
	const last = JSON.stringify(context.messages.at(-1)?.content ?? "");
	const summary = /^\[\{"type":"text","text":"(<conversation>|# Conversation)/.test(last);
	const reminded = /was stopped before you replied/.test(last);
	seen.push(`${summary ? "summary" : "turn"}${text.includes(NOTE) ? " (sees note)" : ""}${reminded ? " (reminded)" : ""}`);
	if (summary) { await summaryGate; return ai.fauxAssistantMessage("## Summary\nEarlier work."); }
	const hold = holdTurn; holdTurn = undefined; await hold;
	return ai.fauxAssistantMessage(text.includes(NOTE) ? "Got the note." : "Answer.");
};

const piEvents: string[] = [];
let slowBoundary = false;
let cancelCompact = false;
let inBoundary!: () => void;
const boundary = new Promise<void>((resolve) => { inBoundary = resolve; });
const box: { mail?: InstanceType<typeof MainMail> } = {};
const extension = (pi: any) => {
	const watch = watchMain(pi, () => box.mail);
	// The Pi rule of F3: which agent_end events (and their last stopReason) the run sends, and what agent_settled says.
	pi.on("agent_end", async (event: any) => { piEvents.push(`agent_end ${event.messages.at(-1)?.stopReason}`); });
	pi.on("agent_settled", async (event: any) => { piEvents.push(`agent_settled aborted=${event.aborted}`); });
	// Another extension's settle check, after main-watch's, that does some I/O.
	pi.on("agent_before_settle", async () => { if (slowBoundary) { slowBoundary = false; inBoundary(); await sleep(200); } });
	// Another extension that cancels this compaction.
	pi.on("session_before_compact", async () => (cancelCompact ? { cancel: true } : undefined));
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		box.mail?.dispose();
		box.mail = new MainMail({ batchMs: 0, retryMs: 20, port: { send: (message, options) => pi.sendMessage(message, options) }, route: () => watch.route(ctx) });
	});
};
const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 20 }, () => step));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
	noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
await loader.reload();
const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "m"),
	settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
await session.bindExtensions({ mode: "print", uiContext: { notify: () => undefined } });
const transcript = () => session.sessionManager.getBranch()
	.map((e: any) => e.type === "compaction" ? "COMPACTION" : e.type === "custom_message" ? "note" : e.type === "message" ? e.message.role : undefined)
	.filter(Boolean).join(" > ");
try {
	for (const text of ["one", "two"]) await session.prompt(text);
	seen.length = 0;
	piEvents.length = 0;
	holdTurn = new Promise<void>((resolve) => { setTimeout(resolve, 300); });
	slowBoundary = mode === "boundary";
	cancelCompact = mode === "cancel";
	const run = session.prompt("three").catch(() => undefined);
	for (let i = 0; i < 200 && seen.length === 0; i++) await sleep(10);
	box.mail!.deliver({ kind: "note", from: "scan-1", text: NOTE });
	if (mode === "boundary") await boundary;
	let compactError = "";
	const compacting = session.compact().catch((error: unknown) => { compactError = (error as Error).message; });
	for (let i = 0; i < 300 && !seen.some((s) => s.startsWith("summary")) && !compactError; i++) await sleep(10);
	releaseSummary();
	await Promise.all([run, compacting]);
	await sleep(1_000);
	await session.waitForIdle();
	const replied = /note > (COMPACTION > )?(note > )?assistant$/.test(transcript());
	console.log(JSON.stringify({ mode, compactError: compactError || undefined, piEvents, seen, reminded: seen.some((s) => s.endsWith("(reminded)")), replied, transcript: transcript() }, null, 2));
	process.exitCode = replied ? 0 : 1;
} finally { box.mail?.dispose(); session.dispose(); }
