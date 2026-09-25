/**
 * Tool Display: clearer rows for Pi's built-in tools, and an opt-in compact
 * density toggled with /tool-display.
 *
 * Pi draws a tool row with the renderers on the tool's definition, so this
 * re-registers each built-in tool under its own name: the definition Pi
 * would build, unchanged, with these renderers on it. Only the terminal
 * display changes; the model sees the same tools, descriptions and results.
 *
 * Registration waits for session_start. Tools registered while extensions
 * load are all switched on, which would enable grep, find and ls in sessions
 * that had them off; replacing a tool that already exists keeps the active set
 * as it was. A tool another extension already replaced is left alone.
 */
import { pathToFileURL } from "node:url";
import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, getAgentDir, getLanguageFromPath,
	highlightCode, keyHint, renderDiff, SettingsManager,
	type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { editRenderers, readRenderers, writeRenderers } from "./files.ts";
import type { Kit } from "./kit.ts";
import { searchRenderers } from "./search.ts";
import { bashRenderers } from "./shell.ts";
import { DENSITIES, readDensity, writeDensity } from "./settings.ts";
import type { Density } from "./slot.ts";

export const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const DISABLED = new Set(["0", "off", "false", "no"]);

export function toolDisplayEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	return !DISABLED.has((env.PI_TOOL_DISPLAY ?? "").trim().toLowerCase());
}

type AnyTool = ToolDefinition<any, any, any>;

export interface ToolDisplayDeps {
	/** The definitions Pi builds for its own tools in this session. */
	readonly definitions: (ctx: ExtensionContext) => Record<ToolName, AnyTool>;
	readonly density: { read(): Density; write(density: Density): void };
	readonly kit: Omit<Kit, "density">;
}

function renderersFor(kit: Kit, bash: ReturnType<typeof bashRenderers>): Record<ToolName, Pick<AnyTool, "renderCall" | "renderResult">> {
	return {
		read: readRenderers(kit),
		bash,
		edit: editRenderers(kit),
		write: writeRenderers(kit),
		grep: searchRenderers(kit, "grep"),
		find: searchRenderers(kit, "find"),
		ls: searchRenderers(kit, "ls"),
	} as unknown as Record<ToolName, Pick<AnyTool, "renderCall" | "renderResult">>;
}

/** The built-in definition with only its presentation replaced. */
export function withDisplay(definition: AnyTool, renderers: Pick<AnyTool, "renderCall" | "renderResult">): AnyTool {
	return { ...definition, renderShell: "self", renderCall: renderers.renderCall, renderResult: renderers.renderResult };
}

export function registerToolDisplay(pi: ExtensionAPI, deps: ToolDisplayDeps): void {
	let density: Density = "boxed";
	const owned = new Set<string>();
	const kit: Kit = { ...deps.kit, density: () => density };
	const bash = bashRenderers(kit);
	const renderers = renderersFor(kit, bash);

	pi.on("session_start", (_event, ctx) => {
		// Rows from the previous session are gone, so their elapsed-time timers can stop.
		bash.stopTimers();
		density = deps.density.read();
		// Rows are only drawn by the terminal UI; print, JSON and RPC runs keep Pi's tools untouched.
		if (ctx.mode !== "tui") return;
		const current = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const definitions = deps.definitions(ctx);
		for (const name of TOOL_NAMES) {
			const tool = current.get(name);
			if (!tool || (tool.sourceInfo.source !== "builtin" && !owned.has(name))) continue;
			pi.registerTool(withDisplay(definitions[name], renderers[name]));
			owned.add(name);
		}
	});

	pi.on("session_shutdown", () => bash.stopTimers());

	pi.registerCommand("tool-display", {
		description: "Show tool rows boxed (Pi's look) or compact",
		getArgumentCompletions: (prefix) => {
			const items = DENSITIES.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value, description: value === "boxed" ? "Background boxes, as Pi draws them" : "A status mark instead of a box, half the height" }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const wanted = args.trim().toLowerCase();
			if (wanted && !DENSITIES.includes(wanted as Density)) {
				ctx.ui.notify(`Unknown option "${wanted}". Use /tool-display, /tool-display boxed or /tool-display compact.`, "warning");
				return;
			}
			density = wanted ? wanted as Density : density === "boxed" ? "compact" : "boxed";
			let saved = true;
			try { deps.density.write(density); } catch { saved = false; }
			const other = density === "boxed" ? "compact" : "boxed";
			const note = owned.size === 0 ? " No tool rows are drawn by Tool Display in this session." : saved ? "" : " Could not save the setting, so it applies to this session only.";
			ctx.ui.notify(`Tool rows are ${density}. /tool-display ${other} switches back.${note}`, saved && owned.size > 0 ? "info" : "warning");
		},
	});
}

/** The options Pi passes its own tools, from the same settings. */
function builtInDefinitions(ctx: ExtensionContext): Record<ToolName, AnyTool> {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const cwd = ctx.cwd;
	return {
		read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
		bash: createBashToolDefinition(cwd, { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() }),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	} as Record<ToolName, AnyTool>;
}

export function productionDeps(): ToolDisplayDeps {
	return {
		definitions: builtInDefinitions,
		density: { read: () => readDensity(), write: (density) => writeDensity(density) },
		kit: {
			hint: () => {
				try { return keyHint("app.tools.expand", "to expand"); } catch { return "ctrl+o to expand"; }
			},
			highlight: (code, lang) => highlightCode(code, lang),
			language: (path) => getLanguageFromPath(path),
			diff: (diff) => renderDiff(diff),
			link: (styled, absolutePath) => (getCapabilities().hyperlinks ? hyperlink(styled, pathToFileURL(absolutePath).href) : styled),
			now: () => Date.now(),
		},
	};
}

export default function toolDisplay(pi: ExtensionAPI): void {
	if (!toolDisplayEnabled(process.env)) return;
	registerToolDisplay(pi, productionDeps());
}
