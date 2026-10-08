/**
 * How Status Plus counts tools: split (the default), where a chained bash
 * command counts each of its steps and a script each call it made, or Pi's
 * way, one per tool call. The folded lines count the same way. A click on the footer's
 * counter switches it, and `/tool-display count` does the same where the
 * terminal sends no clicks. Both save it to pi-extras.json and announce it,
 * so a running Status Plus follows along.
 */
import { splitChain } from "./chain/split.ts";
import { readSection, writeSection } from "./extras-config.ts";

export type ToolCount = "calls" | "steps";

export const TOOL_COUNT_SECTION = "statusPlus";
/** Announced on Pi's event bus with the new `ToolCount`. */
export const TOOL_COUNT_EVENT = "pi-extras:tool-count";

export function readToolCount(file?: string): ToolCount {
	return readSection(TOOL_COUNT_SECTION, file).toolCount === "calls" ? "calls" : "steps";
}

export function writeToolCount(count: ToolCount, file?: string): void {
	writeSection(TOOL_COUNT_SECTION, { toolCount: count }, file);
}

/** One counted part of a tool call: a shell call, or a call a script made, and the steps its command text plans. */
export interface StepUnit {
	readonly id: string;
	readonly planned: number;
}

export const isShell = (name: string): boolean => name === "bash" || name.endsWith("__bash");

/** How many commands a shell call runs: each step of a chained command; a leading `cd` is a place, not a step. */
export function commandsIn(args: unknown): number {
	let command: unknown = (args as { command?: unknown } | null | undefined)?.command;
	if (command === undefined && typeof args === "string") {
		try { command = (JSON.parse(args) as { command?: unknown } | null)?.command; } catch { command = undefined; }
	}
	if (typeof command !== "string") return 1;
	const steps = splitChain(command)?.steps.filter((step) => !step.cd).length ?? 1;
	return Math.max(1, steps);
}

/**
 * Tool calls with each one in `plans` counted by its parts. A part counts the
 * steps its chain ran when Tool Display saved or announced them (`ran`, by
 * tool call id), else the steps its command text plans. A chain that ran none
 * still counts once, and so does a call whose parts add up to nothing.
 */
export function splitCount(toolCalls: number, plans: ReadonlyMap<string, readonly StepUnit[]>, ran: ReadonlyMap<string, number>): number {
	let extra = 0;
	for (const units of plans.values()) {
		const steps = units.reduce((sum, unit) => sum + Math.max(1, ran.get(unit.id) ?? unit.planned), 0);
		extra += Math.max(1, steps) - 1;
	}
	return toolCalls + extra;
}
