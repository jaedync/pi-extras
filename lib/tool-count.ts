/**
 * How Status Plus counts tools: Pi's way, one per tool call, or split, where
 * a chained bash command counts each step it ran. A click on the footer's
 * counter switches it, and `/tool-display count` does the same where the
 * terminal sends no clicks. Both save it to pi-extras.json and announce it,
 * so a running Status Plus follows along.
 */
import { readSection, writeSection } from "./extras-config.ts";

export type ToolCount = "calls" | "steps";

export const TOOL_COUNT_SECTION = "statusPlus";
/** Announced on Pi's event bus with the new `ToolCount`. */
export const TOOL_COUNT_EVENT = "pi-extras:tool-count";

export function readToolCount(file?: string): ToolCount {
	return readSection(TOOL_COUNT_SECTION, file).toolCount === "steps" ? "steps" : "calls";
}

export function writeToolCount(count: ToolCount, file?: string): void {
	writeSection(TOOL_COUNT_SECTION, { toolCount: count }, file);
}

/**
 * Tool calls with each chain counted by the steps it ran; a chain that ran
 * none still counts once, as the call it was. `ran` maps tool call ids to steps.
 */
export function splitCount(toolCalls: number, ran: ReadonlyMap<string, number>): number {
	let extra = 0;
	for (const steps of ran.values()) extra += Math.max(1, steps) - 1;
	return toolCalls + extra;
}
