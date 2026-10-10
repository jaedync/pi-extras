/**
 * Turns a tool's description of its row into Pi's two renderers. A spec says
 * what the band's title is, what else the rail shows, what goes under the
 * band and in the body, and what the popup holds; the timing, animation,
 * clicks and popup wiring are the same for every tool. Everything under the
 * band sits on the theme's tool gray, so a call reads as one block apart
 * from the conversation around it.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Outcome, Seg } from "../band/band.ts";
import { plainText, UNWRAPPED, type PopupSource } from "../band/popup.ts";
import { draftPreview } from "../band/draft.ts";
import type { SheetCopy } from "../band/sheet.ts";
import { bodyBackground, onBackground } from "../band/surface.ts";
import { painter, type Kit, type Paint, type RenderContext, type ThemeLike } from "./kit.ts";
import { animate, band, BODY_INDENT, indent, phaseOf, rail, rowState, slotFor, tookMs, track, type RowState } from "./row.ts";
import type { BandPhase } from "../band/band.ts";

export type ResultInput = { content?: unknown; details?: unknown };

export interface View {
	readonly kit: Kit;
	readonly context: RenderContext;
	readonly row: RowState;
	readonly theme: ThemeLike;
	readonly paint: Paint;
	readonly result: ResultInput | undefined;
	readonly now: number;
}

export interface ToolSpec {
	/** Absent means unknown. Titles and user arguments never select an animation. */
	readonly name?: string;
	/** The popup's title, e.g. `bash, 3 commands`. */
	label(view: View): string;
	title(view: View): Seg[];
	timeoutMs?(view: View): number | undefined;
	/** Rail text before the time, e.g. `2 of 3`. */
	lead?(view: View, phase: BandPhase): Seg[];
	/** How a failure reads in the rail, e.g. `exit 1`; the default is `failed`. */
	failure?(view: View): Seg[] | undefined;
	outcome?(view: View): Outcome | undefined;
	/** Whether the row's own lines still move after its band has settled, so it keeps asking for frames. */
	moving?(view: View): boolean;
	/** Lines under the band in the call slot, drawn at full width. */
	below?(view: View, width: number): string[];
	/** The result slot's lines, drawn indented under the band's title. */
	body(view: View, width: number): string[];
	details?(view: View): string;
	head?(view: View, width: number, selected: number): string[];
	steps?(view: View): number;
	firstStep?(view: View): number;
	/** One bounded identity list, rather than a callback that rebuilds state per index. */
	stepKeys?(view: View): readonly string[];
	outputLabel?(view: View, selected: number): string;
	output(view: View, width: number, selected: number): string[];
	/** Copies raw data instead of formatted output, which may contain layout padding. */
	copies?(view: View, selected: number): readonly SheetCopy[];
}

function viewOf(kit: Kit, row: RowState): View | undefined {
	if (!row.context || !row.theme) return undefined;
	return { kit, context: row.context, row, theme: row.theme, paint: painter(row.theme), result: row.result as ResultInput | undefined, now: kit.now() };
}

export function bandOf(spec: ToolSpec, view: View): { segs: Seg[]; rail: Seg[]; phase: BandPhase; toolName: string } {
	const phase = phaseOf(view.row, view.context, view.now, spec.timeoutMs?.(view), view.kit.written?.(view.context.toolCallId) === true);
	const failure = spec.failure?.(view);
	const segs = spec.title(view);
	const railSegs = rail(phase, tookMs(view.row, view.now), { lead: spec.lead?.(view, phase) ?? [], ...(failure ? { failure } : {}) });
	return { segs, rail: railSegs, phase, toolName: spec.name ?? "" };
}

