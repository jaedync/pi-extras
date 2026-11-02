/**
 * Extensions cannot write Pi's own `usage` entry, so the cache warmer records each
 * warm as a custom entry. Spend readers turn it into the usage entry Pi would write.
 */
export const CACHE_WARM_ENTRY = "pi-extras.cache-warm";

export interface CacheWarmUsage { type: "usage"; kind: "cache_warm"; id?: unknown; timestamp?: unknown; provider: string; model: string; usage: unknown }

export function cacheWarmUsage(entry: unknown): CacheWarmUsage | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const e = entry as { type?: unknown; customType?: unknown; data?: unknown; id?: unknown; timestamp?: unknown };
	if (e.type !== "custom" || e.customType !== CACHE_WARM_ENTRY || !e.data || typeof e.data !== "object") return undefined;
	const data = e.data as { provider?: unknown; model?: unknown; usage?: unknown };
	if (typeof data.provider !== "string" || !data.usage || typeof data.usage !== "object") return undefined;
	return { type: "usage", kind: "cache_warm", id: e.id, timestamp: e.timestamp, provider: data.provider, model: String(data.model ?? ""), usage: data.usage };
}
