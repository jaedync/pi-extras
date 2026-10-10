import { fingerprint } from "./core.ts";

/** Fixed decision metadata only. Never pass provider text or request fields here. */
export const COMPACTION_DECISION_EVENT = "pi-extras:compaction-decision";
/** A cache compaction's summary as it streams: the newest characters and how many came in all. */
export const COMPACTION_PROGRESS_EVENT = "pi-extras:compaction-progress";
/** The summary text one progress event carries: more than a live band's preview needs at any width. */
export const PROGRESS_TAIL_CHARS = 2_048;
export interface CompactionProgress { readonly sessionId: string; readonly text: string; readonly chars: number }
export function readProgress(data: unknown): CompactionProgress | undefined {
	const value = data as Partial<CompactionProgress> | undefined;
	if (!value || typeof value !== "object" || typeof value.sessionId !== "string" || typeof value.text !== "string") return undefined;
	return typeof value.chars === "number" && Number.isFinite(value.chars) && value.chars >= 0 ? { sessionId: value.sessionId, text: value.text, chars: value.chars } : undefined;
}
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