/** A bash call copies its command, a file tool its path, and every tool its output. */
function copiesOf(spec: ToolSpec, view: () => View, selected: number): readonly SheetCopy[] {
	if (spec.copies) return spec.copies(view(), selected);
	const args = (view().context.args ?? {}) as { command?: unknown; path?: unknown };
	const arg = typeof args.command === "string" ? { label: "copy command", text: args.command }
		: typeof args.path === "string" ? { label: "copy path", text: args.path } : undefined;
	const output = () => plainText(spec.output(view(), UNWRAPPED, selected)) || undefined;
	return [...(arg ? [{ label: arg.label, key: "c", text: () => arg.text }] : []), { label: "copy output", key: "o", text: output }];
}

export function popupSource(kit: Kit, spec: ToolSpec, row: RowState): PopupSource {
	const view = () => viewOf(kit, row)!;
	return {
		copies: (selected) => copiesOf(spec, view, selected),
		label: () => spec.label(view()),
		band: (theme, width) => {
			const current = { ...view(), theme };
			return band(theme, kit, bandOf(spec, current), width);
		},
		details: () => spec.details?.(view()) ?? "",
		head: (theme, width, selected) => spec.head?.({ ...view(), theme, paint: painter(theme) }, width, selected) ?? [],
		stepCount: () => spec.steps?.(view()) ?? 0,
		firstStep: () => spec.firstStep?.(view()) ?? 0,
		...(spec.stepKeys ? { stepKeys: () => spec.stepKeys!(view()) } : {}),
		outputLabel: (selected) => spec.outputLabel?.(view(), selected) ?? "output",
		output: (theme, width, selected) => spec.output({ ...view(), theme, paint: painter(theme) }, width, selected),
		live: () => (row.context?.isPartial ?? false) || (spec.moving?.(view()) ?? false),
	};
}

/** A call row's margin: its spinner, or kept blank for a call that isn't being written now. */
export function rowMargin(kit: Kit, row: RowState, phase: BandPhase): true | "blank" {
	// A session resumed after a crash rebuilds a call that never got its result as still being written.
	const writtenNow = row.live === true && (kit.streaming?.() ?? true);
	return phase.kind === "writing" && !writtenNow ? "blank" : true;
}

export function toolRenderers(kit: Kit, spec: ToolSpec) {
	const open = (row: RowState) => () => (row.context && row.theme ? kit.openPopup(popupSource(kit, spec, row)) : false);
	return {
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const row = rowState(context);
			row.theme = theme;
			row.live ??= kit.streaming?.() ?? true;
			track(row, context, kit.now());
			return slotFor(context).onClick(open(row)).set((width) => {
				const view = viewOf(kit, row)!;
				const drawn = bandOf(spec, view);
				const margin = rowMargin(kit, row, drawn.phase);
				// A call no longer written now (its message ended) keeps no clock.
				const input = margin === "blank" ? { ...drawn, phase: { kind: "writing" } as const, rail: [] } : drawn;
				animate(row, kit, input.phase, spec.moving?.(view) ?? false, margin === true);
				const own = spec.below?.(view, width) ?? [];
				// A row that draws nothing of its own while written shows the newest lines of what the model writes.
				const draft = own.length === 0 && input.phase.kind === "writing" && margin === true && row.draft
					? indent(draftPreview(row.draft, width - BODY_INDENT, view.now, theme, kit.motion())) : [];
				return [band(theme, kit, input, width, margin), ...onBackground([...own, ...draft], width, bodyBackground(theme))];
			});
		},
		renderResult(result: ResultInput, _options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: RenderContext) {
			const row = rowState(context);
			row.theme = theme;
			row.result = result;
			const view = viewOf(kit, { ...row, context })!;
			track(row, context, kit.now(), spec.outcome?.(view));
			return slotFor(context).onClick(open(row)).set((width) => {
				const current = viewOf(kit, row)!;
				const lines = indent(spec.body(current, Math.max(1, width - BODY_INDENT))).map((line) => truncateToWidth(line, width, "…"));
				return onBackground(lines, width, bodyBackground(theme));
			});
		},
	};
}
