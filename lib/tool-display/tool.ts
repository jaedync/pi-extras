/**
 * Turns a tool's description of its row into Pi's two renderers. A spec says
 * what the band's title is, what else the rail shows, what goes under the
 * band and in the body, and what the popup holds; the timing, animation,
 * clicks and popup wiring are the same for every tool. Everything under the
 * band sits on the theme's tool gray, so a call reads as one block apart
 * from the conversation around it.
 */
import type { Outcome, Seg } from "../band/band.ts";
import type { PopupSource } from "../band/popup.ts";
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
	/** The popup's title, e.g. `bash · 3 commands`. */
	label(view: View): string;
	title(view: View): Seg[];
	timeoutMs?(view: View): number | undefined;
	/** Rail text before the time, e.g. `2 of 3`. */
	lead?(view: View, phase: BandPhase): Seg[];
	/** How a failure reads in the rail, e.g. `exit 1`; the default is `failed`. */
	failure?(view: View): Seg[] | undefined;
	outcome?(view: View): Outcome | undefined;
	/** Lines under the band in the call slot, drawn at full width. */
	below?(view: View, width: number): string[];
	/** The result slot's lines, drawn indented under the band's title. */
	body(view: View, width: number): string[];
	details?(view: View): string;
	head?(view: View, width: number, selected: number): string[];
	steps?(view: View): number;
	firstStep?(view: View): number;
	outputLabel?(view: View, selected: number): string;
	output(view: View, width: number, selected: number): string[];
}

function viewOf(kit: Kit, row: RowState): View | undefined {
	if (!row.context || !row.theme) return undefined;
	return { kit, context: row.context, row, theme: row.theme, paint: painter(row.theme), result: row.result as ResultInput | undefined, now: kit.now() };
}

export function bandOf(spec: ToolSpec, view: View): { segs: Seg[]; rail: Seg[]; phase: BandPhase } {
	const phase = phaseOf(view.row, view.context, view.now, spec.timeoutMs?.(view));
	const failure = spec.failure?.(view);
	const segs = spec.title(view);
	const railSegs = rail(phase, tookMs(view.row, view.now), { lead: spec.lead?.(view, phase) ?? [], ...(failure ? { failure } : {}) });
	return { segs, rail: railSegs, phase };
}

export function popupSource(kit: Kit, spec: ToolSpec, row: RowState): PopupSource {
	const view = () => viewOf(kit, row)!;
	return {
		label: () => spec.label(view()),
		band: (theme, width) => {
			const current = { ...view(), theme };
			return band(theme, kit, bandOf(spec, current), width);
		},
		details: () => spec.details?.(view()) ?? "",
		head: (theme, width, selected) => spec.head?.({ ...view(), theme, paint: painter(theme) }, width, selected) ?? [],
		stepCount: () => spec.steps?.(view()) ?? 0,
		firstStep: () => spec.firstStep?.(view()) ?? 0,
		outputLabel: (selected) => spec.outputLabel?.(view(), selected) ?? "output",
		output: (theme, width, selected) => spec.output({ ...view(), theme, paint: painter(theme) }, width, selected),
		live: () => row.context?.isPartial ?? false,
	};
}

export function toolRenderers(kit: Kit, spec: ToolSpec) {
	const open = (row: RowState) => () => (row.context && row.theme ? kit.openPopup(popupSource(kit, spec, row)) : false);
	return {
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const row = rowState(context);
			row.theme = theme;
			track(row, context, kit.now());
			return slotFor(context).onClick(open(row)).set((width) => {
				const view = viewOf(kit, row)!;
				const input = bandOf(spec, view);
				animate(row, kit, input.phase);
				return [band(theme, kit, input, width), ...onBackground(spec.below?.(view, width) ?? [], width, bodyBackground(theme))];
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
				return onBackground(indent(spec.body(current, Math.max(1, width - BODY_INDENT))), width, bodyBackground(theme));
			});
		},
	};
}
