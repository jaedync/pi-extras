/**
 * How Tool Display draws a tool's rows, marked on the tool's definition. Tool
 * Display draws the rows of every tool with a header band, other extensions'
 * tools included. A mark says the rows already have one, or which of the
 * layouts for pi-extras's own tools to use.
 *
 * The key is Symbol.for, since each extension loads its own copy of this
 * module, and it lives on the definition because Pi keeps that object (or a
 * spread of it, which copies the mark) for the rows it builds.
 */
export const TOOL_ROW = Symbol.for("pi-extras.tool-row.v1");

export const ROW_KINDS = ["band", "kagi", "computer-use", "windows-use", "usage"] as const;
export type RowKind = (typeof ROW_KINDS)[number];

/** A copy of `definition` carrying the mark. */
export function markRow<T extends object>(definition: T, kind: RowKind): T {
	return { ...definition, [TOOL_ROW]: kind };
}

// Kept on globalThis under Symbol.for for the same reason as TOOL_ROW: each extension has its own copy of this module.
const DRAWN = Symbol.for("pi-extras.tool-row.drawn.v1");
type DrawnLookup = (name: string) => object | undefined;

/**
 * Tool Display shares the definitions it registered for Pi's built-in tools,
 * so a view that draws a child session's rows (the agent inspector) draws
 * them as main's transcript does. Undefined withdraws them.
 */
export function shareDrawnTools(lookup: DrawnLookup | undefined): void {
	(globalThis as Record<symbol, unknown>)[DRAWN] = lookup;
}

/** The definition main's transcript draws `name` with, when Tool Display shares one. */
export function drawnTool(name: string): object | undefined {
	const lookup = (globalThis as Record<symbol, unknown>)[DRAWN];
	try {
		return typeof lookup === "function" ? (lookup as DrawnLookup)(name) : undefined;
	} catch {
		return undefined;
	}
}

export function rowKind(definition: unknown): RowKind | undefined {
	if (!definition || typeof definition !== "object") return undefined;
	const kind = (definition as Record<symbol, unknown>)[TOOL_ROW];
	return ROW_KINDS.find((known) => known === kind);
}
