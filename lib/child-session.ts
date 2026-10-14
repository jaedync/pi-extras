/**
 * Sessions that the subagents extension starts. A child loads the extensions
 * that own its tools, and a child's task arrives as a prompt that looks typed,
 * so an extension that acts only on what the user types asks here. The set is
 * global because each extension gets its own copy of this module.
 */
const SLOT = Symbol.for("pi-extras.child-sessions.v1");

function children(): WeakSet<object> {
	const shared = globalThis as { [SLOT]?: WeakSet<object> };
	shared[SLOT] ??= new WeakSet<object>();
	return shared[SLOT];
}

/** Marks a child's session manager, before its session binds extensions. */
export function markChildSession(sessionManager: object): void {
	children().add(sessionManager);
}

export function isChildSession(sessionManager: unknown): boolean {
	return !!sessionManager && typeof sessionManager === "object" && children().has(sessionManager);
}
