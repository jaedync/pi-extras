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
import { Guest } from "./guest.ts";
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

Guest methods run through Windows-MCP inside the VM (UI Automation tree, input, PowerShell). Every method takes { vm: "<VM name>" }. Each call checks the server's live Windows session. In an enhanced VM Connect/RDP session, guest methods act in that same visible desktop, never the separate console. Keep the intended VM Connect window open and visible. Locked or disconnected remote sessions need the user to reconnect/unlock there; never switch sessions to work around an error. Initial setup needs a visible basic-session desktop; enhanced sessions need Windows-MCP already installed and reachable.
- win.vms() -> [{ name, state, running, installed, ip }]: the VMs this session may use
- win.snapshot({ vm, use_vision?, use_ui_tree?, use_dom? }) -> { text, screenshot }: text lists the windows, then the UI tree: one element per line with its (x, y) center, type, "name" and state, indented under its container. A window with nothing under it draws its own controls: read it with win.console.ocr. use_dom: true lists a browser page's elements instead. A line past 2,000 characters (a document's whole text) is cut; read files with win.powershell. A window whose app stops answering stalls the tree: the snapshot fails after 30 s naming that window (Start and its search are restarted and the snapshot taken again)
- win.screenshot({ vm }) -> { text, screenshot }: fast, no UI tree
- win.click({ vm, x, y, button?: "left"|"right"|"middle", clicks? }). Some windows ignore Windows-MCP's clicks, such as Start's menus and apps running as administrator: in a confirmed basic/console session only, win.console.click at the same point clicks as a real mouse would. In an enhanced session console input is refused; don't fall back to it
- win.type({ vm, text, x?, y?, clear?, enter? }): with x, y it clicks there first, then types (any text); without, it types into the focused control by pasting, restoring the clipboard after. "\\n" presses Enter and "\\t" Tab, as typing would. clear: true replaces the field's text; enter: true presses Enter after
- win.scroll({ vm, x?, y?, direction?: "up"|"down"|"left"|"right", amount?, horizontal? })
- win.move({ vm, x, y, drag?, from?: [x, y] })
- win.key({ vm, keys }): e.g. "ctrl+c", "win+r", "enter"
- win.app({ vm, mode?: "launch"|"switch"|"resize", name }): launch takes a Start menu app's name, or words only it has ("edge"), which is quicker and surer than Start search; a name no app has fails naming the nearest, and nothing starts. switch brings an open window to the front
- win.wait_for({ vm, condition, text?, window_name?, timeout? })
- win.powershell({ vm, command, timeout? }) -> { output, status }: output is stdout (stderr when stdout is empty), status the exit code; runs as the signed-in user; timeout in seconds, default 30, at most 540
- win.call({ vm, tool, args }): any other Windows-MCP tool (Clipboard, Process, FileSystem, Registry, Scrape, MultiSelect, MultiEdit, Wait); args is an object, and a wrong tool name or argument lists them all with their arguments. Scrape with { url } fetches a page's text from the guest; with { url, use_dom: true } it reads the browser tab in front
Windows-MCP runs without administrator rights, so a window of an app running as administrator (one that raised a UAC prompt) shows no elements, and Windows-MCP's clicks and keys to it are dropped without an error, as are its keys while such a window has focus. Snapshots mark these windows. Read them with win.console.ocr. Only in a confirmed basic/console session can win.console.click, win.console.key and win.console.type reach them; in an enhanced session ask the user to act on an elevated window that drops guest input.
Console input drives only a confirmed basic/console desktop. It is refused for enhanced/remote sessions, and for ambiguous sign-in screens while the server is unavailable, even through win.login or win.setup. No blind sign-in or Run-box repair is attempted. Read-only console screenshots/OCR adapt to an enhanced session by using Windows-MCP's image instead; they never fall back to the separate console if that capture fails. Only a confirmed console display may be woken with Shift.
- win.console.screenshot({ vm }) -> { text: JSON metadata, screenshot }: width/height are image pixels. Enhanced captures also report source: "guest", session, x/y origin, screenWidth/screenHeight, scaleX/scaleY. Screen point = origin + image point * scale
- win.console.ocr({ vm, x?, y?, width?, height? }) -> { text, items: [{ text, x, y }] }: the screen's text through Windows OCR, one "(x,y) text" per line, each center already in desktop pixels, including downscaling and monitor offsets. Use win.click; win.console.click is only available at the console. It reads what the UI tree can't: custom-drawn windows, MMC consoles, UAC and sign-in screens. x, y, width and height limit it to a rectangle
- win.console.click({ vm, x, y, button?, double? }), win.console.move/drag({ vm, x, y, x2?, y2? }), win.console.scroll({ vm, x, y, amount? }) (amount: wheel notches, negative down, default -3)
- win.console.type({ vm, text }) (US keyboard layout; "\\n" presses Enter), win.console.key({ vm, keys }), win.console.cad({ vm })
- win.uac({ vm, answer: "yes"|"no" }) answers a UAC prompt only at a freshly confirmed console. In an enhanced session the user must answer in VM Connect; console UAC keys cannot reach that secure desktop. It never types a password. A synchronous PowerShell Start-Process -Verb RunAs may wait for consent and time out; don't repeat it blindly
- win.start({ vm }) starts or resumes a VM; win.login({ vm }) unlocks a freshly confirmed console session only; win.setup({ vm }) reinstalls Windows-MCP only on a confirmed console desktop. Neither overrides session protection. A PI_WINDOWS_USE_ELEVATED mismatch in an enhanced session is reported, never repaired through the console
- win.sleep(ms) pauses up to 60 s, e.g. for the screen to settle between console steps
- emit(value) returns text or JSON to Pi; emitImage(result.screenshot) returns a screenshot; store is a persistent JSON object

