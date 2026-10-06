/**
 * The `edit`, `write` and `bash` calls running now, in main and in every
 * child, so a child's bash call is not blamed for a change another agent
 * made at the same time. Ids are `<agent>:<tool call id>`: call ids are only
 * unique within one session.
 */
interface Window {
	readonly id: string;
	/** The git work tree's top level, as git gives it, or the directory outside git. */
	readonly root: string;
	readonly edited: Set<string>;
	shared: boolean;
}

export interface Watched {
	/** Resolved paths an `edit` or `write` call targeted during the watch. */
	edited: ReadonlySet<string>;
	/** Whether another agent's bash call ran in the same work tree during the watch. */
	shared: boolean;
}

export class ToolActivity {
	private readonly edits = new Map<string, string>();
	private readonly shells = new Map<string, string>();
	private readonly windows = new Set<Window>();

	/** An `edit` or `write` call of the resolved `path` starts. */
	editStart(id: string, path: string): void {
		this.edits.set(id, path);
		for (const window of this.windows) window.edited.add(path);
	}

	/** A bash call in the work tree `root` starts. */
	shellStart(id: string, root: string): void {
		this.shells.set(id, root);
		for (const window of this.windows) if (window.id !== id && window.root === root) window.shared = true;
	}

	/** The call `id` ended, whatever it was. */
	end(id: string): void {
		this.edits.delete(id);
		this.shells.delete(id);
	}

	/** A bash call `id` in the work tree `root` starts; the returned function ends it and tells what else ran meanwhile. */
	watch(id: string, root: string): () => Watched {
		const shared = [...this.shells].some(([other, where]) => other !== id && where === root);
		const window: Window = { id, root, edited: new Set(this.edits.values()), shared };
		this.shellStart(id, root);
		this.windows.add(window);
		return () => {
			this.windows.delete(window);
			this.end(id);
			return { edited: new Set(window.edited), shared: window.shared };
		};
	}
}
