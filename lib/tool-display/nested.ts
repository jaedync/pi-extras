/** Bounded presentation-only observations. Never executes tools or persists their results. */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { sanitize } from "./format.ts";
import { resultText } from "./kit.ts";

export const NESTED_CALL_LIMIT = 256;
const PARENT_LIMIT = 128;
const TEXT_LIMIT = 8_192;
const CACHE_DETAIL_CHARS = 32_768;
export type CallStatus = "running" | "ok" | "error" | "cancelled" | "unfinished";
export interface NestedCall {
	readonly id: string;
	readonly name: string;
	readonly args?: string;
	readonly status: CallStatus;
	readonly startedAt?: number;
	readonly parentId?: string;
	readonly durationMs?: number;
	readonly error?: string;
	readonly output?: string;
	/** Overlapping call lifetimes include Pi queue/permission waits, not proof of parallel execution. */
	readonly overlapping?: boolean;
	readonly truncated?: boolean;
}
export interface CallSnapshot { readonly calls: readonly NestedCall[]; readonly complete: boolean }
type Event = { type?: unknown; toolCallId?: unknown; parentToolCallId?: unknown; toolName?: unknown; args?: unknown; result?: unknown; partialResult?: unknown; isError?: unknown };
const clean = (text: string) => sanitize(stripTerminalSequences(text)).slice(0, TEXT_LIMIT);
const duration = (ms: unknown) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
export const argSummary = (args: unknown): string | undefined => {
	try { return args === undefined ? undefined : clean(typeof args === "string" ? args : JSON.stringify(args) ?? ""); }
	catch { return "[arguments unavailable]"; }
};

function boundCalls(snapshot: CallSnapshot): CallSnapshot {
	let room = CACHE_DETAIL_CHARS;
	let complete = snapshot.complete;
	const calls = snapshot.calls.toReversed().map((call) => {
		const cost = (call.args?.length ?? 0) + (call.output?.length ?? 0) + (call.error?.length ?? 0);
		if (call.truncated) complete = false;
		if (cost <= room) { room -= cost; return call; }
		complete = false;
		return { ...call, args: call.args === undefined ? undefined : "[arguments omitted from live cache]", error: undefined,
			output: call.output === undefined ? undefined : "[nested output omitted from live cache; see script result]" };
	}).toReversed();
	return { calls, complete };
}

/** Both Pi's durable nestedCalls and codemode's streamed details.calls are data, not source guesses. */
export function readCalls(value: unknown): CallSnapshot | undefined {
	if (!value || typeof value !== "object" || !Array.isArray((value as { calls?: unknown }).calls)) return undefined;
	const data = value as { calls: unknown[]; complete?: unknown };
	const calls = data.calls.slice(0, NESTED_CALL_LIMIT).flatMap((item, index): NestedCall[] => {
		if (!item || typeof item !== "object") return [];
		const call = item as Record<string, unknown>;
		if (typeof call.name !== "string" || !["running", "ok", "error", "cancelled", "unfinished"].includes(String(call.status))) return [];
		return [{ id: typeof call.id === "string" ? call.id : String(index), name: clean(call.name),
			args: argSummary(call.arguments ?? call.args), status: call.status as CallStatus,
			durationMs: duration(call.durationMs), ...(typeof call.error === "string" ? { error: clean(call.error) } : {}) }];
	});
	return boundCalls({ calls, complete: data.complete !== false && data.calls.length === calls.length });
}

export class NestedCalls {
	private readonly records = new Map<string, CallSnapshot>();
	private readonly roots = new Map<string, string>();
	private readonly listeners = new Map<string, () => void>();
	private readonly now: () => number;
	constructor(now: () => number) { this.now = now; }
	get(id: string): CallSnapshot | undefined { return this.records.get(id); }
	watch(id: string, listener: () => void): void {
		this.listeners.set(id, listener);
		if (this.listeners.size > PARENT_LIMIT) this.listeners.delete(this.listeners.keys().next().value!);
	}
	clear(): void { this.records.clear(); this.roots.clear(); this.listeners.clear(); }
	restore(id: string, value: unknown): void {
		const saved = readCalls(value);
		if (saved && !this.records.has(id)) this.put(id, saved);
	}
	finish(id: string): void {
		const snapshot = this.records.get(id);
		if (!snapshot) return;
		const calls = snapshot.calls.map((call) => call.status !== "running" ? call : {
			...call, status: "unfinished" as const, durationMs: call.startedAt === undefined ? undefined : this.now() - call.startedAt,
		});
		this.put(id, { calls, complete: snapshot.complete && calls.every((call) => call.status !== "unfinished") });
	}

	observe(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const event = raw as Event;
		if (typeof event.parentToolCallId !== "string" || typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
		if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) return;
		const root = this.roots.get(event.parentToolCallId) ?? event.parentToolCallId;
		const previous = this.records.get(root) ?? { calls: [], complete: true };
		const at = previous.calls.findIndex((call) => call.id === event.toolCallId);
		if (at < 0 && previous.calls.length >= NESTED_CALL_LIMIT) { this.put(root, { ...previous, complete: false }); return; }
		const existing = at < 0 ? undefined : previous.calls[at];
		const call = this.updated(event, existing);
		const overlapping = event.type === "tool_execution_start" && previous.calls.some((other) => other.status === "running" && other.parentId === event.parentToolCallId);
		const calls = previous.calls.map((other, index) => index === at ? call : overlapping && other.status === "running" && other.parentId === event.parentToolCallId ? { ...other, overlapping: true } : other);
		if (at < 0) calls.push(overlapping ? { ...call, overlapping: true } : call);
		this.roots.set(event.toolCallId, root);
		this.put(root, { ...previous, calls });
	}

	private updated(event: Event, previous?: NestedCall): NestedCall {
		const call: NestedCall = previous ?? { id: event.toolCallId as string, name: clean(event.toolName as string), args: argSummary(event.args), parentId: event.parentToolCallId as string, status: "running" };
		if (event.type === "tool_execution_start") return { ...call, startedAt: call.startedAt ?? this.now() };
		const result = (event.type === "tool_execution_update" ? event.partialResult : event.result) as { content?: unknown } | undefined;
		const text = result ? resultText(result) : undefined;
		const truncated = text === undefined ? call.truncated : text.length > TEXT_LIMIT;
		const output = text === undefined ? call.output : clean(text) + (truncated ? "\n… nested output truncated; see script result" : "");
		if (event.type === "tool_execution_update") return { ...call, output, truncated };
		return { ...call, output, truncated, status: event.isError === true ? "error" : "ok",
			durationMs: call.startedAt === undefined ? undefined : this.now() - call.startedAt };
	}

	private put(id: string, snapshot: CallSnapshot): void {
		this.records.set(id, boundCalls(snapshot));
		if (this.records.size > PARENT_LIMIT) {
			const oldest = this.records.keys().next().value!;
			this.records.delete(oldest);
			this.listeners.delete(oldest);
			for (const [call, root] of this.roots) if (root === oldest) this.roots.delete(call);
		}
		this.listeners.get(id)?.();
	}
}
