/**
 * Live repro of round-2 review item N1 (formal/subagents-mail/README.md, F4):
 * the first F4 fix (REMIND_ON_FAILED_COMPACT) depends on the extension order.
 * Pi stops the session_before_compact emit at the first cancel
 * (runner.js:820-824), so main-watch's handler does not run when the
 * cancelling extension loads first. The fix is simulated: main-watch sees
 * session_compact_failed with aborted=false.
 *   node formal/subagents-mail/repro-f4-order.mts after   # cancel extension after ours: reminded (exit 0)
 *   node formal/subagents-mail/repro-f4-order.mts before  # cancel extension first: no reminder (exit 1)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const mode = process.argv[2] ?? "before";
if (mode !== "before" && mode !== "after") throw new Error(`mode must be before or after, not ${mode}`);
const scratch = mkdtempSync(join(tmpdir(), "f4-order-"));
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
const watchRan: string[] = [];
const box: { mail?: InstanceType<typeof MainMail> } = {};
const mailExt = (pi: any) => {
	// The simulated fix: session_compact_failed reminds whatever `aborted` says.
	const fixed = {
		on: (name: string, h: any) => pi.on(name, name === "session_compact_failed" ? (e: any, c: any) => h({ ...e, aborted: false }, c)
			: name === "session_before_compact" ? (e: any, c: any) => { watchRan.push(name); return h(e, c); } : h),
	};
	const watch = watchMain(fixed as any, () => box.mail);
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		box.mail?.dispose();
		box.mail = new MainMail({ batchMs: 0, retryMs: 20, port: { send: (message, options) => pi.sendMessage(message, options) }, route: () => watch.route(ctx) });
	});
};
const cancelExt = (pi: any) => { pi.on("session_before_compact", async () => (cancelCompact ? { cancel: true } : undefined)); };
const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 20 }, () => step));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
const loader = new sdk.DefaultResourceLoader({
	cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	extensionFactories: mode === "before" ? [cancelExt, mailExt] : [mailExt, cancelExt],
});
await loader.reload();
const { session } = await sdk.createAgentSession({
	cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "m"),
	settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch),
});
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
	console.log(JSON.stringify({ mode, compactError, mainWatchBeforeCompactRan: watchRan.length > 0, seen, replied, transcript: transcript() }, null, 2));
	process.exitCode = replied ? 0 : 1;
} finally { box.mail?.dispose(); session.dispose(); }
