/** The text of `status` and `/pi-extras update`, from the state and the config. */
import type { AutoUpdateConfig } from "./config.ts";
import { PI_KEY } from "./plan.ts";
import type { UpdateSet, UpdateState } from "./state.ts";

export function setLabel(set: UpdateSet | undefined): string {
	if (!set) return "none";
	return [`Pi ${set.pi.version}`, ...Object.values(set.packages).map((release) => release.label ?? release.id)].join(", ");
}

function ago(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "less than 1 min ago";
	if (minutes < 120) return `${minutes} min ago`;
	return `${Math.round(minutes / 60)} h ago`;
}

/** Newest versions that are not in the current set. */
function newer(state: UpdateState): string[] {
	const current = state.current;
	if (!current || !state.newest) return [];
	return Object.entries(state.newest).filter(([key, id]) => (key === PI_KEY ? current.pi.version !== id : current.packages[key]?.id !== id)).map(([key, id]) => {
		const bad = state.bad[key]?.[id];
		const name = key === PI_KEY ? "Pi" : (current.packages[key]?.label?.split(" ")[0] ?? key);
		return `${name} ${id}${bad ? ` (failed its test: ${bad.reason})` : ""}`;
	});
}

export function statusLines(state: UpdateState, config: AutoUpdateConfig, now: number): string[] {
	const on = config.enabled && state.current !== undefined;
	const lines = [`Auto-update: ${on ? (config.paused ? "on, paused" : "on") : "off"}${on ? `, a check every ${config.intervalMinutes} min` : ""}`];
	if (!on) {
		lines.push("To turn it on, run: node <pi-extras>/lib/auto-update/cli.ts enable");
		return lines;
	}
	lines.push(`Current: ${setLabel(state.current)}`);
	if (state.previous) lines.push(`Previous: ${setLabel(state.previous)}`);
	const pending = newer(state);
	lines.push(`Newest found: ${pending.length > 0 ? pending.join(", ") : "nothing newer"}`);
	lines.push(`Last check: ${state.lastCheck === undefined ? "never" : ago(state.lastCheck, now)}`);
	if (state.activity) lines.push(`Now: ${state.activity.text} (since ${ago(state.activity.since, now)})`);
	if (state.lastError) lines.push(`Last error (${ago(state.lastError.at, now)}): ${state.lastError.message}`);
	return lines;
}
