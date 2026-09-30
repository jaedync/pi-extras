/**
 * Rows Pi built before pi-extras was ready, rebuilt once it is.
 *
 * A started or resumed session is drawn after session_start, but /reload
 * rebuilds the transcript first and sends session_start after it. So on a
 * reload every row is built while pi-extras' patches have no host and before
 * the tools it registers in session_start exist, and Pi keeps a row's tool
 * definition and container from then on: without this, the whole history
 * would stay in Pi's plain style until the next restart.
 *
 * The patches are put in place when their modules load, before that rebuild,
 * and note every row they see while they have no host. Once session_start has
 * installed the hosts, Tool Display rebuilds the tool rows (with the
 * definitions the other extensions offer here) and each message patch redraws
 * the replies.
 */

export type LateKind = "tool" | "message";

interface Late {
	rows: Array<{ kind: LateKind; ref: WeakRef<object> }>;
	seen: WeakSet<object>;
	readonly offered: Map<string, object>;
}

// On globalThis because each extension loads its own copy of this module, and a reload loads them again.
const LATE = Symbol.for("pi-extras.late-rows.v1");

function late(): Late {
	const global = globalThis as Record<symbol, Late | undefined>;
	return (global[LATE] ??= { rows: [], seen: new WeakSet(), offered: new Map() });
}

/** Notes a row built while its patch had no host. Held weakly, so rows Pi drops can go. */
export function noteLate(kind: LateKind, row: object): void {
	const state = late();
	if (state.seen.has(row)) return;
	state.seen.add(row);
	state.rows.push({ kind, ref: new WeakRef(row) });
}

/** The rows of `kind` noted since the last session ended that are still alive. */
export function lateRows(kind: LateKind): object[] {
	const state = late();
	state.rows = state.rows.filter((entry) => entry.ref.deref() !== undefined);
	return state.rows.filter((entry) => entry.kind === kind).map((entry) => entry.ref.deref()!);
}

/** Draws the noted replies again; Pi's message rebuilds itself, through the patches in place now, when invalidated. */
export function redrawLateMessages(): void {
	for (const message of lateRows("message")) {
		try { (message as { invalidate?: () => void }).invalidate?.(); } catch { /* That reply stays as Pi drew it. */ }
	}
}

/**
 * Offers the definition an extension registered in session_start, so rows a
 * reload built before it existed can be rebuilt with it. Returns it unchanged.
 */
export function offerRows<T extends { name: string }>(definition: T): T {
	late().offered.set(definition.name, definition);
	return definition;
}

export function offeredRows(name: string): object | undefined {
	return late().offered.get(name);
}

/** Starts over at session end: a reload notes its rows afresh, and a tool not registered again isn't offered. */
export function forgetLate(): void {
	const state = late();
	state.rows = [];
	state.seen = new WeakSet();
	state.offered.clear();
}
