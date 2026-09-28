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

export const GUEST_METHODS = ["snapshot", "screenshot", "click", "type", "scroll", "move", "key", "app", "wait_for", "powershell", "call"] as const;
export const CONSOLE_METHODS = ["console.screenshot", "console.click", "console.move", "console.drag", "console.scroll", "console.type", "console.key", "console.cad"] as const;
export const METHODS = ["vms", "sleep", "start", "login", "setup", ...GUEST_METHODS, ...CONSOLE_METHODS] as const;
/** Longest win.sleep: long enough for a boot or sign-in to settle, short of hiding a hung script. */
const MAX_SLEEP_MS = 60_000;

type Args = Record<string, unknown>;

/** Drops unset values so Windows-MCP applies its own defaults. */
const defined = (args: Args): Args => Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
const without = (args: Args, ...keys: string[]): Args => Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)));
/** A UI element's label from the last snapshot, or screen coordinates. */
const target = (args: Args): Args => args.label !== undefined ? { label: args.label } : typeof args.x === "number" && typeof args.y === "number" ? { loc: [args.x, args.y] } : {};

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
		case "powershell": return { tool: "PowerShell", args: defined({ command: args.command, timeout: args.timeout }) };
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

export const WIN_API: ScriptApi = {
	tool: "windows_use",
	global: "win",
	methods: METHODS,
	label: "Windows",
	imageHint: "win.snapshot, win.screenshot or win.console.screenshot",
	describe: describeWinCall,
	value(method, _args, result, keep) {
		const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		if (IMAGE_METHODS.has(method)) {
			const image = result.content.find((block) => block.type === "image");
			const lines = result.content.flatMap((block) => block.type === "text" ? [unlist(block.text)] : []).join("\n");
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

	constructor(host: HostCalls, makeGuest?: (vm: string, note: (text: string) => void) => Guest) {
		this.host = host;
		this.makeGuest = makeGuest ?? ((vm, note) => new Guest({ host, vm, note }));
	}

	/** What recovery did since the last drain, for the agent to read. */
	drainNotes(): string[] {
		const notes = this.notes;
		this.notes = [];
		return notes;
	}

	async call(method: string, args: Args, options: Pick<CallOptions, "signal">): Promise<ToolResult> {
		const { signal } = options;
		if (method === "vms") return json(await this.host.call("vms", {}, { signal }));
		if (method === "sleep") {
			if (typeof args.ms !== "number" || !Number.isFinite(args.ms) || args.ms < 0) throw new Error("win.sleep needs { ms } (milliseconds)");
			if (args.ms > MAX_SLEEP_MS) throw new Error(`win.sleep waits at most ${MAX_SLEEP_MS} ms; to wait on the guest, use win.wait_for`);
			await wait(args.ms, signal);
			return textResult("ok");
		}
		const vm = requireVm(method, args);
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
			default: {
				const call = toMcp(method, args);
				return this.guest(vm).tool(call.tool, call.args, signal);
			}
		}
	}

	private async console(method: string, params: Args, signal?: AbortSignal, timeoutMs?: number): Promise<ToolResult> {
		await this.host.call(method, defined(params), { signal, timeoutMs });
		// Console input can lock, sign out or sign in behind recovery's back.
		if (typeof params.vm === "string") this.guests.get(params.vm)?.recheck();
		return textResult("ok");
	}

	private guest(vm: string): Guest {
		let guest = this.guests.get(vm);
		if (!guest) {
			guest = this.makeGuest(vm, (text) => this.notes.push(text));
			this.guests.set(vm, guest);
		}
		return guest;
	}
}
