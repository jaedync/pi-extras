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
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

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
	readonly chosen: WeakMap<object, RowRenderers | null>;
}

// Kept on the prototype, so a reloaded copy of this module takes over the one patch instead of stacking another.
const SLOT = Symbol.for("pi-extras.tool-adopt");
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
 * Draws other tools' rows through `host` until the returned undo is called.
 * The patch stays on Pi's prototype, passing straight through, once undone.
 */
export function installAdoption(host: AdoptHost, target: object = ToolExecutionComponent.prototype): () => void {
	const proto = target as Record<string | symbol, unknown> & Record<(typeof LOOKUPS)[number], Lookup>;
	let slot = proto[SLOT] as Slot | undefined;
	if (!slot) {
		if (!canAdopt(target)) return () => undefined;
		const created: Slot = {
			host: undefined,
			getRenderShell: proto.getRenderShell,
			getCallRenderer: proto.getCallRenderer,
			getResultRenderer: proto.getResultRenderer,
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
		slot = created;
	}
	const owned = slot;
	owned.host = host;
	return () => {
		if (owned.host === host) owned.host = undefined;
	};
}
