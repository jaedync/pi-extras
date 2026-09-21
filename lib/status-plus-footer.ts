/**
 * The status-plus footer: the Claude Code statusline grid, then one aligned
 * row per provider with spend this session.
 *
 *   12:00 ██████████░░░░░░░░░░ 112k / 272k   │ gpt-5.6-sol high │ $2.82 · 19m │ ~/projects/example-app (main) · e2e
 *          12 prompts · 31 turns · 48 tools  │ 1.2M in · 310k write · 9.8M read · 48k out  │ cache 92% · 2m warm
 *   Ant   $1.84 · 12m05s │ 9.4M in · 41k out │ 5h 47% · 7d 12% · $87/$100 left │ 3pm · Sun 12:47am
 *
 * The renderer is pure: the extension assembles a FooterModel from Pi's
 * context, and this file only lays it out. Everything renders dim except the
 * model, the session total, and figures that need attention. Narrow terminals
 * remove decorative dots first, then shorten the place, drop the row token
 * column, the reset column, airtime and fourth grid column. Reported token classes never merge;
 * when necessary the tokens get their own line before truncation.
 */
import { overlayVisible, padEndVisible, padStartVisible, truncateStart, truncateVisible, visibleWidth } from "./ansi.ts";
import { formatDuration, formatMoney, hhmm, type LimitEntry } from "./status-plus-logic.ts";
import { spendText } from "./status-plus-spend.ts";
import { meshText, type MeshState } from "./status-plus-mesh.ts";
import {
	cacheState as _cacheState,
	compareProviderIds,
	contextBar,
	fadeFg,
	formatTokens,
	limitText,
	modelParts,
	providerColor,
	providerTag,
	resetLabel,
	rgb,
	thinkingTone,
	type CacheState,
	type Painter,
} from "./status-plus-render.ts";

export interface FooterRow {
	id: string;
	cost: number;
	airtimeMs: number;
	/** All input sent to this provider (fresh plus cache writes and reads) and its output; the grid line splits the classes. */
	tokens: { input: number; output: number };
	entries: LimitEntry[];
	/** Shown after the limits, e.g. "billing Zen" once a Go window is exhausted. */
	billingNote?: string;
	/** Shown instead of limits when a provider exposes none. */
	note?: string;
}

export interface FooterModel {
	nowMs: number;
	/**
	 * End of the last completed API call. The clock cell shows THIS, not the
	 * wall time: the footer re-renders on a timer, so a live clock would just
	 * tick, while "when was the cache last kept warm" is the figure that
	 * matters next to the warmth tone. Undefined before the first call.
	 */
	lastApiEndMs?: number;
	cache: CacheState;
	context: { usedTokens: number; windowTokens: number; percent: number | undefined };
	modelName: string;
	/** Provider of the active model; colours the model id in that provider's identity colour. */
	providerId?: string;
	thinkingLevel?: string;
	/**
	 * Figures to show in the spend cell while a counter animation plays. When
	 * absent the cell shows the row totals. `flash` is 0 to 1: how far the
	 * cell is tinted toward the error red, fading back to text as it settles.
	 * A positive `delta` overpaints airtime and neighboring cells without resizing the grid.
	 */
	spend?: { cost: number; airtimeMs: number; flash: number; delta?: number };
	counters: { prompts: number; turns: number; toolCalls: number };
	cwd: string;
	gitBranch?: string | null;
	sessionName?: string | null;
	/** Fresh input, cache writes, cache reads and output, each on its own: the four billing classes. */
	tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
	cacheHitPct?: number;
	rows: FooterRow[];
	/** remote-pi's session, relay and device state, folded into one grid cell. */
	mesh?: MeshState;
	/** Every other extension's status; each still gets its own plain line. */
	extensionStatuses: string[];
}

const MODEL_CELL_MAX = 26;
/** Below this the fourth column (place / cache) is dropped rather than mangled. */
const TAIL_CELL_MIN = 8;
/** Decoration is optional: keep it only with a full layout and breathing room. */
const DECORATION_SPARE = 8;
const ELLIPSIS = "…";
/** Each variant also drops everything the earlier ones dropped. */
type RowVariant = "full" | "no-tokens" | "no-resets" | "no-airtime";
const ROW_VARIANTS: RowVariant[] = ["full", "no-tokens", "no-resets", "no-airtime"];

