/**
 * One key does both hold-to-talk and tap-to-toggle. Terminals speaking the
 * Kitty protocol report releases, so a long press stops on release and a short
 * tap waits for the next press. Legacy terminals only send presses, and a held
 * key auto-repeats; presses closer together than the repeat gap are treated as
 * that auto-repeat and ignored.
 */

export type KeyEventKind = "press" | "repeat" | "release";
export type KeyAction = "start" | "stop" | "ignore";

export interface KeyState {
	readonly recording: boolean;
	readonly mode: "idle" | "pending" | "toggle";
	readonly pressedAt: number;
	readonly lastPressAt: number;
}

export const HOLD_THRESHOLD_MS = 350;
// Longer than typical initial key-repeat delays (225–500ms) so a held legacy key cannot toggle itself off.
export const LEGACY_REPEAT_GAP_MS = 600;

export const initialKeyState: KeyState = { recording: false, mode: "idle", pressedAt: -Infinity, lastPressAt: -Infinity };

export function reduceKey(state: KeyState, kind: KeyEventKind, now: number): { state: KeyState; action: KeyAction } {
	if (kind === "repeat") return { state, action: "ignore" };
	if (kind === "release") return onRelease(state, now);
	if (now - state.lastPressAt < LEGACY_REPEAT_GAP_MS) {
		return { state: { ...state, lastPressAt: now }, action: "ignore" };
	}
	if (!state.recording) {
		return { state: { recording: true, mode: "pending", pressedAt: now, lastPressAt: now }, action: "start" };
	}
	return { state: { ...initialKeyState, lastPressAt: now }, action: "stop" };
}

function onRelease(state: KeyState, now: number): { state: KeyState; action: KeyAction } {
	if (!state.recording || state.mode !== "pending") return { state, action: "ignore" };
	if (now - state.pressedAt >= HOLD_THRESHOLD_MS) {
		// Releases prove the terminal reports them, so the next press cannot be auto-repeat.
		return { state: { ...initialKeyState }, action: "stop" };
	}
	return { state: { ...state, mode: "toggle", lastPressAt: -Infinity }, action: "ignore" };
}
