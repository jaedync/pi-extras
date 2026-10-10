/**
 * Process groups this extension started. Helpers and installers run detached
 * so a kill reaches their own children (ffmpeg, the token script); that also
 * means Pi's exit does not reach them, so they are killed here when Pi exits.
 */
const KEY = Symbol.for("pi-extras.link-context.children.v1");

interface Registry { groups: Set<number>; hooked: boolean }

// Symbol.for keeps one registry and one exit hook across copies loaded by /reload.
function registry(): Registry {
	const slot = globalThis as Record<symbol, Registry | undefined>;
	slot[KEY] ??= { groups: new Set(), hooked: false };
	return slot[KEY];
}

export function killGroup(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/** Tracks a detached child's group until it exits; returns the untrack function. */
export function track(pid: number | undefined): () => void {
	if (!pid) return () => {};
	const state = registry();
	state.groups.add(pid);
	if (!state.hooked) {
		state.hooked = true;
		process.once("exit", () => {
			for (const group of state.groups) killGroup(group);
		});
	}
	return () => state.groups.delete(pid);
}
