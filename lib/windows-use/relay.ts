import { readFileSync } from "node:fs";

export const DATA_SERVICE = "951d64b0-077c-49a9-b668-4ef3f202debf";
export const CONTROL_SERVICE = "3d0558c2-329e-47c2-8e62-1423eb99519e";
export const RELAY_VERSION = 1;
export const RELAY_SCRIPT = readFileSync(new URL("./guest-relay.py", import.meta.url), "utf8");

export interface RelaySession {
	readonly id: number;
	readonly console: number;
	readonly state: number;
	readonly locked: boolean;
	readonly elevated: boolean;
}
export type ControlReply =
	| { readonly ok: false; readonly error: string }
	| { readonly ok: true; readonly relay: 1; readonly pid: number; readonly listening: boolean; readonly uptime: number }
	| { readonly ok: true; readonly session: RelaySession }
	| { readonly ok: true; readonly steps: readonly { readonly step: "end" | "kill" | "run"; readonly code: number }[] };

export function controlRequest(key: string, op: "ping" | "session" | "restart"): string {
	return `${JSON.stringify({ key, op })}\n`;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const uint = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

/** Unknown or ambiguous success shapes cannot authorize a desktop operation. */
export function readControlReply(line: string): ControlReply {
	const invalid = () => new Error("Invalid windows_use relay control reply");
	if (!/^[^\r\n]+(?:\r?\n)?$/.test(line)) throw invalid();
	let value: unknown;
	try { value = JSON.parse(line); } catch { throw invalid(); }
	if (!record(value)) throw invalid();
	if (value.ok === false && keys(value, ["ok", "error"]) && typeof value.error === "string" && value.error.length > 0) return { ok: false, error: value.error };
	if (value.ok !== true) throw invalid();
	if (keys(value, ["ok", "relay", "pid", "listening", "uptime"]) && value.relay === RELAY_VERSION && uint(value.pid) && value.pid > 0 && typeof value.listening === "boolean" && typeof value.uptime === "number" && Number.isFinite(value.uptime) && value.uptime >= 0) {
		return { ok: true, relay: RELAY_VERSION, pid: value.pid, listening: value.listening, uptime: value.uptime };
	}
	if (keys(value, ["ok", "session"]) && record(value.session)) {
		const session = value.session;
		if (keys(session, ["id", "console", "state", "locked", "elevated"]) && uint(session.id) && uint(session.console) && uint(session.state) && session.state <= 9 && typeof session.locked === "boolean" && typeof session.elevated === "boolean") {
			return { ok: true, session: { id: session.id, console: session.console, state: session.state, locked: session.locked, elevated: session.elevated } };
		}
	}
	if (keys(value, ["ok", "steps"]) && Array.isArray(value.steps)) {
		const steps = value.steps.map((step: unknown) => {
			if (!record(step) || !keys(step, ["step", "code"]) || typeof step.step !== "string" || !["end", "kill", "run"].includes(step.step) || typeof step.code !== "number" || !Number.isSafeInteger(step.code)) throw invalid();
			return { step: step.step as "end" | "kill" | "run", code: step.code };
		});
		// The test relay returns no steps; production always reports all three in order.
		if (steps.length !== 0 && (steps.length !== 3 || steps.some((step, i) => step.step !== ["end", "kill", "run"][i]))) throw invalid();
		return { ok: true, steps };
	}
	throw invalid();
}
