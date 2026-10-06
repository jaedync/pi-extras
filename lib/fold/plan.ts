/**
 * Which transcript rows fold together. Tool rows and replies that say nothing
 * (only thinking or tool calls) are work; a run of work with no visible row
 * between is one group, drawn as a single line where its first member was.
 * Pi's spacers inside a group go with it; one before a visible row stays.
 * A notice Pi adds to the chat during a run (a status line, a cache-miss
 * notice) is drawn where it is but does not split the group around it.
 */

export interface PlanItem {
	/** `tool` and `work` fold; `spacer` is Pi's blank line; `note` is Pi's one-line notice; `visible` is anything else. */
	readonly kind: "tool" | "work" | "spacer" | "note" | "visible";
	/** Lines the row draws now; a visible row that draws nothing does not split a group. */
	readonly height: number;
}

export interface FoldGroup {
	/** Indexes of the folded rows, in order. */
	readonly members: readonly number[];
	/** Spacers that sat between members. */
	readonly dropped: readonly number[];
	/** Nothing visible follows, so the group may still grow. */
	readonly last: boolean;
}

export type PlanEntry = { readonly kind: "item"; readonly index: number } | { readonly kind: "group"; readonly group: number };

export interface FoldPlan {
	readonly entries: readonly PlanEntry[];
	readonly groups: readonly FoldGroup[];
}

export function planFold(items: readonly PlanItem[]): FoldPlan {
	const entries: PlanEntry[] = [];
	const groups: Array<{ members: number[]; dropped: number[]; last: boolean }> = [];
	let open: (typeof groups)[number] | undefined;
	let spacers: number[] = [];
	const flush = () => {
		for (const index of spacers) entries.push({ kind: "item", index });
		spacers = [];
	};
	items.forEach((item, index) => {
		if (item.kind === "spacer") {
			spacers.push(index);
			return;
		}
		if (item.kind === "tool" || item.kind === "work") {
			if (open) {
				open.dropped.push(...spacers);
				spacers = [];
			} else {
				flush();
				open = { members: [], dropped: [], last: false };
				groups.push(open);
				entries.push({ kind: "group", group: groups.length - 1 });
			}
			open.members.push(index);
			return;
		}
		if (item.kind === "note" || item.height > 0) flush();
		if (item.kind !== "note" && item.height > 0) open = undefined;
		entries.push({ kind: "item", index });
	});
	flush();
	if (open) open.last = true;
	return { entries, groups };
}