function rowKeeps(variant: RowVariant, cell: "tokens" | "resets" | "airtime"): boolean {
	const dropped = { tokens: 1, resets: 2, airtime: 3 }[cell];
	return ROW_VARIANTS.indexOf(variant) < dropped;
}

function joiner(paint: Painter): string {
	return paint.fg("dim", " │ ");
}

function fieldSeparator(compact: boolean): string {
	return compact ? " " : " · ";
}

/** Everything is dim unless it needs attention; the context figure turns at 70 and 90 percent. */
function contextText(paint: Painter, model: FooterModel): string {
	const text = `${formatTokens(model.context.usedTokens)} / ${formatTokens(model.context.windowTokens)}`;
	const pct = model.context.percent ?? 0;
	return paint.fg(pct > 90 ? "error" : pct > 70 ? "warning" : "dim", text);
}

/**
 * Keep reported writes separate at every width, but omit them when zero.
 * Pi normalizes absent cache fields to zero; omission avoids both placeholder
 * noise and a claim that writes were explicitly reported as zero. Input is
 * never relabeled as writes. Reads remain the normalized recorded total.
 */
function tokensCell(model: FooterModel, compact: boolean): string {
	const { input, cacheWrite, cacheRead, output } = model.tokens;
	return [
		`${formatTokens(input)} in`,
		...(cacheWrite > 0 ? [`${formatTokens(cacheWrite)} write`] : []),
		`${formatTokens(cacheRead)} read`,
		`${formatTokens(output)} out`,
	].join(fieldSeparator(compact));
}

function countersText(model: FooterModel, compact: boolean): string {
	const { prompts, turns, toolCalls } = model.counters;
	return [`${prompts} prompts`, `${turns} turns`, `${toolCalls} tools`].join(fieldSeparator(compact));
}

function placeText(model: FooterModel, compact: boolean): string {
	const branch = model.gitBranch ? ` (${model.gitBranch})` : "";
	const session = model.sessionName ? `${fieldSeparator(compact)}${model.sessionName}` : "";
	return `${model.cwd}${branch}${session}`;
}

/** Model id in its provider's colour, effort level in Pi's thinking-level ramp. */
function modelCell(paint: Painter, model: FooterModel): string {
	const parts = modelParts(model.modelName, model.thinkingLevel, MODEL_CELL_MAX);
	const color = providerColor(model.providerId);
	const id = color ? rgb(parts.id, color) : paint.fg("text", parts.id);
	return parts.level ? `${id} ${paint.fg(thinkingTone(parts.level), parts.level)}` : id;
}

function cacheText(paint: Painter, model: FooterModel, room: number, compact: boolean): string {
	const label = paint.fg(model.cache.tone, model.cache.label);
	if (model.cacheHitPct === undefined) return label;
	const pct = `${Math.round(model.cacheHitPct)}%`;
	const sep = fieldSeparator(compact);
	const full = `${paint.fg("dim", `cache ${pct}${sep}`)}${label}`;
	if (visibleWidth(full) <= room) return full;
	const short = `${paint.fg("dim", `${pct}${sep}`)}${label}`;
	return visibleWidth(short) <= room ? short : label;
}

/**
 * The statusline grid. Column widths are negotiated like the shell version:
 * every cell hugs its content, the first column is the wider of the clock
 * line (last completed call, toned by cache warmth) and the counters, and the token totals on line two may widen the
 * cost cell so separators still line up. Whatever width is left goes to the place and cache cell.
 */
interface Grid {
	lines: string[];
	/** True when the mesh cell needs its own line because the tail had no room. */
	meshOverflow: boolean;
}

