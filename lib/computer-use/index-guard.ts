/**
 * A Sky element_index is a position in the latest accessibility tree, not an
 * element identity. After an action changes the layout (a mode switch, a sheet,
 * a menu, a list that reloads), an old index names a different element, and Sky
 * acts on that element with no error.
 *
 * This guard keeps what each index named at the code's last get_app_state for an
 * app. Before an element action that follows another action on that app, it reads
 * a full tree and refuses when the element at that index is not the same one.
 * The first element action after a read needs no check: nothing has moved yet.
 */
import { clean } from "./describe.ts";
import type { ToolResult } from "./session.ts";

/** Sends one Computer Use call outside the code's own calls. */
export type Reader = (method: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface CallGuard {
	/** The arguments to send for a call the code made. */
	prepare(method: string, args: Record<string, unknown>): Record<string, unknown>;
	/** A reason to refuse the call before it is sent, or undefined to send it. */
	before(method: string, args: Record<string, unknown>, read: Reader): Promise<string | undefined>;
	/** Told about each call that succeeded. */
	after(method: string, args: Record<string, unknown>, result: ToolResult, read: Reader): Promise<void>;
}

export interface Tree {
	readonly bundleId?: string;
	/** Row text after the index, by index. */
	readonly rows: ReadonlyMap<string, string>;
}

const ELEMENT_METHODS = new Set(["click", "perform_secondary_action", "set_value", "select_text", "scroll"]);
const READ_METHODS = new Set(["list_apps", "get_app_state"]);
const ROW = /^(\t*)(\d+) (.*)$/;
const BUNDLE = /\(bundleID ([^,\s)]+)/;
/** The labelled fields of a row. Everything before the first is the role and the title. */
const FIELD = /(?:,\s*|\s+|^)(Description|Value|Help|ID|Secondary Actions): /g;
const FLAGS = /\s*\([^)]*\)/g;
const SHOWN_CHARS = 80;

const textOf = (result: ToolResult) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");

/**
 * The rows of a full tree. Rows are numbered in order from 0, so a line that
 * breaks the order is part of the row before it (a multi-line value). Text with
 * no row 0 is not a full tree: a diff, an error or an action's output.
 */
export function parseTree(text: string): Tree | undefined {
	const rows = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = ROW.exec(line);
		if (match && Number(match[2]) === rows.size) rows.set(match[2], match[3].trim());
	}
	if (rows.size === 0) return undefined;
	const bundleId = BUNDLE.exec(text)?.[1];
	return { rows, ...(bundleId ? { bundleId } : {}) };
}

/**
 * What makes a row the same element: its role, its title and its Description.
 * The ID counts only when there is no Description. Values, flags such as
 * "disabled", Help and Secondary Actions change with normal use, so they do not
 * count. An ID can hold state after a ";" (Calculator's "value:7"), so that part
 * does not count either.
 */
export function identity(row: string): string {
	const fields = [...row.matchAll(FIELD)];
	const head = (fields.length > 0 ? row.slice(0, fields[0].index) : row).replace(FLAGS, "").trim();
	const field = (key: string): string => {
		const at = fields.findIndex((match) => match[1] === key);
		if (at < 0) return "";
		const start = fields[at].index! + fields[at][0].length;
		return row.slice(start, fields[at + 1]?.index ?? row.length).trim();
	};
	const description = field("Description");
	return [head, description, description ? "" : field("ID").split(";")[0].trim()].join("\u0000");
}

interface AppView {
	readonly rows: ReadonlyMap<string, string>;
	/** An action went to the app after the code's last read, so indices may have moved. */
	acted: boolean;
	/** A check read changed what Sky diffs against, so the code's next read must be full. */
	resync: boolean;
}

const norm = (app: unknown) => typeof app === "string" ? app.trim().toLowerCase() : "";
const shown = (row: string) => `"${clean(row, SHOWN_CHARS)}"`;

export class IndexGuard implements CallGuard {
	private readonly views = new Map<string, AppView>();
	/** The names the code used for an app, to the bundle id its tree gave. */
	private readonly aliases = new Map<string, string>();

	prepare(method: string, args: Record<string, unknown>): Record<string, unknown> {
		const view = method === "get_app_state" ? this.view(args.app) : undefined;
		return view?.resync ? { ...args, disableDiff: true } : args;
	}

	async before(method: string, args: Record<string, unknown>, read: Reader): Promise<string | undefined> {
		if (READ_METHODS.has(method)) return undefined;
		const view = this.view(args.app);
		if (!view) return undefined;
		const index = typeof args.element_index === "string" || typeof args.element_index === "number" ? String(args.element_index) : undefined;
		const was = index === undefined ? undefined : view.rows.get(index);
		const refusal = ELEMENT_METHODS.has(method) && view.acted && was !== undefined ? await this.check(view, args.app, index!, was, read) : undefined;
		if (!refusal) view.acted = true;
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
		this.aliases.set(norm(args.app), id);
		this.aliases.set(id, id);
		this.views.set(id, { rows: tree.rows, acted: false, resync: false });
	}

	private async check(view: AppView, app: unknown, index: string, was: string, read: Reader): Promise<string | undefined> {
		const stale = `element_index "${index}" is stale`;
		let current: Tree | undefined;
		view.resync = true;
		try {
			const result = await read("get_app_state", { app, disableDiff: true });
			if (result.isError) return `could not check element_index "${index}": ${textOf(result) || "get_app_state failed"}. The action was not sent. Call sky.get_app_state again.`;
			current = parseTree(textOf(result));
		} catch (error) {
			return `could not check element_index "${index}": ${error instanceof Error ? error.message : String(error)}. The action was not sent. Call sky.get_app_state again.`;
		}
		if (!current) return `could not check element_index "${index}": the current tree did not parse. The action was not sent. Call sky.get_app_state again.`;
		const now = current.rows.get(index);
		if (now !== undefined && identity(now) === identity(was)) return undefined;
		const after = now === undefined ? "no element has that index now" : `now it is ${shown(now)}`;
		return `${stale}: at the last get_app_state it was ${shown(was)}, and ${after}. An earlier action changed the layout, so the action was not sent. Call sky.get_app_state again and take the index from the new tree.`;
	}

	private key(app: unknown): string {
		const name = norm(app);
		return this.aliases.get(name) ?? name;
	}

	private view(app: unknown): AppView | undefined {
		return this.views.get(this.key(app));
	}
}
