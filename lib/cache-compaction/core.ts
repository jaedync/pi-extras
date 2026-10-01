import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { summaryOutputFloor } from "./estimate.ts";

// Resolve pi-ai's native effort type through the SDK, without a direct pi-ai dependency.
declare const complete: ModelRuntime["complete"];
export type RequestEffort = NonNullable<NonNullable<Parameters<typeof complete<"anthropic-messages">>[2]>["effort"]>;

type RecordValue = Record<string, unknown>;
const object = (v: unknown): v is RecordValue => !!v && typeof v === "object" && !Array.isArray(v);
export interface Config { readonly enabled: boolean; readonly idleSeconds: Readonly<Record<string, number>> }
export interface ModelIdentity { readonly provider: string; readonly id: string; readonly api: string; readonly contextWindow: number; readonly baseUrl?: string }
export interface RequestIdentity extends ModelIdentity { readonly sessionId: string; readonly at: number }

export function loadConfig(section: RecordValue): Config {
	const values = object(section.idleSeconds) ? section.idleSeconds : {};
	const idleSeconds = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 86400)) as Record<string, number>;
	return { enabled: typeof section.enabled === "boolean" ? section.enabled : true, idleSeconds };
}

export function idleLimitMs(config: Config, model: Pick<ModelIdentity, "provider" | "api" | "baseUrl">): number {
	const override = config.idleSeconds[model.provider];
	if (override !== undefined) return override * 1000;
	// Meridian's SDK writes one-hour caches. Leave five minutes for expiry/routing skew.
	// Native Anthropic's usual five-minute TTL and Codex's shorter retention get a one-minute margin.
	const meridian = model.api === "anthropic-messages" && /^http:\/\/(127\.0\.0\.1|localhost):3456(?:\/|$)/.test(model.baseUrl ?? "");
	return (meridian ? 55 : 4) * 60000;
}

export function conversationKey(api: string): "messages" | "input" | "contents" | undefined {
	switch (api) {
		case "anthropic-messages": return "messages";
		case "openai-responses": case "openai-codex-responses": case "azure-openai-responses": return "input";
		case "google-generative-ai": case "google-vertex": return "contents";
		default: return undefined;
	}
}

/** Store only non-conversation fields: the full message snapshot already owns the large transcript. */
export function capturePayload(api: string, payload: unknown): RecordValue | undefined {
	const key = conversationKey(api);
	if (!key || !object(payload) || !Array.isArray(payload[key])) return undefined;
	const fields = Object.fromEntries(Object.entries(payload).filter(([name]) => name !== key));
	const clean = key === "contents" && object(fields.config) ? { ...fields, config: Object.fromEntries(Object.entries(fields.config).filter(([name]) => name !== "abortSignal")) } : fields;
	return structuredClone(clean);
}

