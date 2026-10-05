/**
 * One child at a time edits files in each workspace: the git work tree that
 * holds the edited file (a checkout or one worktree), or, for a file outside
 * any work tree, the child's own workspace: the shared checkout, or the
 * worktree its helpers inherit. A child takes a workspace's lock with its
 * first `edit` or `write` call there, and keeps it while it
 * is live, waiting on its own subagents included, since they may edit for it.
 * Its ancestors and descendants edit beside it: they coordinate through
 * reports. Main, the user's own session, never takes or checks a lock. A
 * child's `bash` call that changed files takes the lock after the fact
 * (bash-guard.ts).
 */
import { LIVE_STATES, type AgentRecord } from "./types.ts";

const SHARED_CHECKOUT = "";

interface Family {
	get(name: string): AgentRecord | undefined;
	under(name: string, ancestor: string): boolean;
}

const workspaceOf = (record: AgentRecord): string => record.worktree?.path ?? SHARED_CHECKOUT;

const MAX_LISTED = 5;

function lockedError(holder: string, record: AgentRecord): string {
	const where = record.worktree ? "this worktree" : "this checkout";
	return `${holder} is editing files in ${where} until its run ends. Do work that does not edit files, or tell ${record.parent} you need a worktree (isolation: "worktree").`;
}

const listed = (paths: readonly string[]): string => paths.length > MAX_LISTED
	? `${paths.slice(0, MAX_LISTED).join(", ")} and ${paths.length - MAX_LISTED} more`
	: paths.join(", ");

/** What a child whose bash call changed `paths` beside the holder is told, and what the user is told. */
export function bashChangeNotes(record: AgentRecord, holder: string, paths: readonly string[]): { note: string; warning: string } {
	const files = listed(paths);
	return {
		note: `This command changed ${files} in ${record.worktree ? "this worktree" : "this checkout"} while ${holder} holds its edit lock. Don't change files here; tell ${record.parent} if you need a worktree (isolation: "worktree").`,
		warning: `subagents: ${record.name}'s bash command changed ${files} in ${record.worktree ? `the worktree ${record.worktree.path}` : "the shared checkout"} while ${holder} holds its edit lock.`,
	};
}

export class EditLocks {
	/** Holder by workspace. */
	private readonly holders = new Map<string, string>();
	private readonly family: Family;

	constructor(family: Family) {
		this.family = family;
	}

	/** The live holder of `workspace`. */
	private liveHolder(workspace: string): string | undefined {
		const held = this.holders.get(workspace);
		// follow() normally lets go first; a holder that ended or vanished unseen must not block forever.
		const holderState = held === undefined ? undefined : this.family.get(held)?.state;
		return holderState !== undefined && LIVE_STATES.has(holderState) ? held : undefined;
	}

	/** Who holds the lock of `workspace` (by default `name`'s own) now, if anyone. */
	holder(name: string, workspace?: string): string | undefined {
		const record = this.family.get(name);
		return record ? this.liveHolder(workspace ?? workspaceOf(record)) : undefined;
	}

	/** Whether `name` edits in `workspace` now without taking anything: it holds the lock, or works for the holder. */
	holds(name: string, workspace?: string): boolean {
		const holder = this.holder(name, workspace);
		return holder !== undefined && (holder === name || this.family.under(name, holder));
	}

	/**
	 * Takes the lock of `workspace`, a work tree's top level, for an edit by
	 * `name`; without one, of its own workspace. The error says who holds it.
	 */
	claim(name: string, workspace?: string): string | undefined {
		const record = this.family.get(name);
		if (!record) return `No agent named ${name}.`;
		const key = workspace ?? workspaceOf(record);
		const holder = this.liveHolder(key);
		if (holder === undefined || holder === name) {
			this.holders.set(key, name);
			return undefined;
		}
		if (this.family.under(name, holder)) return undefined;
		// A helper can end before the ancestor that now edits too, so the lock moves up to it.
		if (this.family.under(holder, name)) {
			this.holders.set(key, name);
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
