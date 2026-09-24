/**
 * /computer-use: status, the apps mode, and a checklist of the apps the agent
 * may always use. Changes are collected and saved together on enter; anything
 * that widens access (checking an app, turning on Allow all) is confirmed in
 * the panel first, with the risk spelled out.
 */
import { decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { hints, rule, type Paint } from "./paint.ts";
import { MODES, type AppsMode } from "./settings.ts";

export type StatusLevel = "ok" | "problem" | "info";
export interface StatusItem { readonly level: StatusLevel; readonly text: string }
export interface PanelApp { readonly bundleId: string; readonly name: string; readonly running?: boolean }
export interface PanelResult { readonly mode: AppsMode; readonly allow: string[]; readonly revoke: string[] }

export interface PanelInit {
	readonly status: readonly StatusItem[];
	readonly mode: AppsMode;
	/** The apps checked now, shown before the full list arrives. */
	readonly allowed: readonly PanelApp[];
	/** Every app Computer Use can see; listing them may start the client. */
	readonly apps: Promise<readonly PanelApp[]>;
	/** Why the checklist cannot be changed, when the approvals file is not in a format we write. */
	readonly locked?: string;
	readonly requestRender: () => void;
}

const LIST_ROWS = 12;
const MAX_NAME = 24;
export const MODE_LABEL: Record<AppsMode, string> = { ask: "Ask per app", all: "Allow all", none: "Allow none" };
const MODE_HELP: Record<AppsMode, string> = {
	ask: "Checked apps are used without asking. Any other app asks you first.",
	all: "Every app is allowed without asking, including browsers and mail. Your checks are kept for when you switch back.",
	none: "Every computer use call is refused, even for checked apps. Your checks are kept.",
};
/** The service's own refusals are not listed anywhere we can read, so this names only what it was seen to refuse. */
export const ALLOW_ALL_WARNING = "The agent will use any app without asking, including browsers and mail, until you switch back. The Computer Use service still refuses some apps, such as terminals.";
const STATUS_MARK: Record<StatusLevel, [string, "success" | "error" | "muted"]> = { ok: ["✓", "success"], problem: ["✗", "error"], info: ["○", "muted"] };

function names(apps: readonly PanelApp[]): string {
	const list = apps.map((app) => app.name);
	return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

export class AppsPanel implements Component {
	private readonly paint: Paint;
	private readonly done: (result: PanelResult | "cancel") => void;
	private readonly initialMode: AppsMode;
	private readonly initial: ReadonlySet<string>;
	private readonly status: readonly StatusItem[];
	private readonly locked?: string;
	private mode: AppsMode;
	private checked: Set<string>;
	private apps: readonly PanelApp[];
	private loading = true;
	private loadError?: string;
	private filter = "";
	private cursor = 0;
	private scroll = 0;
	private confirming = false;
	private finished = false;

	constructor(init: PanelInit, paint: Paint, done: (result: PanelResult | "cancel") => void) {
		this.paint = paint;
		this.done = done;
		this.status = init.status;
		this.locked = init.locked;
		this.mode = this.initialMode = init.mode;
		this.apps = [...init.allowed].sort((a, b) => a.name.localeCompare(b.name));
		this.initial = new Set(this.apps.map((app) => app.bundleId));
		this.checked = new Set(this.initial);
		init.apps.then((listed) => {
			// Checked apps first, then the rest in Computer Use's order (running and recent first).
			const known = new Map(listed.map((app) => [app.bundleId, app]));
			const checked = this.apps.map((app) => known.get(app.bundleId) ?? app);
			this.apps = [...checked, ...listed.filter((app) => !this.initial.has(app.bundleId))];
			this.loading = false;
			init.requestRender();
		}, (error: unknown) => {
			this.loading = false;
			this.loadError = error instanceof Error ? error.message : String(error);
			init.requestRender();
		});
	}

	private visible(): readonly PanelApp[] {
		const needle = this.filter.toLowerCase();
		return needle ? this.apps.filter((app) => app.name.toLowerCase().includes(needle) || app.bundleId.toLowerCase().includes(needle)) : this.apps;
	}

	private result(): PanelResult {
		const ids = this.apps.map((app) => app.bundleId);
		return {
			mode: this.mode,
			allow: ids.filter((id) => this.checked.has(id) && !this.initial.has(id)),
			revoke: ids.filter((id) => !this.checked.has(id) && this.initial.has(id)),
		};
	}

	/** Only changes that widen access need a second look. */
	private widens(result: PanelResult): boolean {
		return result.allow.length > 0 || (result.mode === "all" && this.initialMode !== "all");
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (this.confirming) {
			if (matchesKey(data, "enter")) this.finish(this.result());
			else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.confirming = false;
			return;
		}
		const visible = this.visible();
		if (matchesKey(data, "up")) this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, "down")) this.cursor = Math.min(visible.length - 1, this.cursor + 1);
		else if (matchesKey(data, "pageUp")) this.cursor = Math.max(0, this.cursor - LIST_ROWS);
		else if (matchesKey(data, "pageDown")) this.cursor = Math.min(visible.length - 1, this.cursor + LIST_ROWS);
		else if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const step = matchesKey(data, "right") ? 1 : MODES.length - 1;
			this.mode = MODES[(MODES.indexOf(this.mode) + step) % MODES.length];
		} else if (matchesKey(data, "space")) this.toggle(visible[this.cursor]);
		else if (matchesKey(data, "enter")) {
			const result = this.result();
			if (this.widens(result)) this.confirming = true;
			else this.finish(result);
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.filter) this.setFilter("");
			else this.finish("cancel");
		} else if (matchesKey(data, "backspace")) this.setFilter(this.filter.slice(0, -1));
		else {
			const char = decodeKittyPrintable(data) ?? (data.length === 1 && data > " " && data !== "\x7f" ? data : undefined);
			if (char && char !== " ") this.setFilter(this.filter + char);
		}
		this.cursor = Math.max(0, Math.min(this.cursor, this.visible().length - 1));
	}

	private toggle(app: PanelApp | undefined): void {
		if (!app || this.locked) return;
		const next = new Set(this.checked);
		if (next.has(app.bundleId)) next.delete(app.bundleId);
		else next.add(app.bundleId);
		this.checked = next;
	}

	private setFilter(filter: string): void {
		this.filter = filter;
		this.cursor = 0;
		this.scroll = 0;
	}

	private finish(result: PanelResult | "cancel"): void {
		this.finished = true;
		this.done(result);
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const body = [
			this.paint.fg("toolTitle", this.paint.bold("Computer use")),
			...wrapTextWithAnsi(this.status.map((item) => `${this.paint.fg(STATUS_MARK[item.level][1], STATUS_MARK[item.level][0])} ${this.paint.fg("text", item.text)}`).join("   "), inner),
			"",
			...this.modeLines(inner),
			"",
			...this.listLines(inner),
			"",
			...(this.confirming ? this.confirmLines(inner) : wrapTextWithAnsi(hints(this.paint, [["↑↓", "move"], ...(this.locked ? [] : [["space", "check"] as const]), ["←→", "mode"], ["type", "filter"], ["enter", "save"], ["esc", "cancel"]]), inner)),
		];
		return [rule(this.paint, width), "", ...body.map((line) => truncateToWidth(line ? ` ${line}` : "", width, "…")), "", rule(this.paint, width)];
	}

	private modeLines(inner: number): string[] {
		const { paint } = this;
		const options = MODES.map((mode) => mode === this.mode ? paint.fg("accent", paint.bold(`● ${MODE_LABEL[mode]}`)) : paint.fg("muted", `○ ${MODE_LABEL[mode]}`));
		const help = wrapTextWithAnsi(paint.fg("muted", MODE_HELP[this.mode]), Math.max(10, inner - 6)).map((line) => `      ${line}`);
		return [`${paint.bold("Apps")}  ${options.join("   ")}`, ...help];
	}

	private listLines(inner: number): string[] {
		const { paint } = this;
		const visible = this.visible();
		const overridden = this.mode !== "ask";
		const count = this.loading ? `${this.checked.size} checked` : `${this.checked.size} of ${this.apps.length} checked`;
		const filter = this.filter ? `   ${paint.fg("accent", `filter: ${this.filter}`)}` : "";
		const lines = [`${paint.bold("Always allowed")}  ${paint.fg("muted", overridden ? `${count}, not used while ${MODE_LABEL[this.mode]} is on` : count)}${filter}`];
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		if (this.cursor >= this.scroll + LIST_ROWS) this.scroll = this.cursor - LIST_ROWS + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, visible.length - LIST_ROWS)));
		const shown = visible.slice(this.scroll, this.scroll + LIST_ROWS);
		const nameWidth = Math.min(MAX_NAME, Math.max(0, ...shown.map((app) => app.name.length)));
		if (this.scroll > 0) lines.push(paint.fg("muted", `  ↑ ${this.scroll} more`));
		shown.forEach((app, index) => {
			const current = this.scroll + index === this.cursor;
			const on = this.checked.has(app.bundleId);
			const was = this.initial.has(app.bundleId);
			const tone = overridden ? "dim" : "text";
			const box = on ? `[${paint.fg(overridden ? "dim" : "success", "✓")}]` : paint.fg("muted", "[ ]");
			const name = truncateToWidth(app.name, nameWidth, "…").padEnd(nameWidth);
			const change = on && !was ? `  ${paint.fg("warning", "will allow")}` : !on && was ? `  ${paint.fg("muted", "will stop")}` : "";
			const running = app.running ? `  ${paint.fg("dim", "running")}` : "";
			const mark = current ? paint.fg("accent", "›") : " ";
			lines.push(`${mark} ${box} ${paint.fg(tone, current ? paint.bold(name) : name)}  ${paint.fg("muted", app.bundleId)}${running}${change}`);
		});
		const below = visible.length - this.scroll - shown.length;
		if (below > 0) lines.push(paint.fg("muted", `  ↓ ${below} more`));
		if (this.filter && visible.length === 0) lines.push(paint.fg("muted", "  No app matches the filter."));
		if (this.loading) lines.push(paint.fg("muted", "  Loading apps…"));
		if (this.locked) lines.push(...wrapTextWithAnsi(paint.fg("warning", `Can't change these here: ${this.locked}.`), inner - 2).map((line) => `  ${line}`));
		if (this.loadError) lines.push(...wrapTextWithAnsi(paint.fg("error", `Couldn't list apps: ${this.loadError}`), inner - 2).map((line) => `  ${line}`));
		return lines;
	}

	private confirmLines(inner: number): string[] {
		const { paint } = this;
		const result = this.result();
		const added = this.apps.filter((app) => result.allow.includes(app.bundleId));
		const lines: string[] = [];
		if (added.length > 0) {
			lines.push(paint.fg("warning", paint.bold(`Always allow ${names(added)}?`)));
			lines.push(...wrapTextWithAnsi(paint.fg("text", `The agent will use ${added.length === 1 ? "it" : "them"} without asking, in every Pi session and in ChatGPT and Codex computer use. Browsers, mail and messaging apps carry a prompt injection risk: text shown in them can steer the agent.`), inner));
		}
		if (result.mode === "all" && this.initialMode !== "all") {
			if (lines.length) lines.push("");
			lines.push(paint.fg("warning", paint.bold("Turn on Allow all?")));
			lines.push(...wrapTextWithAnsi(paint.fg("text", ALLOW_ALL_WARNING), inner));
		}
		lines.push("", hints(paint, [["enter", "confirm"], ["esc", "back"]]));
		return lines;
	}

	invalidate(): void {}
}
