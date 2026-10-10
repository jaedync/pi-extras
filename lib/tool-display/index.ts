/**
 * Tool Display: a header band for every tool row, a popup with everything a
 * call did, a step-by-step view of chained bash commands, and thinking
 * blocks as a live tail of their newest lines. /tool-display switches it,
 * other tools' rows, the chain view, motion and the thinking style.
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
 *
 * Every other tool's rows get the band through Pi's tool row itself (see
 * adopt.ts): pi-extras's own tools with layouts written for them, other
 * extensions' tools with their own words in it (see foreign.ts).
 */
import { randomBytes } from "node:crypto";
import { DISPLAY_SETTINGS_EVENT } from "../extras-config.ts";
import { pathToFileURL } from "node:url";
import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLocalBashOperations, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, getAgentDir,
	getLanguageFromPath, getMarkdownTheme, highlightCode, keyHint, renderDiff, SettingsManager,
	type BashOperations, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { SEP } from "../cc-phase.ts";
import { AnimationClock } from "../band/clock.ts";
import type { ShownOverlay } from "../band/modal.ts";
import { openPopup, type PopupHost } from "../band/popup.ts";
import { chainOperations, withChains, type ActiveRuns } from "../chain/exec.ts";
import { CHAIN_ENTRY, CHAIN_EVENT, ChainRun, type SavedChain } from "../chain/run.ts";
import { splitChain } from "../chain/split.ts";
import { TOOL_COUNT_EVENT, writeToolCount, type ToolCount } from "../tool-count.ts";
import { forgetLate, lateRows, offeredRows, redrawLateMessages } from "../late-rows.ts";
import { markRow, rowKind, shareDrawnTools, type RowKind } from "../tool-row.ts";
import { canAdopt, installAdoption, prepareAdoption, rebuildRow, type RowRenderers } from "./adopt.ts";
import { computerUseSpec, windowsUseSpec } from "./computer.ts";
import { codemodeRenderers } from "./codemode.ts";
import { registerCompaction } from "./compaction.ts";
import { watchRun } from "../run-watch.ts";
import { watchThinking } from "../thinking-watch.ts";
import { createMeshMessageRenderer, MESH_MESSAGE_TYPE } from "./mesh.ts";
import { NestedCalls } from "./nested.ts";
import { editRenderers, readRenderers, writeRenderers } from "./files.ts";
import { foreignRenderers, type ForeignTool } from "./foreign.ts";
import type { Kit } from "./kit.ts";
import { searchRenderers } from "./search.ts";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type DisplaySettings } from "./settings.ts";
import { bashRenderers } from "./shell.ts";
import { toolRenderers, type ToolSpec } from "./tool.ts";
import { usageSpec } from "./usage.ts";
import { webSearchSpec } from "./web.ts";
import { watchFold } from "../fold/index.ts";
import { installThinkingTail, prepareThinkingTail, THINKING_MODES, thoughtLabel, type ThinkingMode, type ThinkingTheme } from "./thinking.ts";

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
	return markRow({ ...definition, renderShell: "self", renderCall: renderers.renderCall, renderResult: renderers.renderResult }, "band");
}

const FOLD_MISSING = "Folded mode can't find Pi's transcript in this session, so every row shows.";

const USAGE = ["/tool-display on|off", "others on|off", "chains on|off", "motion full|reduced", "thinking tail|collapsed|full", "folded on|off", "count calls|steps"].join(SEP);

function describeSettings(settings: DisplaySettings): string {
	if (!settings.enabled) return "Tool Display is off; every tool draws its own rows.";
	return `Tool Display is on${SEP}other tools' rows ${settings.others ? "on" : "off"}${SEP}chain steps ${settings.chains ? "on" : "off"}${SEP}motion ${settings.motion}${SEP}thinking ${settings.thinking}${SEP}folded ${settings.folded ? "on" : "off"}.`;
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
	if (words.length === 2 && first === "others" && (second === "on" || second === "off")) return { ...settings, others: second === "on" };
	if (words.length === 2 && first === "chains" && (second === "on" || second === "off")) return { ...settings, chains: second === "on" };
	if (words.length === 2 && first === "motion" && (second === "full" || second === "reduced")) return { ...settings, motion: second };
	if (words.length === 2 && first === "folded" && (second === "on" || second === "off")) return { ...settings, folded: second === "on" };
	const thinking = THINKING_MODES.find((mode) => mode === second);
	if (words.length === 2 && first === "thinking" && thinking) return { ...settings, thinking };
	return undefined;
}

/** How long a reply thought in all: the sum of its timed thinking runs, or undefined when none was timed. */
export function thoughtFor(message: { timestamp?: number; content: readonly { type: string }[] }, duration: (message: never, run: number) => number | undefined): number | undefined {
	let runs = 0;
	message.content.forEach((part, index) => {
		if (part.type === "thinking" && message.content[index - 1]?.type !== "thinking") runs++;
	});
	let total: number | undefined;
	for (let run = 0; run < runs; run++) {
		const ms = duration(message as never, run);
		if (ms !== undefined) total = (total ?? 0) + ms;
	}
	return total;
}

