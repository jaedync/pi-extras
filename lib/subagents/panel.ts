/**
 * A panel: one task on several models, for independent opinions. Parallel
 * members start at once; sequential ones start one after another, each with
 * `after` on the one before and `afterReports: false`, so none reads an
 * earlier answer. Their reports are held (hand-up.ts) until the last member
 * ends, then the parent gets them as one message with a line per member.
 */
import { slugify } from "../shell-jobs-core.ts";
import { NAME_MAX } from "./names.ts";
import { LIVE_STATES, type AgentRecord } from "./types.ts";

export const PANEL_MIN = 2;
export const PANEL_MAX = 8;
export const PANEL_MODES = ["parallel", "sequential"] as const;
export type PanelMode = typeof PANEL_MODES[number];
const SHORT_MAX = 14;
const BASE_MIN = 3;

/** A model id short enough for a name: `claude-` dropped, as the model guide names them. */
export function shortModel(id: string): string {
	return slugify(id.replace(/^claude-/, ""), SHORT_MAX) || "model";
}

/** `<panel>-<short model>`, cut to fit a name; a collision gets `-2` from the team. */
export function memberName(panel: string, modelId: string): string {
	const short = shortModel(modelId);
	const room = Math.max(BASE_MIN, NAME_MAX - short.length - 1);
	return `${panel.slice(0, room).replace(/-+$/, "")}-${short}`;
}

/** A panel name no agent of the team has used yet: `review`, then `review-2`. */
export function panelName(base: string, records: readonly AgentRecord[]): string {
	const used = new Set(records.map((record) => record.panel).filter((panel): panel is string => panel !== undefined));
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The members of `record`'s panel, in spawn order; those of a panel already reported are no longer held. */
export function panelOf(record: AgentRecord, records: readonly AgentRecord[]): AgentRecord[] {
	return records.filter((other) => other.panel === record.panel && other.parent === record.parent);
}

/** Whether `record`'s report waits for its panel: a member until the panel's message went out. */
export const heldForPanel = (record: AgentRecord): boolean => record.panel !== undefined && record.panelDone !== true;

/** Whether a member other than `name` has not ended yet, so the panel's message waits. */
export function panelBusy(members: readonly AgentRecord[], name: string): boolean {
	return members.some((member) => member.name !== name && member.panelDone !== true && LIVE_STATES.has(member.state));
}
