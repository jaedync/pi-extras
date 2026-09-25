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
 */
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

type Dispatch = (event: TuiMouseEvent) => unknown;

/** The one method of Pi's fullscreen TUI this relies on; the classic view has no mouse and lacks it. */
interface LayoutDispatcher {
	dispatchMouseToLayout?: Dispatch;
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

/**
 * Calls `close` on a left press outside the popup until the returned undo is
 * called. Returns a no-op when the TUI has no transcript dispatch to stand in for.
 */
export function closeOnOutsideClick(tui: unknown, close: () => void): () => void {
	const host = tui as LayoutDispatcher;
	const original = host.dispatchMouseToLayout;
	if (typeof original !== "function") return () => undefined;
	const own = Object.prototype.hasOwnProperty.call(host, "dispatchMouseToLayout");
	const standIn: Dispatch = function (this: unknown, event) {
		if (event.type === "press" && event.button === "left") {
			close();
			return swallowed(event);
		}
		return original.call(this ?? host, event);
	};
	host.dispatchMouseToLayout = standIn;
	return () => {
		if (host.dispatchMouseToLayout !== standIn) return;
		if (own) host.dispatchMouseToLayout = original;
		else delete host.dispatchMouseToLayout;
	};
}
