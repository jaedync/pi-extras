/**
 * Child process for auto-update-reload-guard-sdk.test.mts. A real Pi session
 * loads an extension, the extension's dependency changes on disk, and the
 * session reloads. Pi's loader reads index.js again but keeps the old
 * config.js from Node's ESM cache, so the new index.js calls an export that
 * the cached module does not have and throws in an async step: an unhandled
 * rejection, which ends a Pi process (incident 2026-11-16).
 *
 * argv[2]: "guard" arms the auto-update reload guard around the reload; "bare" does not.
 * Prints one JSON line {alive, reported} and exits 0 when the process lives on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "./pi-runtime.mjs";
import { processReloadGuard, RELOAD_GUARD_MS } from "../../lib/auto-update/reload-guard.ts";

const mode = process.argv[2];
const scratch = mkdtempSync(join(tmpdir(), "reload-mixed-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href);

const ext = join(scratch, "ext");
mkdirSync(ext);
/** Version 2 adds an export to config.js and calls it after an await, as remote-pi's command root did. */
function writeExtension(version: 1 | 2): void {
	writeFileSync(join(ext, "package.json"), JSON.stringify({ name: "mixed-modules", type: "module" }));
	writeFileSync(join(ext, "config.js"), version === 1 ? "export const a = () => 1;\n" : "export const a = () => 2;\nexport const b = () => 'new';\n");
	// With a bare import, as in remote-pi's dist files, Pi's loader reads index.js again at the reload but
	// gives it config.js from a cache. Without one, both files load fresh (probe, 2026-11-16).
	writeFileSync(join(ext, "index.js"), version === 1
		? "import { Type } from 'typebox';\nimport { a } from './config.js';\nexport default function () { void Type; globalThis.__mixed = 'v1 ' + a(); }\n"
		: "import { Type } from 'typebox';\nimport { a, b } from './config.js';\nexport default function () { void Type; globalThis.__mixed = 'v2'; void (async () => { await null; try { globalThis.__mixed = 'v2 ' + b(); } finally { globalThis.__mixedDone(); } })(); }\n");
}

writeExtension(1);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
const resourceLoader = new sdk.DefaultResourceLoader({
	cwd: scratch, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [join(ext, "index.js")],
});
await resourceLoader.reload();
const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
await session.bindExtensions({ mode: "print" });

const reported: string[] = [];
// The extension's async step calls this when it ends; its rejection is handled before the next turn of the event loop.
const stepDone = new Promise<void>((resolve) => {
	(globalThis as { __mixedDone?: () => void }).__mixedDone = resolve;
});
const guard = processReloadGuard();
if (mode === "guard") {
	guard.setReporter((text) => reported.push(text));
	guard.arm(RELOAD_GUARD_MS, () => {});
}
writeExtension(2);
await session.reload();
await stepDone;
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(`${JSON.stringify({ alive: true, loaded: (globalThis as { __mixed?: string }).__mixed, reported })}\n`);
guard.disarm();
process.exit(0);
