/**
 * Closing a popup with a click outside it. Pi's fullscreen view routes a
 * click that misses every overlay to the transcript beneath, and an
 * extension's input listener runs after the view has already taken the
 * mouse, so neither the popup nor a listener ever sees it. While a popup is
 * open, this stands in for the view's transcript dispatch: a left press
 * outside the popup closes it and is swallowed. The press's target then
 * takes the release and click that follow, so the dismissing click can't
 * also click the row under the pointer. Wheel scrolling still reaches the
 * transcript.
 *
 * Pi hands extensions a Proxy of its TUI, not the TUI itself: each read of a
 * method returns a new wrapper, and deletes land on the Proxy's empty target.
 * So the stand-in goes on the class that defines the dispatch, found through
 * the Proxy's prototype, and is taken off once no popup needs it. A stand-in
 * left behind would swallow every left press, clicks and text selection with
 * it, for the rest of the process.
 */
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

type Dispatch = (event: TuiMouseEvent) => unknown;

/** Where the stand-in keeps its state on the patched prototype; shared by copies of this module loaded by /reload. */
const SLOT = Symbol.for("pi-extras.outside-click.v1");

interface Patch {
	readonly original: Dispatch;
	readonly standIn: Dispatch;
	/** One per open popup, newest last. */
	readonly closers: Array<() => void>;
}

/** The prototype that defines Pi's transcript dispatch; the classic view has no mouse and lacks it. */
interface LayoutDispatcher {
	dispatchMouseToLayout?: Dispatch;
	[SLOT]?: Patch;
}

/** The TUI the dispatch runs on; `hasOverlay` is its public check for anything drawn on top. */
interface OverlayHost {
	hasOverlay?(): boolean;
}

/** The dismissing press's target: Pi sends it the release and click that follow. */
const SINK: Component = {
	render: () => [],
	invalidate: () => undefined,
	handleMouse: () => ({ handled: true }),
};

const swallowed = (event: TuiMouseEvent) => ({
	handled: true as const,
	target: { component: SINK, originX: event.screenX, originY: event.screenY, width: 1, height: 1 },
});

function dispatcherOf(tui: unknown): LayoutDispatcher | undefined {
	let proto = tui !== null && typeof tui === "object" ? Reflect.getPrototypeOf(tui) : null;
	while (proto && proto !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(proto, "dispatchMouseToLayout")) {
			const dispatcher = proto as LayoutDispatcher;
			return typeof dispatcher.dispatchMouseToLayout === "function" ? dispatcher : undefined;
		}
		proto = Reflect.getPrototypeOf(proto);
	}
	return undefined;
}

function install(dispatcher: LayoutDispatcher, original: Dispatch): Patch {
	const closers: Array<() => void> = [];
	const standIn: Dispatch = function (this: OverlayHost | undefined, event) {
		// Pi hides the top overlay on /reload and session switches without closing it, so
		// that popup's undo never runs. With nothing on screen no popup is open: let go.
		if (closers.length > 0 && this?.hasOverlay?.() === false) {
			closers.splice(0);
			uninstall(dispatcher, patch);
		}
		const close = closers.at(-1);
		if (close && event.type === "press" && event.button === "left") {
			close();
			return swallowed(event);
		}
		return original.call(this, event);
	};
	const patch: Patch = { original, standIn, closers };
	dispatcher.dispatchMouseToLayout = standIn;
	dispatcher[SLOT] = patch;
	return patch;
}

function uninstall(dispatcher: LayoutDispatcher, patch: Patch): void {
	if (dispatcher[SLOT] !== patch) return;
	delete dispatcher[SLOT];
	// If something has wrapped the stand-in since, it stays as a pass-through rather than cutting that wrapper out.
	if (dispatcher.dispatchMouseToLayout === patch.standIn) dispatcher.dispatchMouseToLayout = patch.original;
}

/**
 * Calls `close` on a left press outside the popup until the returned undo is
 * called; with several popups open, the newest closes. Undo is idempotent.
 * Returns a no-op when the TUI has no transcript dispatch to stand in for.
 */
export function closeOnOutsideClick(tui: unknown, close: () => void): () => void {
	const dispatcher = dispatcherOf(tui);
	const original = dispatcher?.dispatchMouseToLayout;
	if (!dispatcher || !original) return () => undefined;
	const patch = dispatcher[SLOT] ?? install(dispatcher, original);
	// A fresh function per popup, so undo removes this popup's entry even when two share a `close`.
	const closer = () => close();
	patch.closers.push(closer);
	return () => {
		const at = patch.closers.indexOf(closer);
		if (at < 0) return;
		patch.closers.splice(at, 1);
		if (patch.closers.length === 0) uninstall(dispatcher, patch);
	};
}
