/**
 * A copy of Pi's `createInteractiveTuiReference`
 * (dist/modes/interactive/tui-renderer.js), which isn't exported. Pi hands
 * extensions this Proxy instead of its TUI, so tests of code that reaches
 * into the TUI go through it too. Each read of a method returns a new
 * wrapper, and own-property checks and deletes reach an empty target, not
 * the TUI.
 */
export function tuiReference<T extends object>(tui: T): T {
	return liveTuiReference(() => tui);
}

/**
 * The same Proxy over whichever renderer `getTui` returns now: Pi builds a
 * new renderer when the TUI mode changes and keeps handing out the old
 * reference, so a read or write after the switch reaches the new one.
 */
export function liveTuiReference<T extends object>(getTui: () => object): T {
	return new Proxy({}, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") throw new TypeError(`TUI property ${String(property)} is not callable`);
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	}) as T;
}