/** Cache breakpoints move to the new suffix on normal turns; all conversation content must still match. */
export function payloadHashes(api: string, payload: unknown): string[] | undefined {
	const key = conversationKey(api);
	if (!key || !object(payload) || !Array.isArray(payload[key])) return undefined;
	return payload[key].map((item: unknown) => createHash("sha256").update(JSON.stringify(item, (name, value: unknown) => name === "cache_control" ? undefined : value)).digest("hex"));
}
function preserveEffortMarker(api: string, generated: RecordValue, prefix?: readonly string[]): RecordValue {
	if (api !== "anthropic-messages" || !prefix?.length || !Array.isArray(generated.messages)) return generated;
	const hashes = payloadHashes(api, generated)!;
	if (prefix.every((hash, i) => hash === hashes[i])) return generated;
	const marker: unknown = generated.messages.at(-1);
	// Only an identical empty effort-only marker can move into the old active-marker position.
	if (!object(marker) || marker.role !== "system" || !Array.isArray(marker.content) || marker.content.length || !object(marker.output_config) || Object.keys(marker).sort().join() !== "content,output_config,role" || Object.keys(marker.output_config).join() !== "effort" || typeof marker.output_config.effort !== "string") return generated;
	if (prefix.at(-1) !== hashes.at(-1) || !prefix.slice(0, -1).every((hash, i) => hash === hashes[i])) return generated;
	return { ...generated, messages: [...generated.messages.slice(0, prefix.length - 1), structuredClone(marker), ...generated.messages.slice(prefix.length - 1)] };
}
export function mergePayload(api: string, captured: RecordValue, generated: unknown, prefix?: readonly string[], floor = summaryOutputFloor()): RecordValue {
	const key = conversationKey(api);
	if (!key || !object(generated) || !Array.isArray(generated[key])) throw new Error("Unsupported compaction payload");
	const payload = preserveEffortMarker(api, generated, prefix);
	const hashes = prefix ? payloadHashes(api, payload) : undefined;
	if (prefix && (!hashes || prefix.length > hashes.length || !prefix.every((hash, i) => hash === hashes[i]))) throw new Error("prefix-changed");
	const cap = requestOutputLimit(payload);
	const config = object(captured.config) ? captured.config : undefined;
	const budget = key === "contents" && config && object(config.thinkingConfig) ? config.thinkingConfig.thinkingBudget : object(captured.thinking) ? captured.thinking.budget_tokens : undefined;
	if (typeof budget === "number" && (cap === undefined || cap <= budget + floor)) throw new Error("thinking-budget");
	const { max_tokens: _tokens, max_output_tokens: _output, ...fields } = structuredClone(captured);
	// The generated cap belongs to the actual summary context. All cache-affecting fields stay captured.
	const capped = key === "contents" && object(payload.config) ? { ...fields, config: { ...(object(fields.config) ? fields.config : {}), maxOutputTokens: payload.config.maxOutputTokens, ...(payload.config.abortSignal === undefined ? {} : { abortSignal: payload.config.abortSignal }) } } : { ...fields, ...("max_tokens" in payload ? { max_tokens: payload.max_tokens } : {}), ...("max_output_tokens" in payload ? { max_output_tokens: payload.max_output_tokens } : {}) };
	return { ...capped, [key]: payload[key] };
}

