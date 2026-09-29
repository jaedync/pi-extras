/**
 * Opt-in computer use for Windows Hyper-V guests, from Pi running in WSL on the
 * Hyper-V host. PI_WINDOWS_USE=on enables it; nothing is registered otherwise.
 * Scripts batch `win.*` calls like computer_use batches `sky.*` ones.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineTool, highlightCode, keyHint, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CodeExecutor, type CodeResult } from "../computer-use/executor.ts";
import { painter } from "../computer-use/paint.ts";
import { renderCall, renderResult, type RowDetails } from "../computer-use/render.ts";
import { markRow } from "../tool-row.ts";
import { WIN_API, WinSession, vmAllowlist } from "./api.ts";
import { HostSession } from "./host.ts";

const ENABLED = new Set(["1", "on", "true", "yes"]);
/** Close the host after this long without a call; restarting it takes a few seconds. */
const IDLE_MS = 10 * 60_000;
const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

export function isWsl(env: Readonly<Record<string, string | undefined>>, osRelease: () => string = () => readFileSync("/proc/sys/kernel/osrelease", "utf8")): boolean {
	if (env.WSL_DISTRO_NAME) return true;
	try { return /microsoft/i.test(osRelease()); } catch { return false; }
}

export function windowsUseEnabled(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, wsl: boolean): boolean {
	return platform === "linux" && wsl && ENABLED.has((env.PI_WINDOWS_USE ?? "").trim().toLowerCase());
}

const DESCRIPTION = `Run JavaScript that operates Windows Hyper-V virtual machines on this host, the way computer use operates apps. No nested model is used.

Guest methods run through Windows-MCP inside the VM (UI Automation tree, input, PowerShell). Every method takes { vm: "<VM name>" }. The first call to a VM signs it in, unlocks it or installs Windows-MCP as needed, and says so in the result.
- win.vms() -> [{ name, state, running, installed, ip }]: the VMs this session may use
- win.snapshot({ vm, use_vision?, use_ui_tree?, use_dom? }) -> { text, screenshot }: text lists windows and UI elements with labels and (x, y) centers
- win.screenshot({ vm }) -> { text, screenshot }: fast, no UI tree
- win.click({ vm, label? | x?, y?, button?, clicks? })
- win.type({ vm, text, label? | x?, y?, clear?, enter? })
- win.scroll({ vm, label? | x?, y?, direction?: "up"|"down"|"left"|"right", amount?, horizontal? })
- win.move({ vm, label? | x?, y?, drag?, from?: [x, y] })
- win.key({ vm, keys }): e.g. "ctrl+c", "win+r", "enter"
- win.app({ vm, mode?: "launch"|"switch"|"resize", name })
- win.wait_for({ vm, condition, text?, window_name?, timeout? })
- win.powershell({ vm, command, timeout? }) -> { output, status }: output is stdout (stderr when stdout is empty), status the exit code; runs as the signed-in user; timeout in seconds, default 30, at most 540
- win.call({ vm, tool, args }): any other Windows-MCP tool (Clipboard, Process, FileSystem, Registry, Scrape, MultiSelect, MultiEdit, Wait)
Console methods drive the VM's screen, keyboard and mouse from the host; they also work on lock, sign-in and UAC screens. Coordinates are guest pixels.
- win.console.screenshot({ vm }) -> { text: '{"width","height"}', screenshot }
- win.console.click({ vm, x, y, button?, double? }), win.console.move/drag({ vm, x, y, x2?, y2? }), win.console.scroll({ vm, x, y, amount? })
- win.console.type({ vm, text }) (US keyboard layout; "\\n" presses Enter), win.console.key({ vm, keys }), win.console.cad({ vm })
- win.start({ vm }) starts or resumes a VM; win.login({ vm }) clicks Sign in; win.setup({ vm }) reinstalls Windows-MCP
- win.sleep(ms) pauses up to 60 s, e.g. for the screen to settle between console steps
- emit(value) returns text or JSON to Pi; emitImage(result.screenshot) returns a screenshot; store is a persistent JSON object

Example:
const s = await win.snapshot({ vm: "Win11" });
emit(s.text);
emitImage(s.screenshot);

Batch known actions sequentially, then inspect again before deciding the next step. Only emit what you need: UI trees are long.`;

/** The description, naming the VMs a session limited by PI_WINDOWS_USE_VMS may use. */
export function toolDescription(allowed?: readonly string[]): string {
	if (!allowed?.length) return DESCRIPTION;
	const limit = allowed.length === 1
		? `This session may use only this VM: ${allowed[0]}. Calls may leave out vm; it defaults to "${allowed[0]}".`
		: `This session may use only these VMs: ${allowed.join(", ")}.`;
	const [head, ...rest] = DESCRIPTION.split("\n\n");
	return [head, limit, ...rest].join("\n\n");
}

export interface WindowsUseDeps {
	/** The VMs PI_WINDOWS_USE_VMS allows, when it is set. */
	readonly allowed?: readonly string[];
	readonly executor: Pick<CodeExecutor, "execute">;
	/** What recovery did during the last run. */
	readonly notes: () => string[];
	readonly status: () => Promise<string[]>;
	readonly close: () => void | Promise<void>;
}

