/**
 * Guest input that needs more than one Windows-MCP call: typing into whatever
 * has focus, and answering UAC prompts, which show on the secure desktop where
 * Windows-MCP can neither see nor act.
 */
import type { ToolResult } from "../computer-use/session.ts";
import type { Guest, HostCalls } from "./guest.ts";
import { textOf, textResult } from "./result.ts";
import { FRONT_WINDOW, readFront } from "./stall.ts";

type Args = Record<string, unknown>;
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** How Windows-MCP's Clipboard get starts when the clipboard holds text. */
const CLIPBOARD_TEXT = "Clipboard content:\n";
/** consent.exe draws UAC prompts; it runs only while one is up. */
const UAC_CHECK = "$me = (Get-Process -Id $PID).SessionId; @(Get-Process consent -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me }).Count";
/** Windows-MCP's snapshot and screenshot text when the screen can't be read, as on the secure desktop. */
export const SCREEN_GRAB_FAILED = /screen grab failed/i;
const UAC_POLL_MS = 500;
/** A consent prompt closes within a second of its answer; one still up after this wants more than a key. */
const UAC_CLOSE_MS = 5_000;

/**
 * Types into whatever has focus. Windows-MCP's Type always clicks its target
 * first, which moves the caret and drops a selection, and console typing
 * arrives late (about 50 characters a second) and can lose shifted keys, so
 * later input overtakes it. This pastes each line through Windows-MCP, in
 * order with its other input, and presses Enter or Tab between them as
 * typing would. Each Shortcut returns half a second after its keys, by which
 * time the app has taken the paste, so the clipboard can change again.
 */
export async function typeAtFocus(guest: Guest, args: Args, signal?: AbortSignal): Promise<ToolResult> {
	if (typeof args.text !== "string") throw new Error("win.type needs { vm, text }");
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

/** Alt+F4 closes the window in front; with the desktop or taskbar there, it opens Shut Down Windows, an Enter away from turning the VM off. */
const CLOSE_WINDOW = /^\s*alt\s*\+\s*f4\s*$/i;
/** Explorer's desktop ("Program Manager") and taskbar (untitled), as opposed to its folder windows. */
const SHELL_TITLES = new Set(["", "Program Manager"]);

/** Refuses Alt+F4 while the desktop or taskbar is in front, as after a switch that didn't take. */
export async function checkAltF4(guest: Guest, keys: unknown, signal?: AbortSignal): Promise<void> {
	if (typeof keys !== "string" || !CLOSE_WINDOW.test(keys)) return;
	const front = readFront(textOf(await guest.tool("PowerShell", { command: FRONT_WINDOW }, signal)));
	if (front?.process.toLowerCase() !== "explorer" || !SHELL_TITLES.has(front.title)) return;
	throw new Error(`Alt+F4 wasn't sent to ${guest.vm}: the desktop or taskbar is in front, where it opens Shut Down Windows. Bring the window to close to the front first (a click on it, or win.app with mode "switch"), check with a snapshot, or click its Close button.`);
}

export async function uacShowing(guest: Guest, signal?: AbortSignal): Promise<boolean> {
	const text = textOf(await guest.tool("PowerShell", { command: UAC_CHECK }, signal));
	return /Response: *[1-9]/.test(text);
}

/** Why a snapshot came back empty, for the error that replaces it. */
export async function captureFailure(guest: Guest, signal?: AbortSignal): Promise<{ readonly uac: boolean; readonly message: string }> {
	// Whatever took the screen may also have locked it.
	guest.recheck();
	const vm = guest.vm;
	const uac = await uacShowing(guest, signal);
	if (guest.where() === "remote") {
		return { uac, message: `Windows-MCP couldn't capture ${vm}'s enhanced/remote session${uac ? ": a UAC prompt is on its secure desktop" : "; it may be minimized, locked, disconnected, or on a secure desktop"}. Restore the same VM Connect window${uac ? " and answer the prompt there" : " and check that its desktop is visible"}, then retry. The separate console was left alone.` };
	}
	if (uac) {
		return { uac: true, message: `A UAC prompt is showing on ${vm}, on the secure desktop where Windows-MCP can't see or act. Answer it with win.uac({ vm: ${JSON.stringify(vm)}, answer: "yes" }) or "no".` };
	}
	return { uac: false, message: `Windows-MCP couldn't capture ${vm}'s screen; the secure desktop may be up (Ctrl+Alt+Del or a credential prompt). win.console.screenshot({ vm: ${JSON.stringify(vm)} }) shows the console.` };
}

/**
 * Answers a UAC consent prompt with the console keyboard, which reaches the
 * secure desktop, then waits for it to close. It never types a password: a
 * prompt that asks for one stays up, and this says so.
 */
export async function answerUac(guest: Guest, host: HostCalls, answer: unknown, sleep: Sleep, signal?: AbortSignal): Promise<ToolResult> {
	if (answer !== "yes" && answer !== "no") throw new Error('win.uac needs { vm, answer: "yes" } or answer: "no"');
	const vm = guest.vm;
	await guest.assertConsole(signal);
	if (!(await uacShowing(guest, signal))) throw new Error(`No UAC prompt is showing on ${vm}.`);
	await guest.assertConsole(signal);
	await host.call("key", { vm, keys: answer === "yes" ? "alt+y" : "esc" }, { signal });
	for (let waited = 0; ; waited += UAC_POLL_MS) {
		await sleep(UAC_POLL_MS, signal);
		if (!(await uacShowing(guest, signal))) return textResult(`Answered the UAC prompt on ${vm}: ${answer}.`);
		if (waited >= UAC_CLOSE_MS) throw new Error(`The UAC prompt on ${vm} is still showing. It may ask for an administrator's password, which windows_use never types; win.console.screenshot({ vm: ${JSON.stringify(vm)} }) shows it.`);
	}
}