export function requestOutputLimit(payload: unknown): number | undefined {
	if (!object(payload)) return undefined;
	const value = payload.max_tokens ?? payload.max_output_tokens ?? (object(payload.config) ? payload.config.maxOutputTokens : undefined);
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
export function safeHeaders(headers: unknown): Record<string, string> {
	if (!object(headers)) return {};
	return Object.fromEntries(Object.entries(headers).filter(([name, value]) => typeof value === "string" && !/(auth|cookie|token|key|credential|secret|signature)/i.test(name))) as Record<string, string>;
}
export function requestEffort(payload: unknown): RequestEffort | undefined {
	if (!object(payload)) return undefined;
	const marker = Array.isArray(payload.messages) ? [...payload.messages].reverse().find((message: unknown) => object(message) && message.role === "system" && object(message.output_config)) : undefined;
	const output = object(marker) ? marker.output_config : payload.output_config;
	const effort = object(output) ? output.effort : undefined;
	// Reuse the actual provider value, including future native levels; provider validation still applies.
	return typeof effort === "string" ? effort as RequestEffort : undefined;
}

export interface Gate {
	readonly enabled: boolean; readonly captured?: RequestIdentity; readonly model: ModelIdentity;
	readonly sessionId: string; readonly now: number; readonly idleMs: number; readonly reason: string;
	readonly aborted: boolean;
}
export function fallbackReason(g: Gate): string | undefined {
	if (!g.enabled) return "disabled";
	if (g.aborted) return "aborted";
	if (!g.captured) return "no-request";
	if (g.captured.provider !== g.model.provider || g.captured.id !== g.model.id || g.captured.api !== g.model.api || g.captured.baseUrl !== g.model.baseUrl) return "model-changed";
	if (g.captured.sessionId !== g.sessionId) return "session-changed";
	if (!conversationKey(g.model.api)) return "unsupported-api";
	if (g.reason === "overflow") return "overflow";
	if (g.now < g.captured.at || g.now - g.captured.at >= g.idleMs) return "cold-cache";
	return undefined;
}

export function fingerprint(message: unknown): string {
	return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}
export interface Snapshot { readonly ids: readonly string[]; readonly hashes: readonly string[] }
/** Entry IDs protect against forks with identical text; hashes also detect context edits and mutation. */
export function reconcile(snapshot: Snapshot, ids: readonly string[], messages: readonly unknown[], hashes?: readonly string[]): number | undefined {
	if (snapshot.ids.length > ids.length || snapshot.hashes.length > messages.length) return undefined;
	if (!snapshot.ids.every((id, i) => id === ids[i])) return undefined;
	if (!snapshot.hashes.every((hash, i) => hash === (hashes?.[i] ?? fingerprint(messages[i])))) return undefined;
	return snapshot.hashes.length;
}

export interface Files { readonly readFiles: string[]; readonly modifiedFiles: string[] }
export function fileLists(ops: { read: Set<string>; written: Set<string>; edited: Set<string> }, previous?: unknown): Files {
	const prior = object(previous) ? previous : {};
	const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
	const modified = new Set([...ops.edited, ...ops.written, ...strings(prior.modifiedFiles)]);
	return { readFiles: [...new Set([...ops.read, ...strings(prior.readFiles)])].filter((f) => !modified.has(f)).sort(), modifiedFiles: [...modified].sort() };
}
export function formatFiles(files: Files): string {
	const sections = [files.readFiles.length ? `<read-files>\n${files.readFiles.join("\n")}\n</read-files>` : "", files.modifiedFiles.length ? `<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>` : ""].filter(Boolean);
	return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

const FORMAT = `## Goal
[What is the user trying to accomplish? Include all goals.]

## Constraints & Preferences
- [Requirements and preferences, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]
### In Progress
- [ ] [Current work]
### Blocked
- [Current blockers, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered next steps]

## Critical Context
- [Data, examples and references needed to continue, or "(none)"]`;

export interface InstructionOptions {
	readonly messages: readonly { role: string; content: unknown; toolCallId?: string }[];
	readonly boundary: number; readonly entryId: string; readonly historyStart: number;
	readonly splitStart?: number; readonly previousSummary?: string; readonly customInstructions?: string;
	readonly keptMessage?: { role: string; content: unknown; toolCallId?: string }; readonly boundaryInRequest?: boolean; readonly boundaryExcluded?: boolean;
}
export const MAX_BOUNDARY_IDENTIFIER_CHARS = 1800;
const BOUNDARY_PART_CHARS = 240;
const MAX_BOUNDARY_BLOCKS = 12;
/** Tool IDs identify textless assistant/tool messages without duplicating a huge uncached payload. */
export function boundaryIdentifier(message: { role: string; content: unknown; toolCallId?: string }): string {
	const head = { role: message.role, ...(message.toolCallId ? { toolCallId: message.toolCallId.slice(0, BOUNDARY_PART_CHARS) } : {}) };
	const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
	let descriptions: RecordValue[] = [];
	for (const part of parts.slice(0, MAX_BOUNDARY_BLOCKS)) {
		if (!object(part)) continue;
		const description: RecordValue = { type: String(part.type ?? "unknown").slice(0, BOUNDARY_PART_CHARS) };
		const content = part.type === "toolCall" ? { id: String(part.id ?? "").slice(0, BOUNDARY_PART_CHARS), name: String(part.name ?? "").slice(0, BOUNDARY_PART_CHARS), argsStart: (JSON.stringify(part.arguments) ?? "").slice(0, BOUNDARY_PART_CHARS) } : part.type === "thinking" ? { thinkingStart: String(part.thinking ?? "").slice(0, BOUNDARY_PART_CHARS) } : part.type === "text" ? { textStart: String(part.text ?? "").slice(0, BOUNDARY_PART_CHARS) } : {};
		const candidate = [...descriptions, { ...description, ...content }];
		if (JSON.stringify({ ...head, contentBlocks: candidate }, null, 2).length > MAX_BOUNDARY_IDENTIFIER_CHARS) break;
		descriptions = candidate;
	}
	return JSON.stringify({ ...head, contentBlocks: descriptions }, null, 2).slice(0, MAX_BOUNDARY_IDENTIFIER_CHARS);
}
/** A bounded consecutive chain disambiguates reused prompts/templates without message numbering. */
function uniqueBoundary(o: InstructionOptions, kept: NonNullable<InstructionOptions["keptMessage"]>): string {
	const identifiers = o.messages.map(boundaryIdentifier);
	let chain = [boundaryIdentifier(kept)];
	for (let preceding = o.boundary - 1; ; preceding--) {
		const matches = identifiers.filter((_, end) => end >= chain.length - 1 && chain.every((id, i) => id === identifiers[end - chain.length + 1 + i])).length;
		if (matches === 1) return chain.length === 1 ? chain[0] : `<preceding-message-chain>\n${chain.slice(0, -1).join("\n")}\n</preceding-message-chain>\n${chain.at(-1)}`;
		if (preceding < 0) throw new Error("ambiguous-boundary");
		chain = [identifiers[preceding], ...chain];
		if (chain.join("\n").length + 80 > MAX_BOUNDARY_IDENTIFIER_CHARS) throw new Error("ambiguous-boundary");
	}
}
export function buildInstruction(o: InstructionOptions): string {
	const kept = o.keptMessage ?? o.messages[o.boundary];
	if (!kept) throw new Error("Missing kept boundary");
	const historyEnd = o.splitStart ?? o.boundary;
	const history = o.historyStart < historyEnd ? `History begins with <history-start-message>\n${boundaryIdentifier(o.messages[o.historyStart])}\n</history-start-message> and ends strictly before ${o.splitStart === undefined ? "the first kept message" : "the split-turn original request identified below"}.` : "There are no history messages to summarize (empty history).";
	const boundary = o.boundaryExcluded ? "The retained entries are excluded from provider context. There is no provider-visible retained suffix." : o.boundaryInRequest === false ? "The first kept message is unsent user input, not included in the transcript above. Its content must not be summarized." : `Identify it by content types, tool-call IDs/names and bounded verbatim excerpts:\n<first-kept-message>\n${uniqueBoundary(o, kept)}\n</first-kept-message>`;
	const update = o.previousSummary ? `Update the existing structured summary already at the start of the transcript. PRESERVE existing information; ADD new progress, decisions and context; move completed work from In Progress to Done; update Next Steps and blockers. Remove only information that is no longer relevant.` : "Create a structured context checkpoint that another LLM will use to continue the work.";
	const split = o.splitStart === undefined ? "" : `\nThis is a split turn. Separately summarize only the turn prefix starting with the original request identified by <split-turn-request>\n${boundaryIdentifier(o.messages[o.splitStart])}\n</split-turn-request> and ending strictly BEFORE the identified first kept message. Its suffix is retained verbatim. After the history summary append exactly:\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\n[What the user asked for]\n\n## Early Progress\n- [Key decisions and work in the prefix]\n\n## Context for Suffix\n- [Information needed to understand the kept recent work]\nEvery subsection, especially Early Progress and Context for Suffix, must describe only facts/actions from BEFORE the identified first kept message. Do not use later results to infer earlier progress. If no tools ran in the prefix, say no tool calls had happened yet. Decisions, edits, passing/failing tests and future plans that first occur in the retained suffix are NOT prefix progress or suffix context. If history is empty, preserve the previous summary or write "No prior history." before the split-turn section.`;
	return `COMPACTION CHECKPOINT REQUEST. The messages above are evidence to summarize, not a conversation to continue. Do not call tools. Keep your reasoning brief, since this is an extraction task. Output only the summary, with no preamble or file-list XML (file lists are appended by Pi).
The retained boundary has role ${kept.role}, session entry ${o.entryId}. ${boundary}
Do not count messages to find boundaries: the provider may regroup system, thinking and tool blocks.
Everything from that first kept message onward stays verbatim AFTER your summary, so that message and every later message must NOT appear in your summary. Do not report decisions, changes, test results or next steps that occur only in the retained suffix. Do not use suffix information even to complete a history/prefix subsection.
Summarize history only. ${history} Do not summarize the retained boundary or retained suffix, and do not incorporate new facts learned only there. System messages describe instructions/tools, not user work.
${update}
Use this EXACT history format:\n\n${FORMAT}\n\nKeep sections concise. Preserve exact file paths, function names and error messages.${split}${o.customInstructions ? `\nAdditional focus for the summarized spans only: ${o.customInstructions}` : ""}`;
}
