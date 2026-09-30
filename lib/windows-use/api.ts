/**
 * The `win` object windows_use scripts call, and the session that carries each
 * call out. Guest methods go to Windows-MCP inside the VM (UI Automation tree,
 * input, PowerShell); `win.console.*` drives the VM's screen, keyboard and
 * mouse from the host through Hyper-V, which also works on lock, sign-in and
 * UAC screens where Windows-MCP can't.
 */
import { clean, type CallTarget } from "../computer-use/describe.ts";
import type { ScriptApi } from "../computer-use/executor.ts";
import type { CallOptions, ToolResult } from "../computer-use/session.ts";
import type { Region } from "./ocr.ts";
import { Display } from "./display.ts";
import { Guest, wait, type HostCalls } from "./guest.ts";
import { answerUac, captureFailure, checkAltF4, SCREEN_GRAB_FAILED, typeAtFocus } from "./guest-input.ts";
import { textOf, textResult } from "./result.ts";
import { pickApp, START_APPS } from "./apps.ts";
import { compactSnapshot } from "./snapshot.ts";

export const GUEST_METHODS = ["snapshot", "screenshot", "click", "type", "scroll", "move", "key", "app", "wait_for", "powershell", "call"] as const;
export const CONSOLE_METHODS = ["console.screenshot", "console.ocr", "console.click", "console.move", "console.drag", "console.scroll", "console.type", "console.key", "console.cad"] as const;
export const METHODS = ["vms", "sleep", "start", "login", "setup", "uac", ...GUEST_METHODS, ...CONSOLE_METHODS] as const;
/** Longest win.sleep: long enough for a boot or sign-in to settle, short of hiding a hung script. */
const MAX_SLEEP_MS = 60_000;
/** Longest PowerShell timeout, in seconds: the guest's reply must arrive inside the host's 10-minute call limit. */
const MAX_SHELL_TIMEOUT_S = 540;

type Args = Record<string, unknown>;

/** Drops unset values so Windows-MCP applies its own defaults. */
const defined = (args: Args): Args => Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
const without = (args: Args, ...keys: string[]): Args => Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)));
/** Screen coordinates, or a Windows-MCP element index (its snapshot text doesn't show them, so scripts rarely can). */
const target = (args: Args): Args => args.label !== undefined ? { label: args.label } : hasPoint(args) ? { loc: [args.x, args.y] } : {};
const hasPoint = (args: Args) => typeof args.x === "number" && typeof args.y === "number";

/** The Windows-MCP tool and arguments behind a guest method. */
export function toMcp(method: string, args: Args): { tool: string; args: Args } {
	const rest = without(args, "vm");
	switch (method) {
		case "snapshot": return { tool: "Snapshot", args: { use_vision: true, ...rest } };
		case "screenshot": return { tool: "Screenshot", args: rest };
		case "click": return { tool: "Click", args: defined({ ...target(args), button: args.button, clicks: args.clicks }) };
		case "type": return { tool: "Type", args: defined({ text: args.text, ...target(args), clear: args.clear, press_enter: args.enter ?? args.press_enter, caret_position: args.caret }) };
		case "scroll": return { tool: "Scroll", args: defined({ ...target(args), direction: args.direction, wheel_times: args.amount, type: args.horizontal === true ? "horizontal" : undefined }) };
		case "move": return { tool: "Move", args: defined({ ...target(args), drag: args.drag, from_loc: args.from }) };
		case "key": return { tool: "Shortcut", args: { shortcut: args.keys } };
		case "app": return { tool: "App", args: rest };
		case "wait_for": return { tool: "WaitFor", args: rest };
		case "powershell":
			if (typeof args.timeout === "number" && args.timeout > MAX_SHELL_TIMEOUT_S) throw new Error(`win.powershell waits at most ${MAX_SHELL_TIMEOUT_S} seconds; start longer work with Start-Process or Start-Job and check on it in later calls`);
			return { tool: "PowerShell", args: defined({ command: args.command, timeout: args.timeout }) };
		case "call": {
			if (typeof args.tool !== "string" || !args.tool) throw new Error("win.call needs { vm, tool, args }");
			if (args.args !== undefined && (!args.args || typeof args.args !== "object" || Array.isArray(args.args))) throw new Error("win.call's args must be an object of the tool's arguments, such as { url: \"https://example.com\" }");
			return { tool: args.tool, args: (args.args ?? {}) as Args };
		}
		default: throw new Error(`unknown method win.${method}`);
	}
}

