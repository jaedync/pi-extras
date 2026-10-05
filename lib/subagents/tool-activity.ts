/**
 * The `edit`, `write` and `bash` calls running now, in main and in every
 * child, so a child's bash call is not blamed for a change another agent
 * made at the same time. Ids are `<agent>:<tool call id>`: call ids are only
 * unique within one session.
 */
interface Window {
	readonly id: string;
	readonly cwd: string;
	readonly edited: Set<string>;
	shared: boolean;
}

export interface Watched {
	/** Resolved paths an `edit` or `write` call targeted during the watch. */
	edited: ReadonlySet<string>;
	/** Whether another agent's bash call ran in the same workspace during the watch. */
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

	/** A bash call in `cwd` starts. */
	shellStart(id: string, cwd: string): void {
		this.shells.set(id, cwd);
		for (const window of this.windows) if (window.id !== id && window.cwd === cwd) window.shared = true;
	}

	/** The call `id` ended, whatever it was. */
	end(id: string): void {
		this.edits.delete(id);
		this.shells.delete(id);
	}

	/** A bash call `id` in `cwd` starts; the returned function ends it and tells what else ran meanwhile. */
	watch(id: string, cwd: string): () => Watched {
		const shared = [...this.shells].some(([other, where]) => other !== id && where === cwd);
		const window: Window = { id, cwd, edited: new Set(this.edits.values()), shared };
		this.shellStart(id, cwd);
		this.windows.add(window);
		return () => {
			this.windows.delete(window);
			this.end(id);
			return { edited: new Set(window.edited), shared: window.shared };
		};
	}
}
