/**
 * Compaction rows get a tool row's band (why it ran, the size before and
 * after, cost and time) but keep Pi's compaction purple, so they stand apart
 * from tool calls: the band leans into the label's mauve, the body sits on
 * the purple Pi draws compaction on.
 */
import {
	CompactionSummaryMessageComponent, estimateTokens,
	type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, truncateToWidth, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { renderBand, timeSeg, type Seg } from "../band/band.ts";
import { mix, parseAnsiColor } from "../band/color.ts";
import { paletteFrom, type Palette } from "../band/palette.ts";
import { bodyBackground, onBackground } from "../band/surface.ts";

/** Pi's compaction purple, or the tool gray when the theme has none. */
function purpleBackground(theme: ThemeLike): string | undefined {
	try {
		const sgr = theme.getBgAnsi("customMessageBg");
		return parseAnsiColor(sgr) ? sgr : bodyBackground(theme);
	} catch { return bodyBackground(theme); }
}
import { formatMoney } from "../status-plus-logic.ts";
import { formatTokens } from "../status-plus-render.ts";
import { sanitize } from "./format.ts";
import { more, painter, plural, type ThemeLike } from "./kit.ts";
import { BODY_INDENT, indent } from "./row.ts";

export const COMPACTION_ENTRY = "pi-extras.compaction-band";
const PREVIEW_LINES = 3;
// How far the band leans from the compaction background toward the label's mauve.
const PURPLE_TINT = 0.22;
type Reason = "threshold" | "manual" | "overflow";
type CompactionSummaryMessage = ConstructorParameters<typeof CompactionSummaryMessageComponent>[0];

interface SavedCompaction {
	readonly entryId: string;
	readonly reason: Reason;
	readonly startedAt?: number;
	readonly durationMs?: number;
	readonly tokensAfter?: number;
}

export interface CompactionData extends Partial<Omit<SavedCompaction, "entryId">> {
	readonly entryId: string;
	readonly cost?: number;
}

export interface CompactionHost {
	enabled(): boolean;
	theme(): ThemeLike | undefined;
	moreHint(): string;
	lookup(message: CompactionSummaryMessage): CompactionData | undefined;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const reasonOf = (value: unknown): value is Reason => value === "threshold" || value === "manual" || value === "overflow";

function savedRecord(data: unknown): SavedCompaction | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as SavedCompaction;
	if (typeof record.entryId !== "string" || !reasonOf(record.reason)) return undefined;
	if ([record.startedAt, record.durationMs, record.tokensAfter].some((value) => value !== undefined && !finite(value))) return undefined;
	return {
		entryId: record.entryId, reason: record.reason,
		...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
		...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
		...(record.tokensAfter !== undefined ? { tokensAfter: record.tokensAfter } : {}),
	};
}

/** Live Pi rows get a fresh timestamp. Only an unambiguous content match may substitute for the saved timestamp. */
export function matchCompaction(message: CompactionSummaryMessage, entries: readonly SessionEntry[]): CompactionData | undefined {
	const matches = entries.filter((entry) => entry.type === "compaction" && entry.summary === message.summary && entry.tokensBefore === message.tokensBefore);
	const exact = matches.filter((entry) => Date.parse(entry.timestamp) === message.timestamp);
	const entry = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
	if (!entry || entry.type !== "compaction") return undefined;
	const saved = entries.filter((item) => item.type === "custom" && item.customType === COMPACTION_ENTRY)
		.map((item) => savedRecord(item.type === "custom" ? item.data : undefined)).findLast((item) => item?.entryId === entry.id);
	const cost = entry.usage?.cost.total;
	return { entryId: entry.id, ...saved, ...(finite(cost) ? { cost } : {}) };
}

/** Like Pi's projected context estimate after a compaction, never trust the kept replies' pre-compaction usage. */
export function estimateAfter(messages: readonly Parameters<typeof estimateTokens>[0][]): number {
	const system = messages.findLast((message) => message.role === "system");
	return messages.filter((message) => message.role !== "system").reduce((sum, message) => sum + estimateTokens(message), system ? estimateTokens(system) : 0);
}

function purple(theme: ThemeLike): Palette | undefined {
	try {
		const palette = paletteFrom(theme);
		const bg = parseAnsiColor(theme.getBgAnsi("customMessageBg"));
		const hue = parseAnsiColor(theme.getFgAnsi("customMessageLabel"));
		return palette && bg && hue ? { ...palette, ok: mix(bg, hue, PURPLE_TINT) } : undefined;
	} catch { return undefined; }
}

/** renderBand's default finished background is green; its fallback must be the compaction surface instead. */
function compactionTheme(theme: ThemeLike): ThemeLike {
	return {
		...theme,
		fg: (key, text) => {
			const painted = theme.fg(key, text);
			return key === "customMessageLabel" ? theme.bold(painted) : painted;
		},
		bg: (key, text) => theme.bg(key === "toolSuccessBg" ? "customMessageBg" : key, text),
		getFgAnsi: (key) => theme.getFgAnsi(key),
		getBgAnsi: (key) => theme.getBgAnsi(key),
		getColorMode: () => theme.getColorMode(),
		bold: (text) => theme.bold(text),
	};
}

function rail(data: CompactionData | undefined, tokensBefore: number): Seg[] {
	const tokens = `${formatTokens(tokensBefore)}${data?.tokensAfter !== undefined ? ` → ~${formatTokens(data.tokensAfter)}` : ""}`;
	const parts: Seg[] = [{ text: tokens, color: "muted" }];
	if (data?.cost !== undefined) parts.push({ text: `$${formatMoney(data.cost)}`, color: "dim" });
	if (data?.durationMs !== undefined) parts.push(timeSeg(data.durationMs));
	return parts.flatMap((part, index) => index === 0 ? [part] : [{ text: "   ", color: "dim" }, part]);
}

interface Internals {
	readonly message: CompactionSummaryMessage;
	readonly markdownTheme: MarkdownTheme;
	readonly expanded: boolean;
	setExpanded(expanded: boolean): void;
}

function expected(self: unknown): self is Internals {
	if (!self || typeof self !== "object") return false;
	const row = self as Internals;
	return typeof row.message?.summary === "string" && finite(row.message.tokensBefore) && finite(row.message.timestamp)
		&& typeof row.expanded === "boolean" && typeof row.setExpanded === "function" && !!row.markdownTheme;
}

interface Drawing { readonly key: string; readonly theme: ThemeLike; readonly lines: string[] }
type Render = (this: unknown, width: number) => string[];
type Mouse = (this: unknown, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
type Invalidate = (this: unknown) => void;
interface Impl { render: Render; mouse: Mouse; invalidate(self: object): void }
interface Patch { impl?: Impl; readonly render: Render; readonly mouse: Mouse; readonly invalidate?: Invalidate }
const SLOT = Symbol.for("pi-extras.compaction-band");

function drawRow(self: Internals, width: number, theme: ThemeLike, data: CompactionData | undefined, hint: string): string[] {
	const paint = painter(theme);
	const pad = Math.min(BODY_INDENT, Math.max(0, width - 1));
	const inner = Math.max(1, width - pad);
	const text = sanitize(stripTerminalSequences(self.message.summary)).trim();
	const all = new Markdown(text, 0, 0, self.markdownTheme, { color: (line) => paint.fg("toolOutput", line) }).render(inner);
	const shown = self.expanded ? all : all.slice(0, PREVIEW_LINES);
	const body = shown.map((line) => truncateToWidth(line, inner, "…"));
	if (shown.length < all.length) body.push(truncateToWidth(more(paint, { moreHint: () => hint } as never, plural(all.length - shown.length, "more line", "more lines")), inner, "…"));
	const reason = data?.reason === "threshold" ? "auto" : data?.reason;
	const segs: Seg[] = [{ text: "compaction", color: "customMessageLabel", bold: true }, ...(reason ? [{ text: ` ${reason}`, color: "muted" }] : [])];
	const header = renderBand(compactionTheme(theme), purple(theme), { width, phase: { kind: "done", outcome: "ok", sinceMs: Infinity }, segs, rail: rail(data, self.message.tokensBefore), clockMs: 0 });
	return [header, ...onBackground(indent(body, pad), width, purpleBackground(theme))];
}

function implementation(host: CompactionHost, original: Patch): Impl {
	const cache = new WeakMap<object, Drawing>();
	const draw = (self: Internals, width: number, theme: ThemeLike): string[] => {
		const data = host.lookup(self.message);
		const hint = host.moreHint();
		const key = JSON.stringify([width, self.expanded, self.message.summary, self.message.tokensBefore, data, hint]);
		const kept = cache.get(self);
		if (kept?.key === key && kept.theme === theme) return kept.lines;
		const lines = drawRow(self, width, theme, data, hint);
		cache.set(self, { key, theme, lines });
		return lines;
	};
	return {
		invalidate: (self) => { cache.delete(self); },
		render(width) {
			try {
				const theme = host.theme();
				if (host.enabled() && theme && expected(this)) return draw(this, Math.max(1, width), theme);
			} catch { /* A changed Pi component or host leaves the native row intact. */ }
			return original.render.call(this, width);
		},
		mouse(event) {
			try {
				const theme = host.theme();
				if (host.enabled() && theme && expected(this)) {
					draw(this, Math.max(1, event.width), theme);
					if (event.type !== "click" || event.button !== "left") return undefined;
					this.setExpanded(!this.expanded);
					return { handled: true };
				}
			} catch { /* Use Pi's mouse handling when this row cannot be drawn. */ }
			return original.mouse.call(this, event);
		},
	};
}

/** Bypass Box rather than change its padding: undo, disabling and unexpected internals all keep Pi's native row. */
export function installCompactionBand(host: CompactionHost, target: object = CompactionSummaryMessageComponent.prototype): () => void {
	const proto = target as Record<string | symbol, unknown> & { render: Render; handleMouse: Mouse; invalidate?: Invalidate };
	let slot = proto[SLOT] as Patch | undefined;
	if (!slot) {
		if (typeof proto.render !== "function" || typeof proto.handleMouse !== "function") return () => undefined;
		const created: Patch = { render: proto.render, mouse: proto.handleMouse, ...(typeof proto.invalidate === "function" ? { invalidate: proto.invalidate } : {}) };
		proto[SLOT] = created;
		proto.render = function (width) { return (created.impl?.render ?? created.render).call(this, width); };
		proto.handleMouse = function (event) { return (created.impl?.mouse ?? created.mouse).call(this, event); };
		if (created.invalidate) proto.invalidate = function () {
			if (this && typeof this === "object") created.impl?.invalidate(this);
			created.invalidate!.call(this);
		};
		slot = created;
	}
	const owned = slot;
	const impl = implementation(host, slot);
	owned.impl = impl;
	return () => { if (owned.impl === impl) owned.impl = undefined; };
}

interface SessionHost {
	enabled(): boolean;
	now(): number;
	moreHint(): string;
}

/** Records are custom entries, outside model context, and reconstructed only from the active branch. */
export function registerCompaction(pi: ExtensionAPI, host: SessionHost): { start(ctx: ExtensionContext): void; stop(): void } {
	let context: ExtensionContext | undefined;
	let started: { readonly at: number; readonly signal: AbortSignal } | undefined;
	let live: readonly SessionEntry[] = [];
	let undo: (() => void) | undefined;
	const branch = () => context?.sessionManager?.getBranch?.() ?? [];
	const stop = () => { undo?.(); undo = undefined; context = undefined; started = undefined; live = []; };
	const start = (ctx: ExtensionContext) => {
		stop();
		if (ctx.mode !== "tui") return;
		context = ctx;
		undo = installCompactionBand({
			...host, theme: () => ctx.ui.theme as unknown as ThemeLike,
			lookup: (message) => matchCompaction(message, [...branch(), ...live]),
		});
	};
	pi.on("session_before_compact", (event) => { if (context) started = { at: host.now(), signal: event.signal }; });
	pi.on("session_compact_failed", () => { started = undefined; });
	pi.on("session_compact", (event, ctx) => {
		if (!context) return;
		const timing = started;
		started = undefined;
		const data: SavedCompaction = {
			entryId: event.compactionEntry.id, reason: event.reason,
			...(timing && !timing.signal.aborted ? { startedAt: timing.at, durationMs: Math.max(0, host.now() - timing.at) } : {}),
			tokensAfter: estimateAfter(ctx.sessionManager.buildSessionProjection().messages),
		};
		try {
			pi.appendEntry(COMPACTION_ENTRY, data);
		} catch {
			live = [...live, { type: "custom", customType: COMPACTION_ENTRY, data } as SessionEntry];
			ctx.ui.notify("Could not save compaction timing and sizes. They apply to this session only.", "warning");
		}
	});
	return { start, stop };
}