const point = (args: Args, x = "x", y = "y") => typeof args[x] === "number" && typeof args[y] === "number" ? `(${args[x]}, ${args[y]})` : "";
const where = (args: Args) => args.label !== undefined ? `#${clean(args.label, 12)}` : point(args);
const quote = (value: unknown) => value === undefined ? "" : `"${clean(value)}"`;

function detail(method: string, args: Args): string[] {
	switch (method) {
		case "sleep": return [typeof args.ms === "number" ? `${args.ms} ms` : ""];
		case "click": return [where(args), typeof args.button === "string" && args.button !== "left" ? clean(args.button, 8) : "", typeof args.clicks === "number" && args.clicks > 1 ? `×${args.clicks}` : ""];
		case "type": return [where(args), quote(args.text), args.enter === true ? "↵" : ""];
		case "scroll": return [where(args), clean(args.direction, 8)];
		case "move": return [where(args), args.drag === true ? "drag" : ""];
		case "key": return [clean(args.keys, 32)];
		case "app": return [clean(args.mode, 12), clean(args.name, 32)];
		case "wait_for": return [clean(args.condition, 16), quote(args.text)];
		case "powershell": return [clean(args.command, 60)];
		case "call": return [clean(args.tool, 24)];
		case "console.click": return [point(args), typeof args.button === "string" && args.button !== "left" ? clean(args.button, 8) : "", args.double === true ? "×2" : ""];
		case "console.ocr": return [typeof args.width === "number" ? `${point(args)} ${args.width}×${args.height}` : ""];
		case "console.move": return [point(args)];
		case "console.drag": return [`${point(args)} → ${point(args, "x2", "y2")}`];
		case "console.scroll": return [point(args)];
		case "console.type": return [quote(args.text)];
		case "console.key": return [clean(args.keys, 32)];
		default: return [];
	}
}

export function describeWinCall(method: string, args: Args): CallTarget {
	const vm = typeof args.vm === "string" ? clean(args.vm, 40) || undefined : undefined;
	return { app: vm, detail: detail(method, args).filter(Boolean).join(" ") };
}

const IMAGE_METHODS = new Set(["snapshot", "screenshot", "console.screenshot"]);

/** Windows-MCP sends some snapshots as a JSON list of strings; escaped newlines read badly and cost tokens. */
function unlist(text: string): string {
	if (!text.startsWith("[")) return text;
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed.join("\n") : text;
	} catch {
		return text;
	}
}
/** UI Automation's "an event was unable to invoke any of the subscribers" (0x80040201), which App's wait for a new window can hit. */
const UIA_EVENT_FAILED = /-2147220991|unable to invoke any of the subscribers/;
const firstLine = (text: string) => text.split("\n")[0]!.trim();

/** Windows-MCP refusing a call it can't match to a tool or the tool's arguments. */
const TOOL_MISUSE = /^Unknown tool|validation error/i;

/**
 * win.call: any Windows-MCP tool by name. Agents guess at names and arguments
 * the description doesn't list, so a refusal comes back with the server's own
 * list of tools and their arguments.
 */
async function anyTool(guest: Guest, tool: string, args: Args, signal?: AbortSignal): Promise<ToolResult> {
	let refusal: string;
	try {
		const result = await guest.tool(tool, args, signal);
		if (!result.isError || !TOOL_MISUSE.test(textOf(result))) return result;
		refusal = textOf(result);
	} catch (error) {
		if (!(error instanceof Error) || !TOOL_MISUSE.test(error.message)) throw error;
		refusal = error.message;
	}
	const reason = refusal.replace(/\s*For further information[\s\S]*$/, "").replace(/\s+/g, " ").trim();
	const tools = await guest.tools(signal).then(toolSignatures, () => "");
	throw new Error(tools ? `${reason}. Windows-MCP's tools (? marks optional arguments): ${tools}` : reason);
}

