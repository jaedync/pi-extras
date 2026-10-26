/** The text of `status` and `/pi-extras update`, from the state and the config. */
import type { AutoUpdateConfig } from "./config.ts";
import { PI_KEY } from "./plan.ts";
import { isBad, isBlocked, SUSPECT_WAIT_MS, type UpdateSet, type UpdateState } from "./state.ts";

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
		return `${nameOf(current, key)} ${id}${bad ? ` (failed its test: ${bad.reason})` : ""}`;
	});
}

const nameOf = (current: UpdateSet, key: string): string => (key === PI_KEY ? "Pi" : (current.packages[key]?.label?.split(" ")[0] ?? key));

/** Releases that cycles skip for now because their test did not finish (see SuspectMark). */
function waiting(state: UpdateState, now: number): string[] {
	const current = state.current;
	if (!current) return [];
	return Object.entries(state.suspect ?? {}).flatMap(([key, ids]) =>
		Object.entries(ids)
			.filter(([id]) => isBlocked(state, key, id, now) && !isBad(state, key, id))
			.map(([id, mark]) => `${nameOf(current, key)} ${id} (its test did not finish ${mark.tries} times; next try in ${Math.ceil((mark.at + SUSPECT_WAIT_MS - now) / 3_600_000)} h)`),
	);
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
	const skipped = waiting(state, now);
	if (skipped.length > 0) lines.push(`Skipped for now: ${skipped.join(", ")}`);
	lines.push(`Last check: ${state.lastCheck === undefined ? "never" : ago(state.lastCheck, now)}`);
	if (state.activity) lines.push(`Now: ${state.activity.text} (since ${ago(state.activity.since, now)})`);
	if (state.launcherProblem) lines.push(`Problem: ${state.launcherProblem.message}`);
	if (state.lastError && state.lastError.message !== state.launcherProblem?.message) lines.push(`Last error (${ago(state.lastError.at, now)}): ${state.lastError.message}`);
	return lines;
}
