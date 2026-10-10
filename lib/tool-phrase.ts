/**
 * What the model is doing while it writes a tool call, in plain words. A
 * write is writing a file and an edit is editing one, named once its path has
 * streamed in; any other call is a call being written (`writing bash call`).
 * The phase line, the terminal tab and a subagent's row all say it this way,
 * so they agree, and a tool named for a verb never reads `writing write call`.
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Tools whose name is what the model is doing to a file while it writes the call. */
const FILE_VERBS = new Map([["write", "writing"], ["edit", "editing"]]);
const MAX_FILE = 48;

/** Model-supplied text with nothing that could move the cursor or reorder the line. */
export function cleanLabel(text: string): string {
	return stripTerminalSequences(text).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\x00-\x20\x7f-\x9f]+/g, " ").trim();
}

/** A tool's name as rows show it; `tool` when it has none worth showing. */
export const toolLabel = (name: string | undefined): string => cleanLabel(name ?? "") || "tool";

/** The file a call's `path` names, once enough of it has streamed in. */
export function fileOf(args: unknown): string {
	const path = (args as { path?: unknown } | null | undefined)?.path;
	if (typeof path !== "string") return "";
	const name = cleanLabel(path).split(/[\\/]/).at(-1) ?? "";
	return name.length > MAX_FILE ? `${name.slice(0, MAX_FILE - 1)}…` : name;
}

export function callPhrase(name: string | undefined, args?: unknown): string {
	const tool = cleanLabel(name ?? "");
	if (!tool) return "writing a tool call";
	const verb = FILE_VERBS.get(tool);
	if (!verb) return `writing ${tool} call`;
	const file = fileOf(args);
	return file ? `${verb} ${file}` : verb;
}