function gridLines(model: FooterModel, paint: Painter, width: number, compact: boolean): Grid {
	const sep = joiner(paint);
	const clock = paint.fg(model.cache.tone, model.lastApiEndMs ? hhmm(model.lastApiEndMs) : "--:--");
	const clockContent = `${clock} ${contextBar(paint, model.context.percent ?? 0)} ${contextText(paint, model)}`;
	const counters = paint.fg("dim", countersText(model, compact));
	const firstWidth = Math.max(visibleWidth(clockContent), visibleWidth(counters));
	const modelText = modelCell(paint, model);
	const modelWidth = visibleWidth(modelText);
	// The settled total decides the digit count; a moving figure borrows it so the cell never changes width mid-tween.
	const settledCost = model.rows.reduce((sum, row) => sum + row.cost, 0);
	const totalCost = model.spend?.cost ?? settledCost;
	const totalAirtime = model.spend?.airtimeMs ?? model.rows.reduce((sum, row) => sum + row.airtimeMs, 0);
	const costText = spendText(totalCost, settledCost, totalAirtime, compact);
	// Money leaving: the moving figure fades through the error red, not a neutral accent.
	const costCell = fadeFg(paint, "error", "text", model.spend?.flash ?? 0, costText.trimEnd());
	const midBase = modelWidth + visibleWidth(sep) + visibleWidth(costText);
	const tokensText = tokensCell(model, compact);
	const midWidth = Math.max(midBase, visibleWidth(tokensText));
	const costWidth = midWidth - modelWidth - visibleWidth(sep);

	const first = [padEndVisible(clockContent, firstWidth), modelText, padEndVisible(costCell, costWidth)];
	// Counters end where the context figure ends, right-aligned under the bar.
	const second = [padStartVisible(counters, firstWidth), padEndVisible(paint.fg("dim", tokensText), midWidth)];
	const room = width - firstWidth - midWidth - 3 * visibleWidth(sep);
	let meshPlaced = false;
	if (room >= TAIL_CELL_MIN) {
		first.push(paint.fg("dim", truncateStart(placeText(model, compact), room, ELLIPSIS)));
		const cache = cacheText(paint, model, room, compact);
		const mesh = meshText(paint, model.mesh, compact);
		// The mesh cell shares the tail with the cache figure when both fit.
		const joined = mesh ? `${cache}${sep}${mesh}` : cache;
		meshPlaced = Boolean(mesh) && visibleWidth(joined) <= room;
		second.push(meshPlaced ? joined : cache);
	}
	const meshOverflow = Boolean(model.mesh) && !meshPlaced;
	// A narrow terminal may need a third header line. Preserve reported token
	// figures rather than quietly folding writes or cutting off the output.
	const secondLine = second.join(sep).trimEnd();
	const baseline = first.join(sep);
	const increment = spendText(totalCost, settledCost, totalAirtime, compact, model.spend?.delta);
	// Paint after layout: even a covered separator and the surviving path suffix keep their resting positions.
	const topLine = increment === costText ? baseline : overlayVisible(
		baseline, firstWidth + modelWidth + 2 * visibleWidth(sep),
		fadeFg(paint, "error", "text", model.spend?.flash ?? 0, padEndVisible(increment, visibleWidth(costText))),
	);
	const lines = visibleWidth(secondLine) <= width
		? [topLine, secondLine]
		: [topLine, counters, paint.fg("dim", tokensText)];
	return { lines, meshOverflow };
}

interface RowCells {
	tag: string;
	cost: string;
	airtime: string;
	tokens: string;
	limits: string;
	resets: string;
}

function rowCells(row: FooterRow, paint: Painter, now: number, variant: RowVariant, compact: boolean): RowCells {
	const inline = !rowKeeps(variant, "resets");
	const limitParts = row.entries.map((entry) => limitText(paint, entry, now, inline)).filter(Boolean);
	let limits = limitParts.length ? limitParts.join(paint.fg("dim", fieldSeparator(compact))) : paint.fg("dim", row.note ?? "");
	if (row.billingNote) limits += `   ${paint.fg("warning", row.billingNote)}`;
	// Windows often share a reset (7d and 7d-fable); say it once.
	const resets = rowKeeps(variant, "resets")
		? [...new Set(row.entries
			.filter((entry) => entry.resetMs && entry.resetMs > now)
			.map((entry) => resetLabel(entry.resetMs as number, now, entry.resetApprox)))]
			.join(fieldSeparator(compact))
		: "";
	return {
		tag: providerTag(paint, row.id),
		cost: paint.fg("dim", `$${formatMoney(row.cost)}`),
		airtime: rowKeeps(variant, "airtime") ? paint.fg("dim", formatDuration(row.airtimeMs, true)) : "",
		tokens: rowKeeps(variant, "tokens")
			? paint.fg("dim", `${formatTokens(row.tokens.input)} in${fieldSeparator(compact)}${formatTokens(row.tokens.output)} out`)
			: "",
		limits,
		resets: paint.fg("dim", resets),
	};
}

