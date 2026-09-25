/**
 * The frame around a tool row. Rows use Pi's `renderShell: "self"`, so each
 * row draws its own frame and can switch density without being rebuilt.
 *
 * Boxed draws what Pi draws by default: a background box, colored by status,
 * with a blank padding line above and below. Compact draws no box: a status
 * glyph leads the first line and everything else is indented under it.
 *
 * Pi renders a row as the call slot followed by the result slot. The density,
 * the status and whether a result exists are read when the row is drawn, not
 * when the slot is built, so a density switch reaches every row at once.
 */
import { Box, Spacer, type Component } from "@earendil-works/pi-tui";

export type Density = "boxed" | "compact";
export type Status = "pending" | "success" | "error";
export type PaintKey = "toolTitle" | "toolOutput" | "accent" | "muted" | "dim" | "success" | "error" | "warning";
export type BgKey = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface Paint {
	fg(key: PaintKey, text: string): string;
	bg(key: BgKey, text: string): string;
	bold(text: string): string;
}

/** Shared by a row's call and result slots through Pi's per-row render state. */
export interface RowState {
	status: Status;
	hasResult: boolean;
}

const BG: Record<Status, BgKey> = { pending: "toolPendingBg", success: "toolSuccessBg", error: "toolErrorBg" };
const GLYPH: Record<Status, [string, PaintKey]> = { pending: ["○", "muted"], success: ["✓", "success"], error: ["✗", "error"] };
const INDENT = "  ";

/**
 * Lines computed for the width they are drawn at. Pi redraws every row on
 * every frame, so the result is kept until the width or `key` changes; a
 * renderer builds a new Lines whenever its row's data changes.
 */
export class Lines implements Component {
	private readonly draw: (width: number) => string[];
	private readonly key: () => string;
	private cache?: { width: number; key: string; lines: string[] };
	constructor(draw: (width: number) => string[], key: () => string = () => "") {
		this.draw = draw;
		this.key = key;
	}
	render(width: number): string[] {
		const safe = Math.max(1, width);
		const key = this.key();
		if (this.cache?.width !== safe || this.cache.key !== key) this.cache = { width: safe, key, lines: this.draw(safe) };
		return this.cache.lines;
	}
	invalidate(): void {
		this.cache = undefined;
	}
}

export interface SlotOptions {
	readonly kind: "call" | "result";
	readonly row: RowState;
	readonly density: () => Density;
	readonly paint: () => Paint;
}

export class Slot implements Component {
	private body: Component = new Lines(() => []);
	private readonly boxed: Box;
	private readonly options: SlotOptions;

	constructor(options: SlotOptions) {
		this.options = options;
		const { kind, row } = options;
		this.boxed = new Box(1, 0, (text) => options.paint().bg(BG[row.status], text));
		const content: Component = {
			render: (width) => {
				const lines = this.body.render(width);
				// Output is set off from the call by a blank line, as Pi does.
				return kind === "result" && lines.length > 0 ? ["", ...lines] : lines;
			},
			invalidate: () => this.body.invalidate?.(),
		};
		if (kind === "call") {
			this.boxed.addChild(new Spacer(1));
			this.boxed.addChild(content);
			// The bottom padding moves to the result slot once there is one.
			this.boxed.addChild(new Lines(() => (row.hasResult ? [] : [""]), () => String(row.hasResult)));
		} else {
			this.boxed.addChild(content);
			this.boxed.addChild(new Spacer(1));
		}
	}

	setBody(body: Component): this {
		this.body = body;
		this.boxed.invalidate();
		return this;
	}

	render(width: number): string[] {
		if (this.options.density() === "boxed") return this.boxed.render(width);
		const inner = Math.max(1, width - INDENT.length);
		const lines = this.body.render(inner);
		if (this.options.kind === "result") return lines.map((line) => INDENT + line);
		const [glyph, key] = GLYPH[this.options.row.status];
		return lines.map((line, index) => (index === 0 ? `${this.options.paint().fg(key, glyph)} ${line}` : INDENT + line));
	}

	invalidate(): void {
		this.boxed.invalidate();
		this.body.invalidate?.();
	}
}

/** The row state Pi shares between a row's slots, created on first use. */
export function rowState(state: Record<string, unknown>, context: { isPartial: boolean; isError: boolean }): RowState {
	const row = (state.row ??= { status: "pending", hasResult: false }) as RowState;
	row.status = context.isError ? "error" : context.isPartial ? "pending" : "success";
	return row;
}
