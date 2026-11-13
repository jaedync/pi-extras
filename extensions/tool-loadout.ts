/**
 * Tool Loadout. Tools named in `toolLoadout.codemodeOnly` (pi-extras.json) stay active and callable
 * from `codemode` scripts, but requests leave their declarations out, so a rarely used tool costs no
 * input tokens on every turn. It works for any package's tools: Pi keeps the first registration of a
 * name, so no extension can re-register another's tool, but a `prepareLoadout` hook may hide any
 * declared tool (Pi's `hiddenDeclarations`). The hook needs an active tool to live on: a model-only
 * tool that hides its own declaration too. Scripts still see the full description and rules through
 * `describeTool()`, so a tool keeps its limits; tell the model which tools are hidden (AGENTS.md).
 *
 * A message that another extension sends (for example pi-agent-goal's /goal prompts) can tell the
 * model to call a hidden tool by name. Such a message gets a note on calling that tool from
 * `codemode`. The note goes into the new user message only, so the system prompt and the declared
 * tools stay the same for the whole session and the prompt cache stays valid.
 *
 * Children do not load this extension (subagents/child.ts excludes its tool), so they keep the
 * tools declared: they have no `codemode`.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readSection } from "../lib/extras-config.ts";

export const LOADOUT_TOOL = "tool_loadout";
const CODEMODE = "codemode";
/** Hiding these would leave the model without its own way to call the rest. */
const NEVER_HIDDEN: ReadonlySet<string> = new Set([CODEMODE, "read", "bash", "edit", "write", "powershell"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface LoadoutConfig {
	readonly codemodeOnly: readonly string[];
}

export function parseLoadoutConfig(section: Record<string, unknown>): LoadoutConfig {
	const raw = Array.isArray(section.codemodeOnly) ? section.codemodeOnly : [];
	const names = raw.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter((name) => TOOL_NAME.test(name));
	return { codemodeOnly: [...new Set(names)] };
}

/**
 * The declarations to leave out: this tool's own, and each listed tool that is declared now. With no
 * `codemode` declared a hidden tool could not be reached at all, so then only this tool hides.
 */
export function hiddenNames(declared: readonly { name: string }[], codemodeOnly: readonly string[]): string[] {
	const present = new Set(declared.map((tool) => tool.name));
	if (!present.has(CODEMODE)) return [LOADOUT_TOOL];
	const hidden = codemodeOnly.filter((name) => present.has(name) && name !== LOADOUT_TOOL && !NEVER_HIDDEN.has(name));
	return [LOADOUT_TOOL, ...hidden];
}

/** The hidden tools that a text names as whole words, in the order the text first names them. */
export function namedHiddenTools(text: string, active: readonly string[], codemodeOnly: readonly string[]): string[] {
	const reachable = hiddenNames(active.map((name) => ({ name })), codemodeOnly).filter((name) => name !== LOADOUT_TOOL);
	return reachable
		.map((name) => ({ name, at: text.search(new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`)) }))
		.filter((found) => found.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((found) => found.name);
}

/** The name a codemode script uses for a tool: characters invalid in an identifier become `_`. */
function scriptName(name: string): string {
	const id = name.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[0-9]/.test(id) ? `_${id}` : id;
}

export function codemodeNote(names: readonly [string, ...string[]]): string {
	return `(Tool note: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} not declared in this session. Call ${names.length === 1 ? "it" : "them"} from a codemode script, for example \`await tools.${scriptName(names[0])}({ ... })\`, and read describeTool("${names[0]}") for the parameters and rules first.)`;
}

export interface ToolLoadoutOptions {
	/** The `toolLoadout` section; read from pi-extras.json when omitted. */
	readonly config?: Record<string, unknown>;
}

export default function toolLoadout(pi: ExtensionAPI, options: ToolLoadoutOptions = {}): void {
	const config = parseLoadoutConfig(options.config ?? readSection("toolLoadout"));
	if (config.codemodeOnly.length === 0) return;
	pi.registerTool({
		name: LOADOUT_TOOL,
		label: "Tool Loadout",
		description: "Internal: keeps the declarations of rarely used tools out of requests. Never declared.",
		parameters: Type.Object({}),
		// Model-only: never callable from scripts; its own declaration is hidden by its hook.
		exposure: "model-only",
		prepareLoadout: (loadout) => ({ hiddenDeclarations: hiddenNames(loadout.declared, config.codemodeOnly) }),
		async execute() {
			throw new Error("tool_loadout is not callable.");
		},
	} as ToolDefinition);
	// Only extension messages: a user's own words stay as typed.
	pi.on("input", (event) => {
		if (event.source !== "extension") return { action: "continue" };
		const [first, ...rest] = namedHiddenTools(event.text, pi.getActiveTools(), config.codemodeOnly);
		return first === undefined ? { action: "continue" } : { action: "transform", text: `${event.text}\n\n${codemodeNote([first, ...rest])}` };
	});
}
