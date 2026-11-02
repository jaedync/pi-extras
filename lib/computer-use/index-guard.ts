/**
 * A Sky element_index is a position in the latest accessibility tree, not an
 * element identity. After an action changes the layout (a mode switch, a sheet,
 * a menu, a list that reloads), an old index names a different element, and Sky
 * acts on that element with no error.
 *
 * This guard keeps what each index named at the code's last get_app_state for an
 * app. Before an element action that follows another action on that app, it reads
 * a full tree and refuses when the element at that index is not the same one.
 * The first element action after a read in the same run needs no check: nothing
 * has moved yet. A new run checks again, because the user or the app can change
 * the window between two tool calls.
 */
import { clean } from "./describe.ts";
import type { ToolResult } from "./session.ts";

/** Sends one Computer Use call outside the code's own calls. */
export type Reader = (method: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface CallGuard {
	/** A run of the code starts. */
	begin(): void;
	/**
	 * Runs one call of the code, from its check to its result, with no other call
	 * between them: otherwise a call that runs at the same time (Promise.all) can
	 * move the layout after the check and before the action.
	 */
	exclusive<T>(task: () => Promise<T>): Promise<T>;
	/** The arguments to send for a call the code made. */
	prepare(method: string, args: Record<string, unknown>): Record<string, unknown>;
	/** A reason to refuse the call before it is sent, or undefined to send it. */
	before(method: string, args: Record<string, unknown>, read: Reader): Promise<string | undefined>;
	/** Told about each call that succeeded. */
	after(method: string, args: Record<string, unknown>, result: ToolResult, read: Reader): Promise<void>;
}

export interface Row {
	/** The number of leading tabs: the row's level in the tree. */
	readonly depth: number;
	/** The row text after the index. */
	readonly text: string;
}

export interface Tree {
	readonly bundleId?: string;
	/** Other names of the app that the tree header gives: the window's app name and the .app name. */
	readonly names: readonly string[];
	/** The rows by index. */
	readonly rows: ReadonlyMap<string, Row>;
}

const ELEMENT_METHODS = new Set(["click", "perform_secondary_action", "set_value", "select_text", "scroll"]);
const READ_METHODS = new Set(["list_apps", "get_app_state"]);
const ROW = /^(\t*)(\d+) (.*)$/;
const BUNDLE = /\(bundleID ([^,\s)]+)/;
const APP_PATH = /^App=.*\/([^/\n]+)\.app\/?\s/m;
const WINDOW_APP = /^Window: .*, App: (.+?)\.?\s*$/m;
/** The labelled fields of a row. Everything before the first is the role and the title. */
const FIELD = /(?:,\s*|\s+|^)(Description|Value|Help|ID|Secondary Actions): /g;
const FLAGS = /\s*\([^)]*\)/g;
/** An ID can hold state after a ";" or a ":" (Calculator's "StandardInputView;value:7", "Mode: basic"). */
const ID_STATE = /[;:]/;
/** Children that count toward an element's identity, so two rows that look the same still differ. */
const MAX_CHILDREN = 8;
/** A value with no label after the flags: a number, as in "splitter (settable, float) -1". */
const BARE_VALUE = /^-?\d+(?:\.\d+)?%?$/;
const SHOWN_CHARS = 80;

const textOf = (result: ToolResult) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");

/**
 * The rows of a full tree. Rows are numbered in order from 0, so a line that
 * breaks the order is part of the row before it (a multi-line value). Text with
 * no row 0 or no <app_state> block is not a full tree: a diff, an error or an
 * action's output. An indented row-like line out of order is not a value line,
 * so it marks a partial view too.
 */
