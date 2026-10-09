/**
 * What a footer walk keeps of a child transcript record. Prompt and reply text,
 * thinking and tool output are nearly all of a child's file, and no walk reads
 * them: a message keeps a hash of its content for its identity and its tool
 * calls for the tool count, and subagent protocol records stay whole because
 * they name the child's own children. The evidence cache then holds a child's
 * history in a small part of its size, so a session's children fit in it.
 */
import { createHash } from "node:crypto";
import { CHAIN_ENTRY } from "./chain/run.ts";
import { isShell } from "./tool-count.ts";

type RecordValue = Record<string, any>;

/** The hash of the content a slim message no longer holds; a symbol, so no message field can clash with it. */
export const CONTENT_HASH = Symbol("status-plus content hash");

export function contentHash(content: unknown): string {
	return createHash("sha256").update(JSON.stringify(content ?? null)).digest("hex");
}

const object = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

function pick(record: RecordValue, keys: readonly string[]): RecordValue {
	const kept: RecordValue = {};
	for (const key of keys) if (record[key] !== undefined) kept[key] = record[key];
	return kept;
}

/** Entries a walk counts besides messages: Tool Display chains, Status Plus markers, subagent notices. */
function countedCustom(type: unknown): boolean {
	const name = String(type ?? "");
	return name === CHAIN_ENTRY || name.startsWith("status-plus") || name.startsWith("subagent");
}

/** Only a shell call's command is read, to count the steps it chains. */
function slimCall(value: unknown): RecordValue {
	const call = object(value);
	if (!call) return {};
	const kept = pick(call, ["type", "id", "name"]);
	return typeof call.name === "string" && isShell(call.name) ? { ...kept, ...pick(call, ["arguments", "args"]) } : kept;
}

function slimMessage(message: RecordValue): RecordValue | undefined {
	const { content, details, nestedCalls, ...rest } = message;
	if (message.role === "user" || message.role === "assistant") {
		const calls = Array.isArray(content) ? content.filter((block) => object(block)?.type === "toolCall").map(slimCall) : [];
		return { ...rest, content: calls, [CONTENT_HASH]: contentHash(content) };
	}
	if (message.role !== "toolResult") return undefined;
	// A subagent's result names its children; other tools' output is never read.
	if (String(message.toolName ?? "").startsWith("subagent")) return message;
	const calls = object(nestedCalls)?.calls;
	return Array.isArray(calls) ? { ...rest, nestedCalls: { calls: calls.map(slimCall) } } : rest;
}

/** A record as a walk reads it, or undefined for one it never reads. */
export function slimRecord(value: unknown): unknown {
	const record = object(value);
	if (!record) return undefined;
	if (record.recordType !== undefined) {
		// Artifact transcripts: only their message records are counted.
		const message = record.recordType === "message" ? object(record.message) : undefined;
		const kept = message && slimMessage(message);
		return kept ? { ...pick(record, ["recordType", "sourceEventType", "timestamp"]), message: kept } : undefined;
	}
	switch (record.type) {
		case "message": {
			const message = object(record.message);
			const kept = message && slimMessage(message);
			return kept ? { ...pick(record, ["type", "id", "timestamp"]), message: kept } : undefined;
		}
		case "session": return pick(record, ["type", "id", "timestamp", "parentSession"]);
		case "compaction":
		case "branch_summary": return pick(record, ["type", "id", "timestamp", "usage"]);
		case "model_change": return pick(record, ["type", "id", "timestamp", "provider", "modelId"]);
		case "usage": return pick(record, ["type", "id", "timestamp", "kind", "provider", "model", "usage"]);
		case "custom":
		case "custom_message": return countedCustom(record.customType) ? record : undefined;
		default: return undefined;
	}
}
