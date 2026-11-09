/**
 * Live repro of a path to finding F4 that needs no other extension (round-3
 * review, M1). A note lands while main works on a user turn, so main owes a
 * reply. The user runs /compact on a short session. compact() aborts the run
 * (agent-session.js:2231), then throws "Nothing to compact (session too
 * small)" before session_before_compact (:2243-2249), so main-watch's handler
 * does not run, `compactionStopped` stays false, and session_compact_failed
 * (aborted false) sends no reminder.
 *
 *   node formal/subagents-mail/repro-f4-small.mts            (keepRecentTokens 20000: no reminder, exit 1)
 *   node formal/subagents-mail/repro-f4-small.mts --control  (keepRecentTokens 1: the compaction runs, main is reminded, exit 0)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";
const path = process.argv.includes("--control") ? "control" : "small";
const scratch = mkdtempSync(join(tmpdir(), "f4-small-"));
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
let holdTurn: Promise<void> | undefined;
const step = async (context: any) => {
	const text = JSON.stringify(context.messages);
	const last = JSON.stringify(context.messages.at(-1)?.content ?? "");
	const reminded = /was stopped before you replied/.test(last);
	seen.push(`turn${text.includes(NOTE) ? " (sees note)" : ""}${reminded ? " (reminded)" : ""}`);
	const hold = holdTurn; holdTurn = undefined; await hold;
	return ai.fauxAssistantMessage(text.includes(NOTE) ? "Got the note." : "Answer.");
};
let cancelCompact = false;
const failedEvents: unknown[] = [];
const box: { mail?: any } = {};
const mailExt = (pi: any) => {
	const watch = watchMain(pi, () => box.mail);
	// extensions/subagents.ts: Pi appended the mail as it went into main's context.
	pi.on("message_end", (event: { message?: { role?: string; details?: { id?: unknown } } }) => { const id = event.message?.details?.id; if (event.message?.role === "custom" && typeof id === "string") box.mail?.acknowledge(id); });
	pi.on("session_compact_failed", async (e: any) => { failedEvents.push({ aborted: e.aborted, errorMessage: e.errorMessage }); });
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		box.mail?.dispose();
		box.mail = new MainMail({ batchMs: 0, retryMs: 20, port: { send: (m: any, o: any) => pi.sendMessage(m, o) }, route: () => watch.route(ctx) });
	});
};
const cancelExt = (pi: any) => { pi.on("session_before_compact", async () => (cancelCompact ? { cancel: true } : undefined)); };
const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 20 }, () => step));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: path === "small" ? 20_000 : 1 }, cacheWarming: "off" });
const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
	noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [mailExt] });
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
	holdTurn = new Promise<void>((resolve) => { setTimeout(resolve, 300); });
	cancelCompact = true;
	const run = session.prompt("three").catch(() => undefined);
	for (let i = 0; i < 200 && seen.length === 0; i++) await sleep(10);
	box.mail!.deliver({ kind: "note", from: "scan-1", text: NOTE });
	let compactError = "";
	await session.compact().catch((error: unknown) => { compactError = (error as Error).message; });
	await run;
	await sleep(1_000);
	await session.waitForIdle();
	const replied = /note > (note > )?assistant$/.test(transcript());
	console.log(JSON.stringify({ path, compactError, failedEvents, seen, replied, transcript: transcript() }));
	process.exitCode = replied ? 0 : 1;
} finally { box.mail?.dispose(); session.dispose(); }
