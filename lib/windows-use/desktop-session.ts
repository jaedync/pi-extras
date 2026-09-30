/** Live WTS state, not SESSIONNAME: a running desktop can move from console to RDP. */
import { readFileSync } from "node:fs";

export const SESSION_CHECK = readFileSync(new URL("./session-check.ps1", import.meta.url), "utf8");
const NO_CONSOLE = 0xffffffff;

export interface DesktopSession {
	readonly id: number;
	readonly where: "console" | "remote" | "unknown";
	readonly active: boolean;
	readonly disconnected: boolean;
	readonly locked: boolean;
	readonly elevated: boolean;
}

/** A failed PowerShell command is not evidence of an unlocked desktop. */
export function readSession(text: string): DesktopSession {
	const match = /^Response: PI_WINDOWS_SESSION=(\{[^\r\n]+\})\s*\r?\nStatus Code: 0\s*$/.exec(text);
	let value: Record<string, unknown> = {};
	try { if (match) value = JSON.parse(match[1]!); } catch { /* Invalid replies fail closed below. */ }
	const uint = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= NO_CONSOLE;
	if (!uint(value.id) || value.id === 0 || !uint(value.console) || !uint(value.state) || value.state > 9 || typeof value.locked !== "boolean" || typeof value.elevated !== "boolean") {
		throw new Error("Windows-MCP could not report its live desktop session; no input was sent. Reconnect the intended desktop in VM Connect and retry.");
	}
	return {
		id: value.id, where: value.console === NO_CONSOLE ? "unknown" : value.id === value.console ? "console" : "remote",
		active: value.state === 0, disconnected: value.state === 4, locked: value.locked, elevated: value.elevated,
	};
}

export function consoleRefusal(vm: string, remote: boolean): Error {
	return new Error(remote
		? `${vm}'s last reported desktop is an enhanced/remote session. Console input and console repair are disabled because they could disconnect it. Use win.click/type/key in that session. If it is unavailable, reconnect or repair Windows-MCP in the same VM Connect session; do not sign in at the console.`
		: `Cannot confirm that ${vm}'s desktop is at the console. No console input was sent: signing in could disconnect an enhanced session. Open the intended desktop in VM Connect and retry. A first install needs a visible basic-session desktop; an enhanced session needs Windows-MCP already installed.`);
}

export function requireActive(vm: string, session: DesktopSession): void {
	if (session.where === "unknown" || !session.active) {
		throw new Error(`${vm}'s desktop session is ${session.disconnected ? "disconnected" : "not confirmed active"}. Reconnect the intended session in VM Connect and retry; the console was left alone.`);
	}
	if (session.where === "remote" && session.locked) {
		throw new Error(`${vm}'s enhanced/remote session is locked. Unlock it in the same VM Connect window and retry; the console was left alone.`);
	}
}
