/**
 * Tool Display: a header band for each of Pi's built-in tool rows, a popup
 * with everything a call did, and a step-by-step view of chained bash
 * commands, and thinking blocks as a live tail of their newest lines.
 * /tool-display switches it, the chain view, motion and the thinking style.
 *
 * Pi draws a tool row with the renderers on the tool's definition, so this
 * re-registers each built-in tool under its own name: the definition Pi
 * would build, with these renderers on it. The model sees the same tools,
 * descriptions and results. The one change beyond display is the bash chain
 * view: a chained command runs with step markers added, which are taken out
 * of the output again before Pi or the model sees it (docs/security.md).
 *
 * Registration waits for session_start. Tools registered while extensions
 * load are all switched on, which would enable grep, find and ls in sessions
 * that had them off; replacing a tool that already exists keeps the active set
 * as it was. A tool another extension already replaced is left alone.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLocalBashOperations, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, getAgentDir,
	getLanguageFromPath, highlightCode, keyHint, renderDiff, SettingsManager,
	type BashOperations, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { AnimationClock } from "../band/clock.ts";
import { openPopup, type PopupHost } from "../band/popup.ts";
import { chainOperations, withChains, type ActiveRuns } from "../chain/exec.ts";
import { CHAIN_ENTRY, CHAIN_EVENT, ChainRun, type SavedChain } from "../chain/run.ts";
import { splitChain } from "../chain/split.ts";
import { TOOL_COUNT_EVENT, writeToolCount, type ToolCount } from "../tool-count.ts";
import { editRenderers, readRenderers, writeRenderers } from "./files.ts";
import type { Kit } from "./kit.ts";
import { searchRenderers } from "./search.ts";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type DisplaySettings } from "./settings.ts";
import { bashRenderers } from "./shell.ts";
import { installThinkingTail, THINKING_MODES, type ThinkingMode, type ThinkingTheme } from "./thinking.ts";

export const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const DISABLED = new Set(["0", "off", "false", "no"]);

export function toolDisplayEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	return !DISABLED.has((env.PI_TOOL_DISPLAY ?? "").trim().toLowerCase());
}

type AnyTool = ToolDefinition<any, any, any>;
type Renderers = Pick<AnyTool, "renderCall" | "renderResult">;

export interface SessionTools {
	/** The definitions Pi builds for its own tools, bash running through `wrap`'s operations. */
	readonly definitions: Record<ToolName, AnyTool>;
	readonly shellPath?: string;
	/** Whether Pi runs in its fullscreen view, where rows take clicks. */
	readonly fullscreen: boolean;
	/** Pi's hide-thinking setting as the session starts. */
	readonly hideThinking?: boolean;
}

/** The host helpers rows need; injected so tests run without a live Pi. */
export type HostKit = Pick<Kit, "highlight" | "language" | "diff" | "fileUrl" | "now"> & {
	readonly expandHint: () => string;
	/** Pi's key for showing thinking blocks, outside the fullscreen UI. */
	readonly thinkingHint?: () => string;
};

export interface ToolDisplayDeps {
	readonly tools: (ctx: ExtensionContext, wrap: (operations: BashOperations) => BashOperations) => SessionTools;
	readonly settings: { read(): DisplaySettings; write(settings: DisplaySettings): void };
	readonly host: HostKit;
	readonly nonce?: () => string;
	/** Saves the Status Plus tool count for `/tool-display count`. */
	readonly writeToolCount: (count: ToolCount) => void;
}

/** The built-in definition with only its presentation replaced. */
export function withDisplay(definition: AnyTool, renderers: Renderers): AnyTool {
	return { ...definition, renderShell: "self", renderCall: renderers.renderCall, renderResult: renderers.renderResult };
}

const USAGE = "/tool-display on|off · chains on|off · motion full|reduced · thinking tail|collapsed|full · count calls|steps";

function describeSettings(settings: DisplaySettings): string {
	if (!settings.enabled) return "Tool Display is off; Pi draws its own tool rows.";
	return `Tool Display is on · chain steps ${settings.chains ? "on" : "off"} · motion ${settings.motion} · thinking ${settings.thinking}.`;
}

/** `count calls` or `count steps`, for the Status Plus tool figure. */
export function countArg(args: string): ToolCount | undefined {
	const words = args.trim().toLowerCase().split(/\s+/);
	return words.length === 2 && words[0] === "count" && (words[1] === "calls" || words[1] === "steps") ? words[1] : undefined;
}

/** Applies a /tool-display argument, or undefined when it isn't one. */
export function applyArgs(settings: DisplaySettings, args: string): DisplaySettings | undefined {
	const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const [first, second] = words;
	if (words.length === 1 && (first === "on" || first === "off")) return { ...settings, enabled: first === "on" };
	if (words.length === 2 && first === "chains" && (second === "on" || second === "off")) return { ...settings, chains: second === "on" };
	if (words.length === 2 && first === "motion" && (second === "full" || second === "reduced")) return { ...settings, motion: second };
	const thinking = THINKING_MODES.find((mode) => mode === second);
	if (words.length === 2 && first === "thinking" && thinking) return { ...settings, thinking };
	return undefined;
}

