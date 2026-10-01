import { fingerprint } from "./core.ts";

/** Fixed decision metadata only. Never pass provider text or request fields here. */
export const COMPACTION_DECISION_EVENT = "pi-extras:compaction-decision";
export interface CompactionPath {
	readonly path: "prefix-sharing" | "default";
	readonly fallbackReason: string | null;
}
export interface CompactionNotice extends CompactionPath {
	readonly sessionId: string;
	readonly compactionKey?: string;
}
export function readCompactionPath(data: unknown): CompactionPath | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as CompactionPath;
	return (value.path === "default" || value.path === "prefix-sharing") && (value.fallbackReason === null || typeof value.fallbackReason === "string") ? { path: value.path, fallbackReason: value.fallbackReason } : undefined;
}
export const compactionKey = (entry: { readonly summary: string; readonly firstKeptEntryId: string; readonly tokensBefore: number }) => fingerprint({ summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore });
export interface CompactionDecision extends CompactionPath {
	readonly time: string;
	readonly sessionId: string;
	readonly provider: string | null;
	readonly model: string | null;
	readonly reason: "threshold" | "manual" | "overflow";
	readonly tokensBefore: number;
	readonly estimate: number | null;
	readonly available: number | null;
	readonly floor: number;
	readonly tailTokens: number | null;
	readonly stopReason: string | null;
	readonly usage: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number } | null;
}
