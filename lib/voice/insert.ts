/**
 * Putting dictated text into the editor. Pi collapses pastes over 1000
 * characters or 10 lines into a "[paste #N]" marker, so long dictation is fed
 * in smaller pieces that each insert literally at the cursor.
 */

export const PASTE_PIECE_CHARS = 900;

/** Separator needed before dictated text so it does not run into `existing`. */
export function leadFor(existing: string): string {
	return existing.length === 0 || /\s$/.test(existing) ? "" : " ";
}

/** Text to insert after `existing` so words do not run together. Empty when there is nothing to add. */
export function joinDictation(existing: string, transcript: string): string {
	const text = transcript.trim();
	return text ? leadFor(existing) + text : "";
}

export function splitForPaste(text: string, max = PASTE_PIECE_CHARS): string[] {
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > max) {
		const space = rest.lastIndexOf(" ", max - 1);
		const cut = space > 0 ? space + 1 : max;
		pieces.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) pieces.push(rest);
	return pieces;
}
