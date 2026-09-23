/**
 * Text for the /voice command: the menu, the model picker, and status rows.
 * Pure so the wording is tested; the extension only wires it to the UI.
 */
import { activeTier, backendOptions, describeOption, readyTierIds, tierName, type HardwareFacts, type Preference, type TierMap } from "./plan.ts";

export { tierName };

export type MenuAction = "dictate" | "mic" | "model" | "status" | "setup" | "unload";

export interface MenuItem {
	readonly label: string;
	readonly action: MenuAction;
}

export interface ModelChoice {
	readonly label: string;
	readonly value: Preference;
}

/** Subcommands for autocomplete, in menu order. */
export const SUBCOMMANDS: ReadonlyArray<{ value: Exclude<MenuAction, "dictate">; label: string; description: string }> = [
	{ value: "mic", label: "mic", description: "Choose the microphone" },
	{ value: "model", label: "model", description: "Choose the speech model" },
	{ value: "status", label: "status", description: "Show the mic, model and setup state" },
	{ value: "setup", label: "setup", description: "Reinstall anything missing" },
	{ value: "unload", label: "unload", description: "Stop the background model to free memory" },
];

/** The model setting in words, including what "automatic" resolves to right now. */
export function modelSummary(tiers: TierMap): string {
	const preferred = tiers.preferred ?? "auto";
	const active = activeTier(preferred, readyTierIds(tiers));
	const using = active ? `using ${tierName(active)}` : "nothing installed yet";
	if (preferred === "auto") return active ? `Automatic, ${using}` : `Automatic (${using})`;
	if (active === preferred) return tierName(preferred);
	return `${tierName(preferred)}, not installed yet (${using})`;
}

export function modelChoices(facts: HardwareFacts, tiers: TierMap): ModelChoice[] {
	const preferred = tiers.preferred ?? "auto";
	const mark = (value: Preference) => (value === preferred ? "✓ " : "  ");
	const auto = activeTier("auto", readyTierIds(tiers));
	return [
		{ label: `${mark("auto")}Automatic${auto ? ` (now ${tierName(auto)})` : ""}`, value: "auto" },
		...backendOptions(facts, tiers)
			.filter((option) => option.available)
			.map((option) => ({ label: `${mark(option.tier)}${describeOption(option)}`, value: option.tier })),
	];
}

export function menuItems(state: { key: string; mic: string; model: string; running: boolean }): MenuItem[] {
	const items: MenuItem[] = [
		{ label: `Dictate (${state.key})`, action: "dictate" },
		{ label: `Microphone: ${state.mic}`, action: "mic" },
		{ label: `Model: ${state.model}`, action: "model" },
		{ label: "Status", action: "status" },
		{ label: "Repair setup", action: "setup" },
	];
	return state.running ? [...items, { label: "Unload model", action: "unload" }] : items;
}

/** "key  value" rows with the values lined up. */
export function alignRows(rows: ReadonlyArray<readonly [string, string]>): string[] {
	const width = Math.max(0, ...rows.map(([key]) => key.length));
	return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`);
}
