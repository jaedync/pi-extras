/**
 * A real Pi AgentSessionRuntime (Pi 1.4.0) with the real rate-limit-recovery
 * extension, a faux provider and no network. Shared by repro-f1.mts and
 * repro-f2.mts. The faux model's base URL is http://localhost:0 at no cost, so
 * the extension treats it as a local server (local.ts localTarget). The waits
 * and the server check are the only fakes: a wait blocks until release(), and
 * the check always says that the server answers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "fv-rate-limit-repro-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
export const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const { default: recovery } = await import("../../extensions/rate-limit-recovery.ts");

export const LOCAL_FAILURE = () => ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });

export async function world() {
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ rateLimitRecovery: { autoWait: true, localRetry: true } }));
	const runtimeModels = await sdk.ModelRuntime.create({ allowModelNetwork: false });
	const faux = ai.fauxProvider({ provider: "kiln", models: [{ id: "qwen-local" }] });
	runtimeModels.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const blocked: Array<(finished: boolean) => void> = [];
	let open = false;
	const wait = (_ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
		if (signal.aborted) { resolve(false); return; }
		signal.addEventListener("abort", () => resolve(false), { once: true });
		if (open) setImmediate(() => resolve(true)); else blocked.push(resolve);
	});
	const errors: unknown[] = [];
	const uiContext = { notify() {}, setWidget() {}, getEditorText: () => "", onTerminalInput: () => () => {} };
	const createRuntime = async (options: any) => {
		const loader = new sdk.DefaultResourceLoader({
			cwd: scratch, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [{ name: "rate-limit-recovery", factory: (pi: any) => recovery(pi, { configFile, env: {}, wait, probe: async () => true, random: () => 0.5 }) }],
		});
		await loader.reload();
		const { session } = await sdk.createAgentSession({
			cwd: scratch, agentDir, modelRuntime: runtimeModels, model: faux.getModel("qwen-local"), settingsManager, resourceLoader: loader,
			sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "all",
		});
		return { session, services: { cwd: scratch, agentDir }, diagnostics: [] };
	};
	const bind = (session: any) => session.bindExtensions({ mode: "tui", uiContext, onError: (error: unknown) => errors.push(error) });
	const sessionManager = sdk.SessionManager.create(scratch, join(scratch, "sessions"));
	const host = await sdk.createAgentSessionRuntime(createRuntime, { cwd: scratch, agentDir, sessionManager });
	host.setRebindSession(async (session: any) => { await bind(session); });
	await bind(host.session);
	return {
		host, faux, errors,
		/** Let every wait end now and later ones end at once. */
		release() { open = true; for (const resolve of blocked.splice(0)) resolve(true); },
		/** Local-wait entries on the branch, oldest first. */
		localWaits: () => host.session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.data?.kind === "local-wait").map((e: any) => e.data.state),
		resumeMessages: () => host.session.sessionManager.getBranch().filter((e: any) => e.type === "custom_message" && e.customType === "rate-limit-recovery-local-resume").length,
		async idle() { for (let i = 0; i < 50; i++) { await sleep(20); if (host.session.isIdle) { await sleep(50); if (host.session.isIdle) return; } } },
		async close() {
			await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			host.session.dispose();
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}
