/**
 * Tool rows of other extensions' tools, drawn with the band. Pi builds each
 * tool row with its ToolExecutionComponent, which asks the tool's definition
 * for a shell and two renderers. This patches those three lookups: a row
 * whose tool the host can draw gets `renderShell: "self"` and the host's
 * renderers, and every other row stays as Pi draws it.
 *
 * The choice is made once per row, the first time Pi asks while building it,
 * because Pi picks the row's container then and never again.
 *
 * The lookups are Pi internals. When they are missing, nothing is patched
 * and Pi draws those rows itself.
 *
 * The patch goes on when Tool Display loads, before a reload rebuilds the
 * transcript, and notes every row built while it has no host; rebuildRow
 * redraws such a row once the host is back (see late-rows.ts).
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { noteLate } from "../late-rows.ts";

export interface RowRenderers {
	readonly renderCall: (...args: never[]) => unknown;
	readonly renderResult: (...args: never[]) => unknown;
}

export interface AdoptHost {
	/** Renderers for rows of this tool, or undefined to leave them to Pi. */
	renderersFor(definition: object): RowRenderers | undefined;
}

type Lookup = (this: Internals) => unknown;

interface Internals {
	readonly toolDefinition?: object;
}

interface Slot {
	host: AdoptHost | undefined;
	readonly getRenderShell: Lookup;
	readonly getCallRenderer: Lookup;
	readonly getResultRenderer: Lookup;
	readonly hasRendererDefinition?: Lookup;
	readonly chosen: WeakMap<object, RowRenderers | null>;
}

/** The parts of Pi's tool row a rebuild touches. */
interface RowInternals {
	toolDefinition?: object;
	rendererState: object;
	callRendererComponent?: unknown;
	resultRendererComponent?: unknown;
	readonly children: unknown[];
	readonly contentBox: unknown;
	readonly contentTextRegion: unknown;
	readonly selfRenderContainer: unknown;
	hasRendererDefinition(): boolean;
	getRenderShell(): string;
	invalidate(): void;
}

// Kept on the prototype, so a reloaded copy of this module takes over the one patch instead of stacking another.
// Versioned, so an update that changes the patch lays its own over an older one (left passing straight through).
const SLOT = Symbol.for("pi-extras.tool-adopt.v2");
const LOOKUPS = ["getRenderShell", "getCallRenderer", "getResultRenderer"] as const;

function choose(slot: Slot, row: Internals): RowRenderers | undefined {
	let renderers = slot.chosen.get(row);
	if (renderers === undefined) {
		const definition = row.toolDefinition;
		try {
			renderers = (definition && slot.host?.renderersFor(definition)) || null;
		} catch {
			renderers = null;
		}
		slot.chosen.set(row, renderers);
	}
	return renderers ?? undefined;
}

/** Whether Pi's row still has the lookups this patches. */
export function canAdopt(target: object = ToolExecutionComponent.prototype): boolean {
	const proto = target as Record<string, unknown>;
	return LOOKUPS.every((name) => typeof proto[name] === "function");
}

/**
 * Puts the patch on Pi's row with no host, passing straight through and
 * noting each row it sees; false when Pi's row lacks the lookups.
 */
export function prepareAdoption(target: object = ToolExecutionComponent.prototype): boolean {
	return slotOf(target) !== undefined;
}

function slotOf(target: object): Slot | undefined {
	const proto = target as Record<string | symbol, unknown> & Record<(typeof LOOKUPS)[number] | "hasRendererDefinition", Lookup>;
	const found = proto[SLOT] as Slot | undefined;
	if (found) return found;
	if (!canAdopt(target)) return undefined;
	const created: Slot = {
		host: undefined,
		getRenderShell: proto.getRenderShell,
		getCallRenderer: proto.getCallRenderer,
		getResultRenderer: proto.getResultRenderer,
		...(typeof proto.hasRendererDefinition === "function" ? { hasRendererDefinition: proto.hasRendererDefinition } : {}),
		chosen: new WeakMap(),
	};
	proto[SLOT] = created;
	proto.getRenderShell = function () {
		return choose(created, this) ? "self" : created.getRenderShell.call(this);
	};
	proto.getCallRenderer = function () {
		return choose(created, this)?.renderCall ?? created.getCallRenderer.call(this);
	};
	proto.getResultRenderer = function () {
		return choose(created, this)?.renderResult ?? created.getResultRenderer.call(this);
	};
	const has = created.hasRendererDefinition;
	// Pi asks this of every row it builds, those without a definition included.
	if (has) proto.hasRendererDefinition = function () {
		if (!created.host) noteLate("tool", this);
		return has.call(this);
	};
	return created;
}

/**
 * Draws other tools' rows through `host` until the returned undo is called.
 * The patch stays on Pi's prototype, passing straight through, once undone.
 */
export function installAdoption(host: AdoptHost, target: object = ToolExecutionComponent.prototype): () => void {
	const slot = slotOf(target);
	if (!slot) return () => undefined;
	const owned = slot;
	owned.host = host;
	return () => {
		if (owned.host === host) owned.host = undefined;
	};
}

function isRow(row: object): row is RowInternals {
	const internals = row as Partial<RowInternals>;
	return Array.isArray(internals.children) && typeof internals.invalidate === "function"
		&& typeof internals.hasRendererDefinition === "function" && typeof internals.getRenderShell === "function"
		&& internals.contentBox !== undefined && internals.contentTextRegion !== undefined && internals.selfRenderContainer !== undefined;
}

/**
 * Builds a row again as Pi would now: with `definition` (or the one it has),
 * the host's choice for it, and the container that choice needs. For a row
 * Pi built before the host or its tool was there; false when the row isn't
 * shaped as expected, which leaves it as it was.
 */
export function rebuildRow(row: object, definition?: object, target: object = ToolExecutionComponent.prototype): boolean {
	if (!isRow(row)) return false;
	const shells = [row.contentBox, row.contentTextRegion, row.selfRenderContainer];
	const at = row.children.findIndex((child) => shells.includes(child));
	if (at < 0) return false;
	if (definition) row.toolDefinition = definition;
	(target as Record<symbol, Slot | undefined>)[SLOT]?.chosen.delete(row);
	row.rendererState = {};
	row.callRendererComponent = undefined;
	row.resultRendererComponent = undefined;
	// Pi picks this container when it builds a row; a `self` row draws its own, so it only needs to be in place.
	row.children[at] = !row.hasRendererDefinition() ? row.contentTextRegion : row.getRenderShell() === "self" ? row.selfRenderContainer : row.contentBox;
	row.invalidate();
	return true;
}
