/**
 * One child at a time edits files in each workspace: the shared checkout, or
 * one worktree, which the helpers that inherit it share. A child takes its
 * workspace's lock with its first `edit` or `write` call, and keeps it while it
 * is live, waiting on its own subagents included, since they may edit for it.
 * Its ancestors and descendants edit beside it: they coordinate through
 * reports. Main, the user's own session, never takes or checks a lock, and
 * `bash` is not covered.
 */
import { LIVE_STATES, type AgentRecord } from "./types.ts";

const SHARED_CHECKOUT = "";

interface Family {
	get(name: string): AgentRecord | undefined;
	under(name: string, ancestor: string): boolean;
}

const workspaceOf = (record: AgentRecord): string => record.worktree?.path ?? SHARED_CHECKOUT;

function lockedError(holder: string, record: AgentRecord): string {
	const where = record.worktree ? "this worktree" : "this checkout";
	return `${holder} is editing files in ${where} until its run ends. Do work that does not edit files, or tell ${record.parent} you need a worktree (isolation: "worktree").`;
}

export class EditLocks {
	/** Holder by workspace. */
	private readonly holders = new Map<string, string>();
	private readonly family: Family;

	constructor(family: Family) {
		this.family = family;
	}

	/** Takes `name`'s workspace lock for an edit; the error says who holds it when it can't. */
	claim(name: string): string | undefined {
		const record = this.family.get(name);
		if (!record) return `No agent named ${name}.`;
		const workspace = workspaceOf(record);
		const holder = this.holders.get(workspace);
		if (holder === undefined || holder === name) {
			this.holders.set(workspace, name);
			return undefined;
		}
		if (this.family.under(name, holder)) return undefined;
		// A helper can end before the ancestor that now edits too, so the lock moves up to it.
		if (this.family.under(holder, name)) {
			this.holders.set(workspace, name);
			return undefined;
		}
		return lockedError(holder, record);
	}

	/** Called on every record change: a holder that is no longer live lets go. */
	follow(record: AgentRecord): void {
		if (LIVE_STATES.has(record.state)) return;
		for (const [workspace, holder] of this.holders) if (holder === record.name) this.holders.delete(workspace);
	}
}
