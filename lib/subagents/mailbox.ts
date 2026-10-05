/**
 * Mail for a child that has not reached its session yet. Pi keeps a steered
 * message only in memory until the child reads it between tool calls, and
 * writes it to the session file then; the team keeps a copy on the record, in
 * the index, until it shows up in the transcript.
 */
import type { AgentRecord } from "./types.ts";

function userText(message: unknown): string | undefined {
	const entry = message as { role?: unknown; content?: unknown };
	if (entry.role !== "user") return undefined;
	if (typeof entry.content === "string") return entry.content;
	if (!Array.isArray(entry.content)) return undefined;
	return entry.content.map((part) => (part as { type?: unknown; text?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").join("");
}

/** The steered messages that no user message in `messages` carries yet; late ones are joined into a prompt, so containment counts. */
export function stillUnread(unread: readonly string[], messages: readonly unknown[]): string[] {
	const said = messages.map(userText).filter((text): text is string => text !== undefined);
	return unread.filter((text) => !said.some((message) => message.includes(text)));
}

/** A run that ended without reading what was steered into it: its session's queue is gone, so the next run gets the rest first. */
export function unreadToInbox(record: AgentRecord, messages: readonly unknown[]): Partial<AgentRecord> {
	if (!record.unread?.length) return {};
	const inbox = [...stillUnread(record.unread, messages), ...(record.inbox ?? [])];
	return { unread: undefined, inbox: inbox.length > 0 ? inbox : undefined };
}
