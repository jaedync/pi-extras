/** Display-only interpretation of remote-pi's detail-free mesh envelope. */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Seg } from "../band/band.ts";
import { expandable, expansionMemory, markdownOf, messageBody, type MarkdownSource } from "../band/message.ts";
import { purpleBackground, renderPurpleBand } from "../band/purple.ts";
import { sanitize } from "./format.ts";

export const MESH_MESSAGE_TYPE = "remote-pi:mesh-message";
const PREVIEW_LINES = 8;

export interface MeshMessage {
	readonly from: string;
	readonly id: string;
	readonly re?: string;
	readonly text: string;
}

/** Remove only the transport's trailing footer, never similar text inside the message body. */
export function parseMeshMessage(content: unknown): MeshMessage | undefined {
	if (typeof content !== "string") return undefined;
	const normalized = content.replace(/\r\n/g, "\n");
	const header = /^\[agent-network\] message from "([^\n]+)" \(id=([^,\n)]+)(?:, re=([^\n)]+))?\):\n/.exec(normalized);
	if (!header) return undefined;
	const [, from, id, re] = header;
	if (!from?.trim() || !id?.trim() || (re !== undefined && !re.trim())) return undefined;
	const footer = re ? "(This is a reply to a previous message of yours.)"
		: `(If a reply is expected, call agent_send with to="${from}" and re="${id}".)`;
	const raw = normalized.slice(header[0].length).trimEnd();
	const text = raw.endsWith(`\n\n${footer}`) ? raw.slice(0, -footer.length - 2) : raw;
	return { from, id, ...(re ? { re } : {}), text };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: "text"; text: string } => !!part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n");
}

function sender(from: string): Seg[] {
	const at = from.lastIndexOf("@");
	const name = at >= 0 ? from.slice(at + 1) : from;
	const cwd = at >= 0 ? from.slice(0, at).replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) : undefined;
	return [{ text: name || from, color: "customMessageLabel", bold: true },
		...(cwd ? [{ text: `  ${cwd}`, color: "dim" }] : []), { text: " → me", color: "dim" }];
}

export function createMeshMessageRenderer(markdown?: MarkdownSource): MessageRenderer {
	const memory = expansionMemory();
	return (message, options, theme) => {
		const raw = sanitize(stripTerminalSequences(textOf(message.content)));
		const envelope = parseMeshMessage(raw);
		const segs: Seg[] = envelope ? sender(envelope.from) : [{ text: "mesh → me", color: "customMessageLabel", bold: true }];
		const rail: Seg[] = [{ text: envelope?.re ? "replies" : "message", color: "dim" }];
		return expandable((width, expanded) => [renderPurpleBand(theme, { width, phase: { kind: "calm" }, segs, rail, clockMs: 0 }),
			...messageBody(theme, width, envelope?.text ?? raw, "text", expanded ? null : PREVIEW_LINES,
				envelope ? markdownOf(markdown) : undefined, purpleBackground(theme))], options.expanded, message as object, memory);
	};
}