Example:
const s = await win.snapshot({ vm: "Win11" });
emit(s.text);
emitImage(s.screenshot);

Batch known actions sequentially, then inspect again before deciding the next step. Only emit what you need: UI trees are long, so filter s.text in the script when you know what you are looking for.`;

const LIMITED_RIGHTS = /^Windows-MCP runs without administrator rights, .*$/m;
const ELEVATED_RIGHTS = "Windows-MCP runs with administrator rights (PI_WINDOWS_USE_ELEVATED): win.powershell and the apps win.app launches run as administrator, and Windows-MCP's clicks and keys reach apps running as administrator. Their UI trees may still fail: in testing a snapshot crashed Event Viewer's log view and stalled on Services, so ask win.powershell for what such consoles show (Get-WinEvent, Get-Service) or read them with win.console.ocr.";

/**
 * The description, naming the VMs a session limited by PI_WINDOWS_USE_VMS may
 * use, and what Windows-MCP can reach with the rights PI_WINDOWS_USE_ELEVATED gives it.
 */
export function toolDescription(allowed?: readonly string[], elevated = false): string {
	const description = elevated ? DESCRIPTION.replace(LIMITED_RIGHTS, ELEVATED_RIGHTS) : DESCRIPTION;
	if (!allowed?.length) return description;
	const limit = allowed.length === 1
		? `This session may use only this VM: ${allowed[0]}. Calls may leave out vm; it defaults to "${allowed[0]}".`
		: `This session may use only these VMs: ${allowed.join(", ")}.`;
	const [head, ...rest] = description.split("\n\n");
	return [head, limit, ...rest].join("\n\n");
}

export interface WindowsUseDeps {
	/** The VMs PI_WINDOWS_USE_VMS allows, when it is set. */
	readonly allowed?: readonly string[];
	/** Windows-MCP runs with administrator rights (PI_WINDOWS_USE_ELEVATED). */
	readonly elevated?: boolean;
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

type Content = CodeResult["content"];

/** Pi would swap the images for a placeholder for a text-only model; saying so once is clearer and skips the bytes. */
export function forModel(content: Content, model?: { readonly input: readonly string[] }): Content {
	const images = content.filter((block) => block.type === "image").length;
	if (!model || model.input.includes("image") || images === 0) return content;
	const note = `(${images} emitted image${images === 1 ? "" : "s"} left out: the current model doesn't take images. Read win.snapshot's text or win.console.ocr instead.)`;
	return [...content.filter((block) => block.type !== "image"), { type: "text", text: note }];
}

const hasCalls = (details: unknown): details is RowDetails => !!details && typeof details === "object" && Array.isArray((details as RowDetails).calls);

export function registerWindowsUse(pi: ExtensionAPI, deps: WindowsUseDeps): void {
	// Tool Display draws these rows with its band; the renderers below are for when it is off.
	pi.registerTool(markRow(defineTool({
		name: "windows_use",
		label: "Windows use",
		description: toolDescription(deps.allowed, deps.elevated),
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript body to execute. Use await win.<method>({ vm, ... }), emit(value), emitImage(result.screenshot), and store for state shared across calls." }),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, onUpdate, ctx) {
			deps.notes();
			const result = await deps.executor.execute(params.code, {
				// No approvals: opting in with PI_WINDOWS_USE covers every VM it allows (PI_WINDOWS_USE_VMS, or all).
				approve: async () => "deny",
				signal,
				onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
			});
			const content = forModel([...result.content, ...deps.notes().map((text) => ({ type: "text" as const, text }))], ctx?.model);
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
	const elevated = ENABLED.has((process.env.PI_WINDOWS_USE_ELEVATED ?? "").trim().toLowerCase());
	const session = new WinSession(host, (vm, note) => new Guest({ host, vm, note, elevated }), allowed);
	return {
		allowed,
		elevated,
		executor: new CodeExecutor({ session, api: WIN_API }),
		notes: () => session.drainNotes(),
		close: () => host.close(),
		status: async () => {
			const exe = powershellPath();
			const lines = [exe ? `powershell.exe: ${exe}` : "powershell.exe: not found (needs WSL interop)", `host: ${host.state}`];
			if (allowed) lines.push(`limited to: ${allowed.join(", ")} (PI_WINDOWS_USE_VMS)`);
			if (elevated) lines.push("Windows-MCP runs with administrator rights (PI_WINDOWS_USE_ELEVATED)");
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