export function parseTree(text: string): Tree | undefined {
	if (!text.includes("<app_state>")) return undefined;
	const rows = new Map<string, Row>();
	for (const line of text.split("\n")) {
		const match = ROW.exec(line);
		if (!match) continue;
		if (Number(match[2]) === rows.size) rows.set(match[2], { depth: match[1].length, text: match[3].trim() });
		else if (match[1].length > 0) return undefined;
	}
	if (rows.size === 0) return undefined;
	const bundleId = BUNDLE.exec(text)?.[1];
	const names = [...new Set([APP_PATH.exec(text)?.[1], WINDOW_APP.exec(text)?.[1]].flatMap((name) => name ? [name, `${name}.app`] : []))];
	return { rows, names, ...(bundleId ? { bundleId } : {}) };
}

/**
 * What makes a row the same element: its role, its title, its Description and
 * its ID without state. Values, flags such as "disabled", Help and Secondary
 * Actions change with normal use, so they do not count. A number with no label
 * after the flags is a value ("splitter (settable, float) -1"), so it does not
 * count either. Other text after the flags can be a title, so it counts.
 */
export function identity(row: string): string {
	const fields = [...row.matchAll(FIELD)];
	let head = fields.length > 0 ? row.slice(0, fields[0].index) : row;
	const flags = [...head.matchAll(FLAGS)].at(-1);
	if (flags && BARE_VALUE.test(head.slice(flags.index! + flags[0].length).trim())) head = head.slice(0, flags.index! + flags[0].length);
	const field = (key: string): string => {
		const at = fields.findIndex((match) => match[1] === key);
		if (at < 0) return "";
		const start = fields[at].index! + fields[at][0].length;
		return row.slice(start, fields[at + 1]?.index ?? row.length).trim();
	};
	return [head.replace(FLAGS, "").trim(), field("Description"), field("ID").split(ID_STATE)[0].trim()].join("\u0000");
}

export interface ElementKey {
	/** The level and the row's own identity. */
	readonly self: string;
	/** The identities of the first direct children. */
	readonly children: readonly string[];
}

/** The identity of the element at `index` in its tree: its level, its own row and its first direct children. */
export function elementKey(tree: Tree, index: string): ElementKey | undefined {
	const row = tree.rows.get(index);
	if (!row) return undefined;
	const children: string[] = [];
	for (let at = Number(index) + 1; children.length < MAX_CHILDREN; at++) {
		const next = tree.rows.get(String(at));
		if (!next || next.depth <= row.depth) break;
		if (next.depth === row.depth + 1) children.push(identity(next.text));
	}
	return { self: `${row.depth}\u0001${identity(row.text)}`, children };
}

/**
 * Whether two keys name the same element. A list reload can put a row with the
 * same text at the same index ("row", "cell"); its children (the item's text)
 * tell them apart. A child label can hold state ("4 unread", "Play"), so half
 * of the children must match, not all. A scroll changes the children that a
 * scroll area shows, so for a scroll only the row itself counts.
 */
export function sameElement(was: ElementKey, now: ElementKey | undefined, method: string): boolean {
	if (!now || now.self !== was.self) return false;
	if (method === "scroll") return true;
	const total = Math.max(was.children.length, now.children.length);
	if (total === 0) return true;
	const left = [...now.children];
	let matched = 0;
	for (const child of was.children) {
		const at = left.indexOf(child);
		if (at >= 0) {
			matched++;
			left.splice(at, 1);
		}
	}
	return matched * 2 >= total;
}

const sameRows = (a: Tree, b: Tree) => a.rows.size === b.rows.size && [...a.rows].every(([index, row]) => b.rows.get(index)?.text === row.text);

interface AppView {
	readonly tree: Tree;
	/** An action went to the app after the code's last read, so indices may have moved. */
	acted: boolean;
	/** A check read changed what Sky diffs against, so the code's next read must be full. */
	resync: boolean;
	/** The tree of the last check read, while no action has gone to the app since. */
	checked?: Tree;
}

const norm = (app: unknown) => typeof app === "string" ? app.trim().toLowerCase() : "";
const shown = (row: Row) => `"${clean(row.text, SHOWN_CHARS)}"`;

