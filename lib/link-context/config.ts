/** The `linkContext` section of pi-extras.json, validated field by field. */
import { readSection } from "../extras-config.ts";
import type { LinkConfig } from "./types.ts";

export const SECTION = "linkContext";
const DEFAULT_REFRESH_DAYS = 3;

function agentChains(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const chains: Record<string, string[]> = {};
	for (const [key, list] of Object.entries(value)) {
		if (!Array.isArray(list)) continue;
		const agents = list.filter((agent): agent is string => typeof agent === "string" && agent.length > 0 && agent.length < 512 && !/[\r\n]/.test(agent));
		if (agents.length) chains[key] = agents;
	}
	return chains;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export function parseConfig(section: Record<string, unknown>): LinkConfig {
	const refresh = section.refreshDays;
	return {
		userAgents: agentChains(section.userAgents),
		proxy: text(section.proxy),
		cookies: text(section.cookies),
		asrModel: text(section.asrModel),
		refreshDays: typeof refresh === "number" && refresh >= 0 && refresh <= 365 ? refresh : DEFAULT_REFRESH_DAYS,
	};
}

export function loadConfig(): LinkConfig {
	return parseConfig(readSection(SECTION));
}

/** The configured chain for an adapter, or its built-in default. */
export function agentsFor(config: LinkConfig, adapter: string, fallback: readonly string[]): readonly string[] {
	return config.userAgents[adapter] ?? fallback;
}
