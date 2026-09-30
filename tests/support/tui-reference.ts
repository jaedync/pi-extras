/**
 * A copy of Pi's `createInteractiveTuiReference`
 * (dist/modes/interactive/tui-renderer.js), which isn't exported. Pi hands
 * extensions this Proxy instead of its TUI, so tests of code that reaches
 * into the TUI go through it too. Each read of a method returns a new
 * wrapper, and own-property checks and deletes reach an empty target, not
 * the TUI.
 */
export function tuiReference<T extends object>(tui: T): T {
	return new Proxy({}, {
		get: (_target, property) => {
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => Reflect.apply(value, tui, args);
		},
		set: (_target, property, value) => Reflect.set(tui, property, value, tui),
		has: (_target, property) => Reflect.has(tui, property),
		getPrototypeOf: () => Reflect.getPrototypeOf(tui),
	}) as T;
}
