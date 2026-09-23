/**
 * Types the finished transcript into the editor instead of dropping it in at
 * once. The pacing exists only to hide the last chunk's decode: text that is
 * ready at stop is spread across the predicted wait (capped), and once the
 * whole transcript is known it finishes within a short tail. It never waits
 * longer than necessary, so it adds at most TAIL_MAX_MS over a plain insert.
 */

export const STREAM_FRAME_MS = 16;
/** Longest the ready text is spread out while the last chunk decodes. */
export const MAX_COVER_MS = 400;
/** Longest it takes to finish once the transcript is complete. */
export const TAIL_MAX_MS = 150;
const TAIL_MS_PER_CHAR = 4;

export interface StreamOptions {
	now(): number;
	/** Runs `fn` after `ms`; returns a cancel function. */
	schedule(fn: () => void, ms: number): () => void;
	emit(text: string): void;
	/** Called once everything is inserted after finish(); never after cancel(). */
	onDone(): void;
}

function tailMs(chars: number): number {
	return Math.min(TAIL_MAX_MS, chars * TAIL_MS_PER_CHAR);
}

/** End of the word that contains `index`, so pieces never split a word. */
function wordEnd(text: string, index: number): number {
	if (index >= text.length) return text.length;
	const space = text.indexOf(" ", index);
	return space === -1 ? text.length : space;
}

export class TranscriptStream {
	private readonly options: StreamOptions;
	/** Separator for the editor's existing text, applied once text exists. */
	private readonly lead: string;
	private text = "";
	private shown = 0;
	private deadline: number;
	private complete = false;
	private stopped = false;
	private cancelTimer?: () => void;

	/** `coverMs` is the predicted wait for the transcript still decoding. */
	constructor(options: StreamOptions, lead: string, ready: string, coverMs: number) {
		this.options = options;
		this.lead = lead;
		this.deadline = options.now() + Math.min(MAX_COVER_MS, Math.max(0, coverMs));
		this.setTranscript(ready);
		this.tick();
	}

	get inserted(): boolean {
		return this.shown > 0;
	}

	/** More chunks finished; `transcript` extends what was offered before. */
	offer(transcript: string): void {
		if (this.complete || this.stopped) return;
		if (this.setTranscript(transcript)) this.wake();
	}

	finish(transcript: string): void {
		if (this.stopped) return;
		this.setTranscript(transcript);
		this.complete = true;
		const now = this.options.now();
		this.deadline = Math.min(Math.max(this.deadline, now), now + tailMs(this.text.length - this.shown));
		this.wake();
	}

	cancel(): void {
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}

	private setTranscript(transcript: string): boolean {
		const trimmed = transcript.trim();
		const next = trimmed ? this.lead + trimmed : "";
		if (next.length <= this.text.length) return false;
		// The final text is the daemon's join of the same chunk texts, so it extends what is already shown.
		const shownText = this.text.slice(0, this.shown);
		this.text = next.startsWith(shownText) ? next : shownText + next.slice(this.shown);
		const now = this.options.now();
		if (this.deadline <= now) this.deadline = now + tailMs(this.text.length - this.shown);
		return true;
	}

	private wake(): void {
		if (!this.cancelTimer) this.tick();
	}

	private readonly tick = (): void => {
		this.cancelTimer = undefined;
		if (this.stopped) return;
		const remaining = this.text.length - this.shown;
		if (remaining > 0) {
			const left = this.deadline - this.options.now();
			const count = left <= STREAM_FRAME_MS ? remaining : Math.ceil((remaining * STREAM_FRAME_MS) / left);
			const end = wordEnd(this.text, this.shown + count);
			const piece = this.text.slice(this.shown, end);
			this.shown = end;
			this.options.emit(piece);
		}
		if (this.shown < this.text.length) {
			this.cancelTimer = this.options.schedule(this.tick, STREAM_FRAME_MS);
		} else if (this.complete) {
			this.stopped = true;
			this.options.onDone();
		}
	};
}
