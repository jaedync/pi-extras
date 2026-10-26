import { DEFAULT_BACKGROUND_PERCENT, FORMAT, isMeridian, type ModelIdentity } from "./core.ts";

export { DEFAULT_BACKGROUND_PERCENT };
/** Meridian locks each session key for a whole turn; a key of its own lets the main turn run beside the summary. */
export const BACKGROUND_SESSION_SUFFIX = ":background";
/** A summary plus kept tail above this share of Pi's trigger would compact again soon after. */
export const MAX_AFTER_SHARE = 0.5;

/** From the percent of Pi's trigger (contextWindow - reserveTokens) up to the trigger. Pi compacts above it at once, so a request then is too late. */
export function backgroundDue(tokens: number, trigger: number, percent: number): boolean {
	return trigger > 0 && Number.isFinite(tokens) && tokens >= (trigger * percent) / 100 && tokens <= trigger;
}

/** The trigger is Pi's: contextWindow - reserveTokens. */
export function tailFits(tokensAfter: number, trigger: number): boolean {
	return trigger > 0 && tokensAfter <= trigger * MAX_AFTER_SHARE;
}

/**
 * Only Meridian gets a new session key. Other providers may route their cache by the session,
 * and the payload keeps its own cache key, so their headers stay as captured.
 */
export function backgroundHeaders(model: Pick<ModelIdentity, "api" | "baseUrl">, sessionId: string, headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!isMeridian(model)) return headers;
	const rest = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "x-session-affinity"));
	return { ...rest, "x-session-affinity": `${sessionId}${BACKGROUND_SESSION_SUFFIX}` };
}

export interface FileOps { readonly read: Set<string>; readonly written: Set<string>; readonly edited: Set<string> }
type Call = { readonly name?: unknown; readonly arguments?: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function addCall(ops: FileOps, call: Call): void {
	const path = object(call.arguments) ? call.arguments.path : undefined;
	if (typeof path !== "string" || !path) return;
	if (call.name === "read") ops.read.add(path);
	else if (call.name === "write") ops.written.add(path);
	else if (call.name === "edit") ops.edited.add(path);
}

/** Pi's own rule (it does not export it): read, write and edit calls, also those a codemode script made. */
export function fileOpsOf(messages: readonly { readonly role: string }[]): FileOps {
	const ops: FileOps = { read: new Set(), written: new Set(), edited: new Set() };
	for (const message of messages as readonly Record<string, unknown>[]) {
		if (message.role === "toolResult" && object(message.nestedCalls) && Array.isArray(message.nestedCalls.calls)) {
			for (const call of message.nestedCalls.calls) if (object(call)) addCall(ops, call);
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) if (object(block) && block.type === "toolCall") addCall(ops, block);
	}
	return ops;
}

/**
 * The background request summarizes the whole request it shares, so it needs no boundary:
 * the reply to that request and everything after it stay verbatim after the summary.
 */
export function backgroundInstruction(o: { readonly previousSummary?: boolean }): string {
	const update = o.previousSummary
		? "Update the existing structured summary already at the start of the transcript. PRESERVE existing information; ADD new progress, decisions and context; move completed work from In Progress to Done; update Next Steps and blockers. Remove only information that is no longer relevant."
		: "Create a structured context checkpoint that another LLM will use to continue the work.";
	return `COMPACTION CHECKPOINT REQUEST. The messages above are evidence to summarize, not a conversation to continue. Do not call tools. Keep your reasoning brief, since this is an extraction task. Output only the summary, with no preamble or file-list XML (file lists are appended by Pi).
Summarize the whole transcript above. The conversation continues after it: the next assistant reply and every later message stay verbatim after your summary. The latest user request may still be in progress. State it in full, with its constraints, and say what was done for it so far. System messages describe instructions/tools, not user work.
${update}
Use this EXACT format:\n\n${FORMAT}\n\nKeep sections concise. Preserve exact file paths, function names and error messages.`;
}