export class IndexGuard implements CallGuard {
	private readonly views = new Map<string, AppView>();
	/** The names the code used for an app, and the names its tree gave, to its key. */
	private readonly aliases = new Map<string, string>();
	private lock: Promise<unknown> = Promise.resolve();

	begin(): void {
		this.actedOnAll();
	}

	exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.lock.then(task);
		this.lock = run.catch(() => {});
		return run;
	}

	prepare(method: string, args: Record<string, unknown>): Record<string, unknown> {
		const view = method === "get_app_state" ? this.view(args.app) : undefined;
		return view?.resync ? { ...args, disableDiff: true } : args;
	}

	async before(method: string, args: Record<string, unknown>, read: Reader): Promise<string | undefined> {
		if (READ_METHODS.has(method)) return undefined;
		const view = this.view(args.app);
		if (!view) {
			// A name the guard has not seen can still be an app it has a view of.
			this.actedOnAll();
			return undefined;
		}
		const index = typeof args.element_index === "string" || typeof args.element_index === "number" ? String(args.element_index) : undefined;
		const was = index === undefined ? undefined : elementKey(view.tree, index);
		const refusal = ELEMENT_METHODS.has(method) && view.acted && was !== undefined ? await this.check(view, args.app, index!, method, read) : undefined;
		if (!refusal) {
			view.acted = true;
			view.checked = undefined;
		}
		return refusal;
	}

	async after(method: string, args: Record<string, unknown>, result: ToolResult, read: Reader): Promise<void> {
		if (method !== "get_app_state") return;
		const key = this.key(args.app);
		let tree = parseTree(textOf(result));
		if (!tree) {
			// A diff: the code saw this moment, so a full read now gives the same baseline.
			// A failed read only means no baseline: the code's own read already succeeded.
			const full = await read("get_app_state", { app: args.app, disableDiff: true }).catch(() => undefined);
			tree = full && !full.isError ? parseTree(textOf(full)) : undefined;
		}
		if (!tree) {
			this.views.delete(key);
			return;
		}
		const id = tree.bundleId ? norm(tree.bundleId) : key;
		for (const name of [args.app, id, ...tree.names]) {
			if (norm(name)) this.aliases.set(norm(name), id);
		}
		this.views.set(id, { tree, acted: false, resync: false });
	}

	private async check(view: AppView, app: unknown, index: string, method: string, read: Reader): Promise<string | undefined> {
		let current = view.checked;
		if (!current) {
			const failure = (reason: string) => {
				// The read may have reached Sky, so its next diff may skip a change the code did not see.
				view.resync = true;
				return `could not check element_index "${index}": ${reason}. The action was not sent. Call sky.get_app_state again.`;
			};
			try {
				const result = await read("get_app_state", { app, disableDiff: true });
				if (result.isError) return failure(textOf(result) || "get_app_state failed");
				current = parseTree(textOf(result));
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			if (!current) return failure("the current tree did not parse");
			view.checked = current;
			// Sky diffs the code's next read against this read. When nothing changed, that diff is the
			// same as one against the code's own read; otherwise the code must get a full tree.
			if (!sameRows(current, view.tree)) view.resync = true;
		}
		if (sameElement(elementKey(view.tree, index)!, elementKey(current, index), method)) return undefined;
		const was = view.tree.rows.get(index)!;
		const now = current.rows.get(index);
		const after = now === undefined ? "no element has that index now" : now.text === was.text ? `now it holds other contents` : `now it is ${shown(now)}`;
		return `element_index "${index}" is stale: at the last get_app_state it was ${shown(was)}, and ${after}. The element at that index changed since then, so the action was not sent. Call sky.get_app_state again and take the index from the new tree.`;
	}

	private actedOnAll(): void {
		for (const view of this.views.values()) {
			view.acted = true;
			view.checked = undefined;
		}
	}

	private key(app: unknown): string {
		const name = norm(app);
		return this.aliases.get(name) ?? name;
	}

	private view(app: unknown): AppView | undefined {
		return this.views.get(this.key(app));
	}
}
