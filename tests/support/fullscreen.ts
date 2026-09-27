/**
 * Pi's real fullscreen TUI on a terminal that goes nowhere, for tests of what
 * overlays do to the mouse. Input goes through Pi's own parsing, dispatch and
 * text selection. `ui.custom` shows overlays the way Pi shows an extension's.
 */
import { Text, TuiAltScreen, type Component, type OverlayHandle, type OverlayOptions, type Terminal, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { quiet } from "./quiet-theme.ts";
import { tuiReference } from "./tui-reference.ts";

const COLUMNS = 100;
const ROWS = 40;
const SETTLE_MS = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transcript line that counts the clicks that reach it. */
class ClickCounter implements Component {
	clicks = 0;

	render(width: number): string[] {
		return ["click me".padEnd(width)];
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.clicks++;
		return { handled: true };
	}
}

type Factory = (tui: unknown, theme: unknown, keybindings: unknown, done: (result: never) => void) => Component & { dispose?(): void };

interface CustomOptions {
	overlay?: boolean;
	overlayOptions?: OverlayOptions;
	onHandle?: (handle: OverlayHandle) => void;
}

/** The count of callbacks on pi-extras's shared frame ticker. */
export function frameSubscribers(): number {
	const ticker = (globalThis as Record<symbol, { subscribers: Set<unknown> } | undefined>)[Symbol.for("pi-extras.frame-ticker.v1")];
	return ticker?.subscribers.size ?? 0;
}

/** The transcript's first line is selectable text; its second line, at y 2, counts clicks. */
export function fullscreen() {
	let input: (data: string) => void = () => undefined;
	const terminal = {
		columns: COLUMNS, rows: ROWS, kittyProtocolActive: false,
		start(onInput: (data: string) => void) { input = onInput; },
		stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	} as unknown as Terminal;
	const tui = new TuiAltScreen(terminal, false, undefined, {});
	const counter = new ClickCounter();
	tui.addChild(new Text("hello selectable world", 0, 0));
	tui.addChild(counter);
	tui.start();
	const reference = tuiReference(tui);
	const theme = quiet();
	// SGR mouse reports, 1-based: button 0 is left, 32 marks motion.
	const mouse = (code: number, x: number, y: number, end: "M" | "m") => input(`\x1b[<${code};${x};${y}${end}`);
	const settle = async (ms = SETTLE_MS) => {
		tui.requestRender();
		await sleep(ms);
	};

	/** Pi 0.87's showExtensionCustom for overlays: the extension gets the TUI reference, and `done` hides the overlay, then disposes it. */
	const ui = {
		custom<T>(factory: Factory, options?: CustomOptions): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				let component: (Component & { dispose?(): void }) | undefined;
				let closed = false;
				const close = (result: T) => {
					if (closed) return;
					closed = true;
					tui.hideOverlay();
					resolve(result);
					try { component?.dispose?.(); } catch { /* Pi ignores dispose errors too. */ }
				};
				Promise.resolve(factory(reference, theme, {}, close as (result: never) => void))
					.then((made) => {
						if (closed) return;
						component = made;
						options?.onHandle?.(tui.showOverlay(made, options.overlayOptions));
					})
					.catch(reject);
			});
		},
		notify() {},
	};

	return {
		tui,
		ui,
		counter,
		settle,
		key: (data: string) => input(data),
		async click(x: number, y: number) {
			mouse(0, x, y, "M");
			mouse(0, x, y, "m");
			await settle();
		},
		/** Drags across the first line; whether that left text selected. A click after clears it. */
		async select(): Promise<boolean> {
			mouse(0, 1, 1, "M");
			mouse(32, 5, 1, "M");
			mouse(32, 9, 1, "M");
			mouse(0, 9, 1, "m");
			await settle();
			const selected = tui.hasActiveSelection();
			mouse(0, 30, 1, "M");
			mouse(0, 30, 1, "m");
			await settle();
			return selected;
		},
		/** Takes every overlay down first, so one a failed test left open can't reach into the next. */
		stop() {
			while (tui.hasOverlay()) tui.hideOverlay();
			tui.stop();
		},
	};
}