/** "Name(required, optional?)" for each tool Windows-MCP lists, by name. */
function toolSignatures(tools: readonly { name?: unknown; inputSchema?: { properties?: Record<string, unknown>; required?: readonly unknown[] } }[]): string {
	return tools
		.filter((tool): tool is typeof tool & { name: string } => typeof tool.name === "string")
		.map((tool) => {
			const required = new Set(tool.inputSchema?.required ?? []);
			const params = Object.keys(tool.inputSchema?.properties ?? {}).filter((name) => name !== "ctx");
			const ordered = [...params.filter((name) => required.has(name)), ...params.filter((name) => !required.has(name)).map((name) => `${name}?`)];
			return `${tool.name}(${ordered.join(", ")})`;
		})
		.sort()
		.join(", ");
}

/** The lock screen in front, as a snapshot's window table names it. */
const LOCK_SCREEN = /Focused Window:\s*\n[^\n]*\n-[- ]*\n\s*Windows Default Lock Screen\s/;
const JSON_METHODS = new Set(["vms", "start", "console.ocr"]);

/** Windows-MCP wraps PowerShell output as "Response: <stdout, or stderr when stdout is empty>\nStatus Code: <exit code>". */
function shellResult(text: string): { output: string; status: number | null } {
	const match = /^Response: ?([\s\S]*?)\r?\nStatus Code: (-?\d+)\s*$/.exec(text);
	// Format-Table pads every line; the padding costs tokens and says nothing.
	const tidy = (value: string) => value.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/^\n+/, "").trimEnd();
	return match ? { output: tidy(match[1]!), status: Number(match[2]) } : { output: tidy(text), status: null };
}

export const WIN_API: ScriptApi = {
	tool: "windows_use",
	global: "win",
	methods: METHODS,
	label: "Windows",
	imageHint: "win.snapshot, win.screenshot or win.console.screenshot",
	describe: describeWinCall,
	args(method, raw) {
		if (method === "sleep" && typeof raw === "number") return { ms: raw };
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Args : {};
	},
	value(method, _args, result, keep) {
		const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		if (method === "powershell") return shellResult(text);
		if (IMAGE_METHODS.has(method)) {
			const image = result.content.find((block) => block.type === "image");
			const lines = result.content.flatMap((block) => block.type === "text" ? [compactSnapshot(unlist(block.text))] : []).join("\n");
			return { text: lines, screenshot: image && image.type === "image" ? keep(image) : null };
		}
		if (JSON_METHODS.has(method)) {
			try { return JSON.parse(text); } catch { return text; }
		}
		return text || null;
	},
};

function requireVm(method: string, args: Args): string {
	if (typeof args.vm !== "string" || !args.vm.trim()) throw new Error(`win.${method} needs { vm: "<Hyper-V VM name>" }; win.vms() lists them`);
	return args.vm;
}

/**
 * The VMs named in PI_WINDOWS_USE_VMS (comma-separated, as written); undefined
 * when unset, meaning every VM on the host. Names match case-insensitively, as in Hyper-V.
 */