function rowLines(rows: FooterRow[], paint: Painter, now: number, variant: RowVariant, compact: boolean): string[] {
	const cells = rows.map((row) => rowCells(row, paint, now, variant, compact));
	const width = (pick: (cell: RowCells) => string) => Math.max(0, ...cells.map((cell) => visibleWidth(pick(cell))));
	const tagWidth = width((cell) => cell.tag);
	const costWidth = width((cell) => cell.cost);
	const airWidth = width((cell) => cell.airtime);
	const tokensWidth = width((cell) => cell.tokens);
	const limitsWidth = width((cell) => cell.limits);
	const anyResets = cells.some((cell) => visibleWidth(cell.resets) > 0);
	const fieldSep = paint.fg("dim", fieldSeparator(compact));
	return cells.map((cell) => {
		let line = `${padEndVisible(cell.tag, tagWidth)}  ${padStartVisible(cell.cost, costWidth)}`;
		if (rowKeeps(variant, "airtime")) line += `${fieldSep}${padStartVisible(cell.airtime, airWidth)}`;
		if (rowKeeps(variant, "tokens")) line += `${joiner(paint)}${padEndVisible(cell.tokens, tokensWidth)}`;
		line += `${joiner(paint)}${padEndVisible(cell.limits, limitsWidth)}`;
		if (anyResets) line += visibleWidth(cell.resets) ? `${joiner(paint)}${cell.resets}` : paint.fg("dim", " │");
		return line.trimEnd();
	});
}

function fits(lines: string[], width: number): boolean {
	return lines.every((line) => visibleWidth(line) <= width);
}

function firstFitting(candidates: string[][], width: number, paint: Painter): string[] {
	const chosen = candidates.find((lines) => fits(lines, width)) ?? candidates[candidates.length - 1];
	return chosen.map((line) => truncateVisible(line, width, paint.fg("dim", ELLIPSIS)));
}

export function renderFooter(model: FooterModel, width: number, paint: Painter): string[] {
	const rows = [...model.rows]
		.filter((row) => row.cost > 0)
		.sort((left, right) => compareProviderIds(left.id, right.id));
	// Decoration is negotiated from the resting grid, never from the temporary overpaint.
	const settledModel = model.spend ? { ...model, spend: { ...model.spend, delta: undefined } } : model;
	const decorated = [...gridLines(settledModel, paint, Infinity, false).lines, ...rowLines(rows, paint, model.nowMs, "full", false)];
	const compact = !fits(decorated, width - DECORATION_SPARE);
	const { lines: gridRaw, meshOverflow } = gridLines(model, paint, width, compact);
	const grid = gridRaw.map((line) => truncateVisible(line.trimEnd(), width, paint.fg("dim", ELLIPSIS)));
	const rowBlock = rows.length
		? firstFitting(
			ROW_VARIANTS.map((variant) => rowLines(rows, paint, model.nowMs, variant, compact)),
			width, paint,
		)
		: [];
	const meshLine = meshOverflow ? [truncateVisible(meshText(paint, model.mesh, compact), width, paint.fg("dim", ELLIPSIS))] : [];
	const statuses = model.extensionStatuses
		.map((text) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
		.filter(Boolean)
		.map((text) => truncateVisible(text, width, paint.fg("dim", ELLIPSIS)));
	return [...grid, ...meshLine, ...rowBlock, ...statuses];
}

export { _cacheState as cacheState };
