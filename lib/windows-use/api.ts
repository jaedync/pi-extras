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
import { readFrame, toPng } from "./frame.ts";
import { Guest, wait, type HostCalls } from "./guest.ts";
import { textResult } from "./result.ts";
import { compactSnapshot } from "./snapshot.ts";

export const GUEST_METHODS = ["snapshot", "screenshot", "click", "type", "scroll", "move", "key", "app", "wait_for", "powershell", "call"] as const;
export const CONSOLE_METHODS = ["console.screenshot", "console.click", "console.move", "console.drag", "console.scroll", "console.type", "console.key", "console.cad"] as const;
export const METHODS = ["vms", "sleep", "start", "login", "setup", ...GUEST_METHODS, ...CONSOLE_METHODS] as const;
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
			return { tool: args.tool, args: args.args && typeof args.args === "object" ? args.args as Args : {} };
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
const JSON_METHODS = new Set(["vms", "start"]);
/** How Windows-MCP's Clipboard get starts when the clipboard holds text. */
const CLIPBOARD_TEXT = "Clipboard content:\n";
const textOf = (result: ToolResult) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");

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

	constructor(host: HostCalls, makeGuest?: (vm: string, note: (text: string) => void) => Guest, allowed?: readonly string[]) {
		this.host = host;
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
			await wait(args.ms, signal);
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
			case "setup": await this.guest(vm).setup(signal); return textResult(`Windows-MCP is ready on ${vm}`);
			case "console.screenshot": {
				const frame = readFrame(await this.host.call("frame", { vm }, { signal }));
				return { content: [{ type: "text", text: JSON.stringify({ width: frame.width, height: frame.height }) }, { type: "image", data: toPng(frame).toString("base64"), mimeType: "image/png" }], isError: false };
			}
			case "console.click": number(method, args, "x", "y"); return this.console("click", { vm, x: args.x, y: args.y, button: args.button, double: args.double === true }, signal);
			case "console.move": number(method, args, "x", "y"); return this.console("move", { vm, x: args.x, y: args.y }, signal);
			case "console.drag": number(method, args, "x", "y", "x2", "y2"); return this.console("drag", { vm, x: args.x, y: args.y, x2: args.x2, y2: args.y2 }, signal);
			case "console.scroll": number(method, args, "x", "y"); return this.console("scroll", { vm, x: args.x, y: args.y, amount: args.amount }, signal);
			case "console.type":
				if (typeof args.text !== "string") throw new Error("win.console.type needs { vm, text }");
				return this.console("type", { vm, text: args.text }, signal, 120_000);
			case "console.key":
				if (typeof args.keys !== "string") throw new Error("win.console.key needs { vm, keys }");
				return this.console("key", { vm, keys: args.keys }, signal);
			case "console.cad": return this.console("cad", { vm }, signal);
			case "type":
				if (args.label === undefined && !hasPoint(args)) return this.typeAtFocus(vm, args, signal);
				return this.guestTool(vm, method, args, signal);
			default: return this.guestTool(vm, method, args, signal);
		}
	}

	private guestTool(vm: string, method: string, args: Args, signal?: AbortSignal): Promise<ToolResult> {
		const call = toMcp(method, args);
		return this.guest(vm).tool(call.tool, call.args, signal);
	}

	/**
	 * Types into whatever has focus. Windows-MCP's Type always clicks its target
	 * first, which moves the caret and drops a selection, and console typing
	 * arrives late (about 50 characters a second) and can lose shifted keys, so
	 * later input overtakes it. This pastes each line through Windows-MCP, in
	 * order with its other input, and presses Enter or Tab between them as
	 * typing would. Each Shortcut returns half a second after its keys, by which
	 * time the app has taken the paste, so the clipboard can change again.
	 */
	private async typeAtFocus(vm: string, args: Args, signal?: AbortSignal): Promise<ToolResult> {
		if (typeof args.text !== "string") throw new Error("win.type needs { vm, text }");
		const guest = this.guest(vm);
		const tool = (name: string, toolArgs: Args) => guest.tool(name, toolArgs, signal);
		const key = (shortcut: string) => tool("Shortcut", { shortcut });
		const saved = textOf(await tool("Clipboard", { mode: "get" }));
		const prior = saved.startsWith(CLIPBOARD_TEXT) ? saved.slice(CLIPBOARD_TEXT.length) : undefined;
		if (args.clear === true) { await key("ctrl+a"); await key("backspace"); }
		for (const part of args.text.split(/(\r?\n|\t)/)) {
			if (part === "\t") await key("tab");
			else if (part === "\n" || part === "\r\n") await key("enter");
			else if (part) { await tool("Clipboard", { mode: "set", text: part }); await key("ctrl+v"); }
		}
		const enter = args.enter === true || args.press_enter === true;
		if (enter) await key("enter");
		if (prior !== undefined) await tool("Clipboard", { mode: "set", text: prior });
		return textResult(`Typed ${args.text.length} characters into the focused control${enter ? ", then pressed Enter" : ""}.`);
	}

	private async console(method: string, params: Args, signal?: AbortSignal, timeoutMs?: number): Promise<ToolResult> {
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
