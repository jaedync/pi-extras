/** Weak ownership survives module reloads without retaining terminals or mixing sessions. */
export interface Ownership {
	readonly sessionId: string;
	readonly sessionStatus: boolean;
	readonly progress: boolean;
}
const KEY = Symbol.for("pi-extras.tab-status.reload-handoff.v1");
const registry = globalThis as typeof globalThis & { [key: symbol]: WeakMap<object, Ownership> | undefined };
const handoffs = registry[KEY] ?? new WeakMap<object, Ownership>();
if (!registry[KEY]) Object.defineProperty(registry, KEY, { value: handoffs });

export function remember(manager: object, ownership: Ownership): void {
	handoffs.set(manager, { ...ownership });
}

export function take(manager: object, sessionId: string): Ownership | undefined {
	const ownership = handoffs.get(manager);
	handoffs.delete(manager);
	return ownership?.sessionId === sessionId ? { ...ownership } : undefined;
}

export function forget(manager: object, sessionId: string): void {
	if (handoffs.get(manager)?.sessionId === sessionId) handoffs.delete(manager);
}
