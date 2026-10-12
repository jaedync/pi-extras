/**
 * Where a new child works: the directory it starts in, the worktree it gets or
 * inherits, and the checkout its edit lock follows (checkout.ts). Making a
 * worktree is the only side effect, so a spawn checks everything else first.
 */
import { checkoutOf, CONTROL, resolveCwd } from "./checkout.ts";
import type { AgentRecord, SpawnRequest, Worktree } from "./types.ts";
import { createWorktree, placeInWorktree } from "./worktree.ts";

export interface Placement {
	readonly worktree?: Worktree;
	/** The directory it starts in, when it has one of its own or inherits one. */
	readonly cwd?: string;
	readonly checkout?: string;
}

export interface MainPlace {
	/** Main's working directory. */
	readonly cwd?: string;
	/** The checkout of main's working directory, looked up at the first need. */
	checkout(): string | undefined;
}

type Placed = { ok: true; place: Placement } | { ok: false; error: string };

/** The directory a spawn named, checked against what its parent allows. */
function namedCwd(request: Pick<SpawnRequest, "cwd" | "isolation">, parent: AgentRecord | null): { ok: true; cwd?: string } | { ok: false; error: string } {
	if (request.cwd === undefined) return { ok: true };
	let cwd: string;
	try { cwd = resolveCwd(request.cwd); }
	catch (error) { return { ok: false, error: (error as Error).message }; }
	// Its edits are held to the worktree it would inherit (child.ts), wherever it started.
	// Also with isolation: "worktree": main makes it with git and no sandbox, in a repository the sandboxed child could have made.
	if (parent?.worktree) {
		return { ok: false, error: `${parent.name}'s subagents work in its worktree ${parent.worktree.path}. Leave out cwd.` };
	}
	// Making a worktree runs the repository's git hooks, which a read-only agent must not choose.
	if (parent?.readOnly && request.isolation === "worktree") {
		return { ok: false, error: `${parent.name} is read-only, so its subagents can't make a worktree from a cwd. Leave out cwd or isolation.` };
	}
	return { ok: true, cwd };
}

/** Places the child `name` that `parent` (null for main) starts; makes its worktree when the spawn asks for one. */
export function placeChild(request: Pick<SpawnRequest, "cwd" | "isolation">, parent: AgentRecord | null, name: string, main: MainPlace): Placed {
	const named = namedCwd(request, parent);
	if (!named.ok) return named;
	const { cwd } = named;
	// The directory a new worktree is made from and mirrors: the one named, else the parent's own; unset without a cwd anywhere.
	const origin = cwd ?? parent?.cwd;
	let worktree = parent?.worktree;
	if (request.isolation === "worktree") {
		const source = origin ?? parent?.worktree?.path ?? main.cwd;
		if (!source) return { ok: false, error: "Worktree isolation needs a git repository in the parent's workspace." };
		// The child index refuses such paths, so it could not keep the worktree (restore.ts).
		if (CONTROL.test(source)) return { ok: false, error: "Worktree isolation needs a repository path without control characters." };
		try { worktree = createWorktree(source, name, cwd, parent?.worktree); }
		catch (error) { return { ok: false, error: (error as Error).message }; }
	}
	// A worktree starts in the same directory of it as its origin; a helper starts where its parent does unless told where.
	const startsIn = request.isolation === "worktree"
		? (origin && worktree ? placeInWorktree(worktree.path, checkoutOf(origin), origin) : undefined)
		: cwd ?? parent?.cwd;
	const checkout = worktree?.path ?? (cwd ? checkoutOf(cwd) : parent ? parent.checkout : main.checkout());
	return { ok: true, place: { ...(worktree ? { worktree } : {}), ...(startsIn ? { cwd: startsIn } : {}), ...(checkout ? { checkout } : {}) } };
}
