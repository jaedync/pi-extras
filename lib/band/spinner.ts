/**
 * The spinners for a tool call the model is writing or running. The phase
 * line under the transcript and the call's own row draw the same one, so the
 * two read as the same activity.
 */

export interface Spinner {
	readonly frames: readonly string[];
	readonly intervalMs: number;
}

/** The model is writing a tool call's arguments. */
export const WRITING: Spinner = { frames: ["⠈", "⠘", "⠸", "⠴", "⠦", "⠇", "⠃", "⠉"], intervalMs: 85 };

/** A tool call runs. */
export const RUNNING: Spinner = { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 };

/** The frame `ms` into the spinner. */
export function frameAt(spinner: Spinner, ms: number): string {
	const step = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / spinner.intervalMs);
	return spinner.frames[step % spinner.frames.length] ?? "⠿";
}