function failure(result: CodeResult): Error {
	const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	const images = result.content.length - result.content.filter((block) => block.type === "text").length;
	return new Error(images > 0 ? `${text}\n(${images} emitted image${images === 1 ? "" : "s"} omitted)` : text);
}

function expandHint(theme: Theme): string {
	try { return keyHint("app.tools.expand", "to expand"); } catch {
		const paint = painter(theme);
		return `${paint.fg("dim", "ctrl+o")}${paint.fg("muted", " to expand")}`;
	}
}

function highlight(code: string): string[] {
	try { return highlightCode(code, "javascript"); } catch { return code.split("\n"); }
}

const hasCalls = (details: unknown): details is RowDetails => !!details && typeof details === "object" && Array.isArray((details as RowDetails).calls);

export function registerWindowsUse(pi: ExtensionAPI, deps: WindowsUseDeps): void {
	// Tool Display draws these rows with its band; the renderers below are for when it is off.
	pi.registerTool(markRow(defineTool({
		name: "windows_use",
		label: "Windows use",
		description: toolDescription(deps.allowed),
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript body to execute. Use await win.<method>({ vm, ... }), emit(value), emitImage(result.screenshot), and store for state shared across calls." }),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, onUpdate) {
			deps.notes();
			const result = await deps.executor.execute(params.code, {
				// No approvals: opting in with PI_WINDOWS_USE covers every VM it allows (PI_WINDOWS_USE_VMS, or all).
				approve: async () => "deny",
				signal,
				onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
			});
			const content = [...result.content, ...deps.notes().map((text) => ({ type: "text" as const, text }))];
			if (result.error) throw failure({ ...result, content });
			return { content, details: { calls: result.calls, durationMs: result.durationMs } };
		},
		renderCall: (args, theme, context) => renderCall(args, { title: "windows_use", expanded: context.expanded, paint: painter(theme), highlight, hint: expandHint(theme) }),
		renderResult: (result, options, theme, context) => {
			const state = context.state as { last?: RowDetails };
			if (hasCalls(result.details)) state.last = result.details;
			return renderResult(result, { started: "host", expanded: options.expanded, isError: context.isError, partial: options.isPartial, paint: painter(theme), hint: expandHint(theme), last: state.last });
		},
	}), "windows-use"));
	pi.registerCommand("windows-use", {
		description: "Windows use status: the host process and this host's Hyper-V VMs",
		handler: async (_args, ctx) => ctx.ui.notify((await deps.status()).join("\n"), "info"),
	});
	pi.on("session_shutdown", () => deps.close());
}

function powershellPath(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = `${dir}/powershell.exe`;
		if (dir && existsSync(candidate)) return candidate;
	}
	return existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : undefined;
}

export function productionDeps(): WindowsUseDeps {
	const script = fileURLToPath(new URL("./host.ps1", import.meta.url));
	const host = new HostSession({
		idleMs: IDLE_MS,
		launch: () => {
			const exe = powershellPath();
			if (!exe) throw new Error("windows_use needs powershell.exe through WSL interop (Windows PowerShell 5.1 on the Hyper-V host)");
			const windowsPath = execFileSync("wslpath", ["-w", script], { encoding: "utf8" }).trim();
			// A Windows working directory keeps Windows tools from warning about UNC paths.
			return spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsPath], {
				cwd: existsSync("/mnt/c/Windows") ? "/mnt/c/Windows" : undefined,
				stdio: ["pipe", "pipe", "pipe"],
			});
		},
	});
	const allowed = vmAllowlist(process.env);
	const session = new WinSession(host, undefined, allowed);
	return {
		allowed,
		executor: new CodeExecutor({ session, api: WIN_API }),
		notes: () => session.drainNotes(),
		close: () => host.close(),
		status: async () => {
			const exe = powershellPath();
			const lines = [exe ? `powershell.exe: ${exe}` : "powershell.exe: not found (needs WSL interop)", `host: ${host.state}`];
			if (allowed) lines.push(`limited to: ${allowed.join(", ")} (PI_WINDOWS_USE_VMS)`);
			if (!exe) return lines;
			try {
				const vms = session.visible(await host.call("vms") as { name: string; state: string; installed: boolean; ip?: string | null }[]);
				if (vms.length === 0) lines.push(allowed ? "None of those VMs is on this host" : "No Hyper-V VMs on this host");
				for (const vm of vms) lines.push(`${vm.name}: ${vm.state}${vm.ip ? ` ${vm.ip}` : ""}${vm.installed ? ", set up" : ""}`);
			} catch (error) {
				lines.push(`Hyper-V: ${error instanceof Error ? error.message : String(error)} (the Windows user needs to be in Hyper-V Administrators)`);
			}
			return lines;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	if (!windowsUseEnabled(process.platform, process.env, isWsl(process.env))) return;
	registerWindowsUse(pi, productionDeps());
}