export function vmAllowlist(env: Readonly<Record<string, string | undefined>>): readonly string[] | undefined {
	const names = (env.PI_WINDOWS_USE_VMS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
	return names.length > 0 ? names : undefined;
}

/** The rectangle a console.ocr call names, if it names one. */
function region(args: Args): Region | undefined {
	const keys = ["x", "y", "width", "height"] as const;
	const given = keys.filter((key) => args[key] !== undefined);
	if (given.length === 0) return undefined;
	if (given.length < keys.length || !keys.every((key) => typeof args[key] === "number" && Number.isFinite(args[key]))) {
		throw new Error("win.console.ocr needs x, y, width and height together, as numbers, or none of them for the whole screen");
	}
	return { x: args.x as number, y: args.y as number, width: args.width as number, height: args.height as number };
}

function number(method: string, args: Args, ...keys: string[]): void {
	for (const key of keys) if (typeof args[key] !== "number" || !Number.isFinite(args[key])) throw new Error(`win.${method} needs a number for ${key}`);
}

const json = (value: unknown) => textResult(JSON.stringify(value, null, 2));

/** Carries out `win` calls: host methods directly, guest methods through a Guest per VM. */
export class WinSession {
	private readonly host: HostCalls;
	private readonly guests = new Map<string, Guest>();
	private readonly makeGuest: (vm: string, note: (text: string) => void) => Guest;
	private notes: string[] = [];

	/** When set, the only VMs this session may list or act on, as written in PI_WINDOWS_USE_VMS. */
	private readonly allowed?: readonly string[];
	private readonly allowedKeys?: ReadonlySet<string>;

	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(host: HostCalls, makeGuest?: (vm: string, note: (text: string) => void) => Guest, allowed?: readonly string[], sleep = wait) {
		this.host = host;
		this.sleep = sleep;
		this.makeGuest = makeGuest ?? ((vm, note) => new Guest({ host, vm, note }));
		this.allowed = allowed;
		this.allowedKeys = allowed ? new Set(allowed.map((name) => name.toLowerCase())) : undefined;
	}

	/** Host VM entries this session may see. */
	visible<T extends { name: string }>(vms: readonly T[]): T[] {
		return vms.filter((vm) => !this.allowedKeys || this.allowedKeys.has(vm.name.toLowerCase()));
	}

	/** The VM a call names, or the only one this session may use when it names none. */
	private vmOf(method: string, args: Args): string {
		if (args.vm === undefined && this.allowed?.length === 1) return this.allowed[0]!;
		return requireVm(method, args);
	}

	private permit(vm: string): void {
		if (!this.allowedKeys || this.allowedKeys.has(vm.trim().toLowerCase())) return;
		throw new Error(`"${vm}" is not a VM this session may use (PI_WINDOWS_USE_VMS: ${this.allowed!.join(", ")}); win.vms() lists the ones it may`);
	}

	/** What recovery did since the last drain, for the agent to read. */
	drainNotes(): string[] {
		const notes = this.notes;
		this.notes = [];
		return notes;
	}

	async call(method: string, args: Args, options: Pick<CallOptions, "signal">): Promise<ToolResult> {
		const { signal } = options;
		if (method === "vms") return json(this.visible(await this.host.call("vms", {}, { signal }) as { name: string }[]));
		if (method === "sleep") {
			if (typeof args.ms !== "number" || !Number.isFinite(args.ms) || args.ms < 0) throw new Error("win.sleep needs { ms } (milliseconds)");
			if (args.ms > MAX_SLEEP_MS) throw new Error(`win.sleep waits at most ${MAX_SLEEP_MS} ms; to wait on the guest, use win.wait_for`);
			await this.sleep(args.ms, signal);
			return textResult("ok");
		}
		const vm = this.vmOf(method, args);
		this.permit(vm);
		switch (method) {
			case "start": {
				const status = await this.host.call("start", { vm }, { signal, timeoutMs: 180_000 });
				this.guest(vm).forget();
				return json(status);
			}
			case "login": await this.guest(vm).login(signal); return textResult(`signed in at ${vm}'s console`);
			case "uac": return answerUac(this.guest(vm), this.host, args.answer, this.sleep, signal);
			case "setup": await this.guest(vm).setup(signal); return textResult(`Windows-MCP is ready on ${vm}`);
			case "console.screenshot":
			case "console.ocr": return new Display({ host: this.host, guest: this.guest(vm), sleep: this.sleep,
				capture: () => this.guestTool(vm, "screenshot", {}, signal), note: (text) => this.notes.push(text),
			}).read(method, method === "console.ocr" ? region(args) : undefined, signal);
			case "console.click": number(method, args, "x", "y"); return this.console("click", { vm, x: args.x, y: args.y, button: args.button, double: args.double === true }, signal);
			case "console.move": number(method, args, "x", "y"); return this.console("move", { vm, x: args.x, y: args.y }, signal);
			case "console.drag": number(method, args, "x", "y", "x2", "y2"); return this.console("drag", { vm, x: args.x, y: args.y, x2: args.x2, y2: args.y2 }, signal);
			case "console.scroll": number(method, args, "x", "y"); return this.console("scroll", { vm, x: args.x, y: args.y, amount: args.amount }, signal);
			case "console.type":
				if (typeof args.text !== "string") throw new Error("win.console.type needs { vm, text }");
				return this.console("type", { vm, text: args.text }, signal, 120_000);
			case "console.key": {
				if (typeof args.keys !== "string") throw new Error("win.console.key needs { vm, keys }");
				// Console keys also serve lock and sign-in screens, where the guest can't be asked what is in front.
				const guest = this.guests.get(vm.toLowerCase());
				if (guest?.ready()) await checkAltF4(guest, args.keys, signal);
				return this.console("key", { vm, keys: args.keys }, signal);
			}
			case "console.cad": return this.console("cad", { vm }, signal);
			case "type":
				if (args.label === undefined && !hasPoint(args)) return typeAtFocus(this.guest(vm), args, signal);
				return this.guestTool(vm, method, args, signal);
			case "app":
				if ((args.mode ?? "launch") !== "launch" || typeof args.name !== "string" || args.executable !== undefined) return this.guestTool(vm, method, args, signal);
				return this.guestTool(vm, method, { ...args, name: await this.startApp(vm, args.name, signal) }, signal);
			default: return this.guestTool(vm, method, args, signal);
		}
	}

	/** The Start menu app `name` means, by the guest's list; the name as given if the list can't be read. */
	private async startApp(vm: string, name: string, signal?: AbortSignal): Promise<string> {
		const result = await this.guest(vm).tool("PowerShell", { command: START_APPS }, signal);
		const listed = result.isError ? [] : shellResult(textOf(result)).output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		return listed.length ? pickApp(name, listed) : name;
	}

	private async guestTool(vm: string, method: string, args: Args, signal?: AbortSignal): Promise<ToolResult> {
		const call = toMcp(method, args);
		const guest = this.guest(vm);
		if (method === "call") return anyTool(guest, call.tool, call.args, signal);
		if (method === "key") await checkAltF4(guest, args.keys, signal);
		const result = await guest.tool(call.tool, call.args, signal);
		if (method === "app" && result.isError && UIA_EVENT_FAILED.test(textOf(result)) && (args.mode ?? "launch") === "launch") {
			throw new Error(`${String(args.name)} may have opened: Windows-MCP started it, then failed to find its window through UI Automation (${firstLine(textOf(result))}). Take a snapshot before launching it again.`);
		}
		if (!IMAGE_METHODS.has(method)) return result;
		if (LOCK_SCREEN.test(unlist(textOf(result)))) {
			// Locked since the last lock check: check again, which signs in, and look again.
			guest.recheck();
			return guest.tool(call.tool, call.args, signal);
		}
		// Windows-MCP answers with a line of text; an empty tree would read as an empty screen.
		if (!SCREEN_GRAB_FAILED.test(textOf(result))) return result;
		const failure = await captureFailure(guest, signal);
		if (failure.uac || guest.where() === "remote") throw new Error(failure.message);
		// A lock since the last check stops a capture too; the next call checks, signing in first.
		const again = await guest.tool(call.tool, call.args, signal);
		if (SCREEN_GRAB_FAILED.test(textOf(again))) throw new Error(failure.message);
		return again;
	}

	private async console(method: string, params: Args, signal?: AbortSignal, timeoutMs?: number): Promise<ToolResult> {
		await this.guest(String(params.vm)).assertConsole(signal);
		await this.host.call(method, defined(params), { signal, timeoutMs });
		// Console input can lock, sign out or sign in behind recovery's back.
		if (typeof params.vm === "string") this.guests.get(params.vm.toLowerCase())?.recheck();
		return textResult("ok");
	}

	/** One Guest per VM, however the script capitalizes its name, so recovery state isn't split. */
	private guest(vm: string): Guest {
		let guest = this.guests.get(vm.toLowerCase());
		if (!guest) {
			guest = this.makeGuest(vm, (text) => this.notes.push(text));
			this.guests.set(vm.toLowerCase(), guest);
		}
		return guest;
	}
}