/** Layouts for pi-extras's own tools, by the mark on their definitions. */
const OWN_SPECS: Partial<Record<RowKind, (name: string) => ToolSpec>> = {
	kagi: webSearchSpec,
	"computer-use": () => computerUseSpec,
	"windows-use": () => windowsUseSpec,
	usage: () => usageSpec,
};

export function registerToolDisplay(pi: ExtensionAPI, deps: ToolDisplayDeps): void {
	// Pi searches every extension for a renderer; the sender need not own it. Register before transcript replay.
	if (typeof pi.registerMessageRenderer === "function") pi.registerMessageRenderer(MESH_MESSAGE_TYPE, createMeshMessageRenderer(() => getMarkdownTheme()));
	let settings: DisplaySettings = DEFAULT_SETTINGS;
	let ui: PopupHost | undefined;
	let fullscreen = false;
	let popup: ShownOverlay | undefined;
	let session: SessionTools | undefined;
	let undoThinking: (() => void) | undefined;
	let undoAdoption: (() => void) | undefined;
	let thinkingActive = false;
	const folding = () => settings.enabled && settings.folded;
	const publishSettings = () => pi.events.emit(DISPLAY_SETTINGS_EVENT, { ...settings, hidesLiveThinking: thinkingActive && settings.enabled, folds: thinkingActive && fold.active() });
	let adopting = false;
	const owned = new Set<string>();
	const adopted = new WeakMap<object, RowRenderers>();
	const clock = new AnimationClock();
	const nested = new NestedCalls(() => deps.host.now());
	const active: ActiveRuns = new Map();
	const live = new Map<string, ChainRun>();
	const saved = new Map<string, unknown>();
	const restored = new Map<string, ChainRun | null>();
	const unsaved: SavedChain[] = [];
	/** What install() last registered under each built-in tool's name. */
	const registered = new Map<string, object>();
	const nonce = deps.nonce ?? (() => randomBytes(8).toString("hex"));
	// In place before a reload rebuilds the transcript, so the rows it builds are noted (see late-rows.ts).
	prepareAdoption();
	prepareThinkingTail();

	const run = watchRun(pi);
	const thinkingDuration = watchThinking(pi, deps.host.now);
	// Its own clock: Tool Display stops `clock` at each session start, which would strand a live line's frames.
	const foldClock = new AnimationClock();
	const fold = watchFold(pi, {
		enabled: folding,
		reduced: () => settings.motion === "reduced",
		busy: run.busy,
		now: () => deps.host.now(),
		frames: (tick) => foldClock.add(tick),
		thoughtMs: (message, live) => thoughtFor(message, (reply, index) => thinkingDuration(reply, index, live)),
		nestedOf: (id) => nested.get(id)?.calls,
		written: run.written,
	});

	const kit: Kit = {
		...deps.host,
		moreHint: () => (fullscreen ? "click for all" : deps.host.expandHint()),
		motion: () => settings.motion,
		streaming: run.streaming,
		written: run.written,
		busy: run.busy,
		chains: () => settings.chains,
		clock,
		nestedCalls: (id) => nested.get(id),
		watchNested: (id, invalidate) => nested.watch(id, invalidate),
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
			// One at a time; one Pi took off screen without closing it no longer counts.
			if (!ui || popup?.isOpen()) return false;
			const shown = openPopup(ui, source);
			popup = shown;
			shown.closed.catch(() => undefined).finally(() => { if (popup === shown) popup = undefined; });
			return true;
		},
	};

	const compaction = registerCompaction(pi, {
		enabled: () => settings.enabled,
		now: () => deps.host.now(),
		moreHint: () => kit.moreHint(),
	});

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
				if (owned.has(name)) {
					pi.registerTool(definition);
					registered.set(name, definition);
				}
				continue;
			}
			if (name === "bash") definition = withChains(definition, session.shellPath, active, hooks) as AnyTool;
			const drawn = withDisplay(definition, renderers[name]);
			pi.registerTool(drawn);
			registered.set(name, drawn);
			owned.add(name);
		}
	};

	/** Band renderers for another tool's rows; undefined leaves them to the tool. */
	const renderersFor = (definition: object): RowRenderers | undefined => {
		const tool = definition as ForeignTool;
		const kind = rowKind(definition);
		const own = kind ? OWN_SPECS[kind] : undefined;
		if (!settings.enabled || kind === "band" || typeof tool.name !== "string") return undefined;
		if (!own && !settings.others) return undefined;
		let renderers = adopted.get(definition);
		if (!renderers) {
			renderers = (own ? toolRenderers(kit, own(tool.name)) : tool.name === "codemode" ? codemodeRenderers(kit, tool) : foreignRenderers(kit, tool)) as unknown as RowRenderers;
			adopted.set(definition, renderers);
		}
		return renderers;
	};

	/**
	 * Rebuilds the rows a reload built before session_start: tool rows with
	 * what is registered now, replies with the thinking tail (see late-rows.ts).
	 */
	const repairLate = () => {
		for (const row of lateRows("tool")) {
			const name = (row as { toolName?: unknown }).toolName;
			const definition = typeof name === "string" ? registered.get(name) ?? offeredRows(name) : undefined;
			try { rebuildRow(row, definition); } catch { /* That row stays as Pi drew it. */ }
		}
		redrawLateMessages();
	};

	pi.on("session_start", (_event, ctx) => {
		// Rows from the previous session are gone, so nothing of theirs needs to animate.
		clock.stop();
		nested.clear();
		live.clear();
		saved.clear();
		restored.clear();
		settings = deps.settings.read();
		clock.setReduced(settings.motion === "reduced");
		foldClock.setReduced(settings.motion === "reduced");
		compaction.start(ctx);
		// Rows are only drawn by the terminal UI; print, JSON and RPC runs keep Pi's tools untouched.
		thinkingActive = false;
		if (ctx.mode !== "tui") { publishSettings(); return; }
		ui = ctx.ui as unknown as PopupHost;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? []) {
			if (entry.type === "message") {
				const message = entry.message as { role?: unknown; toolCallId?: unknown; nestedCalls?: unknown };
				if (message.role === "toolResult" && typeof message.toolCallId === "string") nested.restore(message.toolCallId, message.nestedCalls);
			}
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
			gutter: () => true,
			folds: (reply) => fold.foldsThinking(reply),
			expands: (reply) => fold.expandsThinking(reply),
			summary: (message, index) => thoughtLabel(thinkingDuration(message, index)),
		});
		undoAdoption?.();
		undoAdoption = installAdoption({ renderersFor });
		adopting = canAdopt();
		install();
		shareDrawnTools((name) => registered.get(name));
		repairLate();
		thinkingActive = true;
		if (folding() && !fold.refresh()) ctx.ui.notify(FOLD_MISSING, "warning");
		publishSettings();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		nested.observe(event);
	});
	pi.on("tool_execution_update", (event, ctx) => { if (ctx.mode === "tui") nested.observe(event); });
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		nested.observe(event);
		if (!(event as { parentToolCallId?: string }).parentToolCallId) {
			nested.finish(event.toolCallId);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const message = event.message;
		if (message.role === "toolResult") nested.restore(message.toolCallId, message.nestedCalls);
	});

	const restoreNested = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: unknown; toolCallId?: unknown; nestedCalls?: unknown };
			if (message.role === "toolResult" && typeof message.toolCallId === "string") nested.restore(message.toolCallId, message.nestedCalls);
		}
	};
	pi.on("session_tree", restoreNested);
	pi.on("session_compact", restoreNested);

	pi.on("turn_end", flush);
	pi.on("agent_end", flush);
	pi.on("session_shutdown", () => {
		flush();
		clock.stop();
		nested.clear();
		forgetLate();
		compaction.stop();
		undoThinking?.();
		undoThinking = undefined;
		undoAdoption?.();
		undoAdoption = undefined;
		shareDrawnTools(undefined);
		thinkingActive = false;
		publishSettings();
	});

	pi.registerCommand("tool-display", {
		description: "Switch Tool Display, its bash chain steps, its motion, or how thinking shows",
		getArgumentCompletions: (prefix) => {
			const options = [
				["on", "Draw tool rows with header bands"],
				["off", "Go back to each tool's own rows"],
				["others on", "Draw other extensions' tool rows with bands too"],
				["others off", "Leave other extensions' tool rows to them"],
				["chains on", "Break chained bash commands into steps"],
				["chains off", "Run chained bash commands as written"],
				["motion full", "Animated progress and finish"],
				["motion reduced", "A steady tint; times still count"],
				["thinking tail", "Thinking shows its newest three lines"],
				["thinking collapsed", "Thinking shows only its label"],
				["thinking full", "Thinking shows everything"],
				["folded on", "Each run of work between replies is one line"],
				["folded off", "Show every tool row and thinking block"],
				["count steps", "Status Plus counts each chain step and script call (default)"],
				["count calls", "Status Plus counts one per tool call"],
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
				const what = count === "steps" ? "each step of a chained command and each call a script made" : "one per tool call";
				ctx.ui.notify(`The Status Plus tool count now counts ${what}.${saved ? "" : " Could not save the setting, so it applies to this session only."}`, saved ? "info" : "warning");
				return;
			}
			const next = applyArgs(settings, args);
			if (!next) {
				ctx.ui.notify(`Unknown option "${args.trim()}". Use ${USAGE}.`, "warning");
				return;
			}
			const toggled = next.enabled !== settings.enabled;
			const wasFolding = folding();
			settings = next;
			const refolded = folding() !== wasFolding;
			const folds = refolded ? fold.refresh() : fold.active();
			publishSettings();
			clock.setReduced(settings.motion === "reduced");
			foldClock.setReduced(settings.motion === "reduced");
			let saved = true;
			try { deps.settings.write(settings); } catch { saved = false; }
			if (toggled) install();
			const note = saved ? "" : " Could not save the setting, so it applies to this session only.";
			const reach = folding() && !folds ? ` ${FOLD_MISSING}`
				: !toggled && next.enabled && owned.size === 0 && !adopting ? " No tool rows are drawn by Tool Display in this session." : "";
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
