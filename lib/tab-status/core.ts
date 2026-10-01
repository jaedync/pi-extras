export { terminalSupport } from "./terminal.ts";
export interface Settings {
	enabled: boolean;
	sessionStatus: "auto" | boolean;
	progress: "auto" | boolean;
	busyWhileBackground: boolean;
	detail: "done" | "reply";
}

export function loadSettings(raw: Record<string, unknown>): Settings {
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
		sessionStatus: typeof raw.sessionStatus === "boolean" ? raw.sessionStatus : "auto",
		progress: typeof raw.progress === "boolean" ? raw.progress : "auto",
		busyWhileBackground: typeof raw.busyWhileBackground === "boolean" ? raw.busyWhileBackground : true,
		detail: raw.detail === "reply" ? "reply" : "done",
	};
}

export function shouldRun(ctx: { hasUI: boolean; mode: string }, tty: boolean): boolean {
	return ctx.hasUI && ctx.mode === "tui" && tty;
}

const LIMIT = 80;
export function sanitize(value: string): string {
	// Remove whole ANSI sequences before removing their introducers, so color codes do not become prose.
	const plain = value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	return [...(plain.split(/\r\n|[\r\n\u0085\u2028\u2029]/, 1)[0] ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu, "").trim()].slice(0, LIMIT).join("");
}

export function escapeValue(value: string): string {
	return sanitize(value).replaceAll("\\", "\\\\").replaceAll(";", "\\;");
}

export type Progress = 0 | 2 | 3 | 4;
export interface View { status: "working" | "waiting" | "idle"; color: string; detail: string; progress: Progress }
export function statusSequence(value?: Pick<View, "status" | "color" | "detail">): string {
	const fields = { status: value?.status ?? "", indicator: value?.color ?? "", "status-color": value?.color ?? "", detail: value?.detail ?? "" };
	return `\x1b]21337;${Object.entries(fields).map(([key, text]) => `${key}=${escapeValue(text)}`).join(";")}\x1b\\`;
}
// iTerm2's earlier paused implementation required a percentage; 100 keeps it visible.
// Windows Terminal gets the documented form with an explicit percentage. Its error state
// keeps the given value and draws 0 as a sliver, so a failed turn fills the ring instead.
// https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences
export const progressSequence = (state: Progress, windows = false): string =>
	`\x1b]9;4;${state}${state === 4 || (windows && state === 2) ? ";100" : windows ? ";0" : ""}\x07`;
export const passthrough = (sequence: string, tmux: boolean): string => tmux ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence;

export interface State {
	running: boolean;
	compacting: boolean;
	dialog?: string;
	failure?: string;
	lastText: string;
	phase: string;
	tools: Readonly<Record<string, string>>;
	background: Readonly<Record<string, number>>;
	rateWait: boolean;
}
export type Action =
	| { type: "begin" | "settled" | "compactStart" | "dialogEnd" }
	| { type: "compactEnd"; retry: boolean }
	| { type: "phase"; text: string }
	| { type: "message"; text: string; error?: string }
	| { type: "toolStart"; id: string; name: string }
	| { type: "toolEnd"; id: string }
	| { type: "dialogStart"; title?: string }
	| { type: "background"; source: string; count: number }
	| { type: "rateWait"; active: boolean };

export const initialState = (): State => ({ running: false, compacting: false, lastText: "", phase: "thinking", tools: {}, background: {}, rateWait: false });

export function transition(state: State, action: Action): State {
	switch (action.type) {
		case "begin": return { ...state, running: true, failure: undefined, phase: "thinking", tools: {} };
		case "settled": return { ...state, running: false, compacting: false, dialog: undefined, tools: {}, rateWait: false };
		case "compactStart": return { ...state, compacting: true, tools: {} };
		case "compactEnd": return { ...state, compacting: false, ...(action.retry ? { running: true, failure: undefined, phase: "retrying" } : {}) };
		case "phase": return { ...state, phase: action.text };
		case "message": return { ...state, lastText: action.text || state.lastText, failure: action.error, phase: action.error ? "retrying" : "thinking" };
		case "toolStart": return { ...state, tools: { ...state.tools, [action.id]: action.name } };
		case "toolEnd": return { ...state, tools: Object.fromEntries(Object.entries(state.tools).filter(([id]) => id !== action.id)), phase: "thinking" };
		case "dialogStart": return { ...state, dialog: action.title || "needs input" };
		case "dialogEnd": return { ...state, dialog: undefined };
		case "background": return { ...state, background: { ...state.background, [action.source]: action.count } };
		case "rateWait": return { ...state, rateWait: action.active, phase: action.active ? "retrying" : "thinking" };
	}
}

export function view(state: State, colors: Record<"accent" | "warning" | "dim" | "error", string>, busyWhileBackground: boolean, detailMode: Settings["detail"] = "done"): View {
	if (state.dialog && (state.running || state.compacting)) return { status: "waiting", color: colors.warning, detail: sanitize(state.dialog), progress: 4 };
	if (state.failure !== undefined && !state.running && !state.compacting) return { status: "waiting", color: colors.error, detail: sanitize(`Error: ${state.failure}`), progress: 2 };
	const background = busyWhileBackground ? Object.entries(state.background).filter(([, count]) => count > 0) : [];
	if (!state.running && !state.compacting && !background.length) return { status: "idle", color: colors.dim, detail: detailMode === "reply" ? sanitize(state.lastText) : "Done", progress: 0 };
	const tools = Object.values(state.tools);
	const [source, count] = background[0] ?? ["", 0];
	const unit = source === "subagents" ? "subagent" : "shell job";
	const detail = state.compacting ? "compacting" : state.rateWait ? "retrying" : tools.length > 1 ? `running ${tools.length} tools` : tools.length ? `running ${tools[0]}` : state.running ? state.phase : `running ${count} ${unit}${count === 1 ? "" : "s"}`;
	return { status: "working", color: colors.accent, detail: sanitize(detail), progress: state.rateWait ? 4 : 3 };
}
