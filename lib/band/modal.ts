/**
 * Whether an overlay pi-extras opened is still on screen. Pi takes overlays
 * off screen without closing them, on /reload and session switches, so an
 * overlay's `done` and dispose may never run. Whatever an overlay starts (a
 * frame timer, say) therefore checks `OnScreen` and lets go by itself.
 */

/** The part of Pi's overlay handle used here: it has bounds only while the overlay is on screen. */
export interface OverlayPresence {
	getBounds(): unknown;
}

/** An overlay pi-extras opened. `closed` settles when it closes; `isOpen` turns false once Pi takes it off screen, closed or not. */
export interface ShownOverlay {
	readonly closed: Promise<void>;
	isOpen(): boolean;
}

/** Whether Pi still has an overlay on screen, from the handle Pi passes to `onHandle`. */
export class OnScreen {
	private handle: OverlayPresence | undefined;
	private drawn = false;

	attach(handle: OverlayPresence): void {
		this.handle = handle;
	}

	/** Called from the overlay's render. */
	drew(): void {
		this.drawn = true;
	}

	/** False once Pi has taken the overlay off screen; true until there is a handle and a first draw to go by. */
	shown(): boolean {
		return this.handle === undefined || !this.drawn || this.handle.getBounds() !== undefined;
	}
}