export function registerToolDisplay(pi: ExtensionAPI, deps: ToolDisplayDeps): void {
	let settings: DisplaySettings = DEFAULT_SETTINGS;
	let ui: PopupHost | undefined;
	let fullscreen = false;
	let popupOpen = false;
	let session: SessionTools | undefined;
	let undoThinking: (() => void) | undefined;
	const owned = new Set<string>();
	const clock = new AnimationClock();
	const active: ActiveRuns = new Map();
	const live = new Map<string, ChainRun>();
	const saved = new Map<string, unknown>();
	const restored = new Map<string, ChainRun | null>();
	const unsaved: SavedChain[] = [];
	const nonce = deps.nonce ?? (() => randomBytes(8).toString("hex"));

	const kit: Kit = {
		...deps.host,
		moreHint: () => (fullscreen ? "click for all" : deps.host.expandHint()),
		motion: () => settings.motion,
		chains: () => settings.chains,
		clock,
		chainRun(toolCallId, command) {
			const run = live.get(toolCallId);
			if (run) return run;
			if (!saved.has(toolCallId)) return undefined;
			if (!restored.has(toolCallId)) {
				const chain = splitChain(command);
				restored.set(toolCallId, (chain && ChainRun.restore(chain, saved.get(toolCallId))) ?? null);
			}
			return restored.get(toolCallId) ?? undefined;
		},
		openPopup(source) {
			if (!ui || popupOpen) return false;
			popupOpen = true;
			openPopup(ui, source).catch(() => undefined).finally(() => { popupOpen = false; });
			return true;
		},
	};

	const renderers: Record<ToolName, Renderers> = {
		read: readRenderers(kit),
		bash: bashRenderers(kit),
		edit: editRenderers(kit),
		write: writeRenderers(kit),
		grep: searchRenderers(kit, "grep"),
		find: searchRenderers(kit, "find"),
		ls: searchRenderers(kit, "ls"),
	} as unknown as Record<ToolName, Renderers>;

	const hooks = {
		enabled: () => settings.chains,
		now: () => deps.host.now(),
		nonce,
		started: (toolCallId: string, run: ChainRun) => { live.set(toolCallId, run); },
		ended: (toolCallId: string, run: ChainRun) => {
			unsaved.push(run.save(toolCallId));
			pi.events.emit(CHAIN_EVENT, { toolCallId, ran: run.ran() });
		},
	};

	// Saved between turns rather than mid-call, so an entry never lands between a tool call and its result.
	const flush = () => {
		for (const entry of unsaved.splice(0)) {
			try { pi.appendEntry(CHAIN_ENTRY, entry); } catch { /* The live view still has it; only a resume loses the steps. */ }
		}
	};

	/** Puts this session's built-in tools in place, drawn by Tool Display or, when it is off, by Pi again. */
	const install = () => {
		if (!session) return;
		const current = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		for (const name of TOOL_NAMES) {
			const tool = current.get(name);
			if (!tool || (tool.sourceInfo.source !== "builtin" && !owned.has(name))) continue;
			let definition = session.definitions[name];
			if (!settings.enabled) {
				if (owned.has(name)) pi.registerTool(definition);
				continue;
			}
			if (name === "bash") definition = withChains(definition, session.shellPath, active, hooks) as AnyTool;
			pi.registerTool(withDisplay(definition, renderers[name]));
			owned.add(name);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		// Rows from the previous session are gone, so nothing of theirs needs to animate.
		clock.stop();
		live.clear();
		saved.clear();
		restored.clear();
		settings = deps.settings.read();
		clock.setReduced(settings.motion === "reduced");
		// Rows are only drawn by the terminal UI; print, JSON and RPC runs keep Pi's tools untouched.
		if (ctx.mode !== "tui") return;
		ui = ctx.ui as unknown as PopupHost;
		for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
			if (entry.type === "custom" && entry.customType === CHAIN_ENTRY) {
				const data = entry.data as { toolCallId?: unknown } | undefined;
				if (typeof data?.toolCallId === "string") saved.set(data.toolCallId, data);
			}
		}
		session = deps.tools(ctx, (operations) => chainOperations(operations, active, () => deps.host.now()));
		fullscreen = session.fullscreen;
		const hiddenAtStart = session.hideThinking ?? false;
		const host = ctx.ui as { theme?: ThinkingTheme };
		undoThinking?.();
		undoThinking = installThinkingTail({
			mode: (): ThinkingMode | undefined => (settings.enabled ? settings.thinking : undefined),
			hiddenAtStart: () => hiddenAtStart,
			theme: () => host.theme,
			hint: () => (fullscreen ? "click for all" : deps.host.thinkingHint?.() ?? "ctrl+t to expand"),
		});
		install();
	});

	pi.on("turn_end", flush);
	pi.on("agent_end", flush);
	pi.on("session_shutdown", () => {
		flush();
		clock.stop();
		undoThinking?.();
		undoThinking = undefined;
	});

	pi.registerCommand("tool-display", {
		description: "Switch Tool Display, its bash chain steps, its motion, or how thinking shows",
		getArgumentCompletions: (prefix) => {
			const options = [
				["on", "Draw tool rows with header bands"],
				["off", "Go back to Pi's own tool rows"],
				["chains on", "Break chained bash commands into steps"],
				["chains off", "Run chained bash commands as written"],
				["motion full", "Animated progress and finish"],
				["motion reduced", "A steady tint; times still count"],
				["thinking tail", "Thinking shows its newest three lines"],
				["thinking collapsed", "Thinking shows only its label"],
				["thinking full", "Thinking shows everything"],
				["count calls", "Status Plus counts one per tool call"],
				["count steps", "Status Plus counts each step a chain ran"],
			] as const;
			const wanted = prefix.trim().toLowerCase();
			const items = options.filter(([value]) => value.startsWith(wanted)).map(([value, description]) => ({ value, label: value, description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (args.trim() === "") {
				ctx.ui.notify(`${describeSettings(settings)} ${USAGE}`, "info");
				return;
			}
			const count = countArg(args);
			if (count !== undefined) {
				// Status Plus owns this setting; a click on its tool figure does the same.
				let saved = true;
				try { deps.writeToolCount(count); } catch { saved = false; }
				pi.events.emit(TOOL_COUNT_EVENT, count);
				const what = count === "steps" ? "each step a chained command ran" : "one per tool call";
				ctx.ui.notify(`The Status Plus tool count now counts ${what}.${saved ? "" : " Could not save the setting, so it applies to this session only."}`, saved ? "info" : "warning");
				return;
			}
			const next = applyArgs(settings, args);
			if (!next) {
				ctx.ui.notify(`Unknown option "${args.trim()}". Use ${USAGE}.`, "warning");
				return;
			}
			const toggled = next.enabled !== settings.enabled;
			settings = next;
			clock.setReduced(settings.motion === "reduced");
			let saved = true;
			try { deps.settings.write(settings); } catch { saved = false; }
			if (toggled) install();
			const note = saved ? "" : " Could not save the setting, so it applies to this session only.";
			const reach = !toggled && next.enabled && owned.size === 0 ? " No tool rows are drawn by Tool Display in this session." : "";
			ctx.ui.notify(`${describeSettings(settings)}${reach}${note}`, saved && !reach ? "info" : "warning");
		},
	});
}

/** The options Pi passes its own tools, from the same settings. */
function sessionTools(ctx: ExtensionContext, wrap: (operations: BashOperations) => BashOperations): SessionTools {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const cwd = ctx.cwd;
	const shellPath = settings.getShellPath();
	const operations = wrap(createLocalBashOperations({ shellPath }));
	return {
		definitions: {
			read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
			bash: createBashToolDefinition(cwd, { operations, commandPrefix: settings.getShellCommandPrefix(), shellPath }),
			edit: createEditToolDefinition(cwd),
			write: createWriteToolDefinition(cwd),
			grep: createGrepToolDefinition(cwd),
			find: createFindToolDefinition(cwd),
			ls: createLsToolDefinition(cwd),
		} as Record<ToolName, AnyTool>,
		...(shellPath ? { shellPath } : {}),
		fullscreen: settings.getTuiMode() === "fullscreen",
		hideThinking: settings.getHideThinkingBlock(),
	};
}

export function productionDeps(): ToolDisplayDeps {
	return {
		tools: sessionTools,
		settings: { read: () => readSettings(), write: (settings) => writeSettings(settings) },
		writeToolCount,
		host: {
			expandHint: () => {
				try { return keyHint("app.tools.expand", "to expand"); } catch { return "ctrl+o to expand"; }
			},
			thinkingHint: () => {
				try { return keyHint("app.thinking.toggle", "to expand"); } catch { return "ctrl+t to expand"; }
			},
			highlight: (code, lang) => highlightCode(code, lang),
			language: (path) => getLanguageFromPath(path),
			diff: (diff) => renderDiff(diff),
			fileUrl: (absolutePath) => (getCapabilities().hyperlinks ? pathToFileURL(absolutePath).href : undefined),
			now: () => Date.now(),
		},
	};
}

export default function toolDisplay(pi: ExtensionAPI): void {
	if (!toolDisplayEnabled(process.env)) return;
	registerToolDisplay(pi, productionDeps());
}
