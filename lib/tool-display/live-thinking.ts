/**
 * Where a reply's live thinking shows. Tool Display draws finished thinking
 * in the transcript; the thinking a reply streams now draws either in the
 * transcript or under it, in the phase spinner's tail. Both sides decide
 * with this rule, from the settings Tool Display publishes, so the live
 * thinking never shows in two places.
 */

/** In the transcript, under it (the phase spinner's tail), or nowhere. */
export type LivePlace = "inline" | "tail" | "none";

export interface LiveFacts {
	/** Fold mode draws the reply. */
	readonly folded: boolean;
	/** Its fold group is open. */
	readonly open: boolean;
	/** The thinking style: tail, collapsed or full. */
	readonly mode: unknown;
	/** Pi's thinking toggle (ctrl+t) was pressed an odd number of times since the session started. */
	readonly toggled: boolean;
	/** The reply is drawn outside Pi's transcript (the subagent inspector), where no spinner draws a tail. */
	readonly aside?: boolean;
}

/**
 * An open fold group shows its live thinking; a closed one shows only its
 * line until ctrl+t asks for the thinking, which the tail then shows, as it
 * does unfolded. Unfolded, the collapsed style has no live view until ctrl+t.
 */
export function livePlace(facts: LiveFacts): LivePlace {
	if (facts.aside) return "inline";
	if (facts.folded) return facts.open ? "inline" : facts.toggled ? "tail" : "none";
	return facts.mode !== "collapsed" || facts.toggled ? "tail" : "none";
}

/** What Tool Display publishes for the phase spinner (DISPLAY_SETTINGS_EVENT) that bears on live thinking. */
export interface LiveSettings {
	/** Tool Display draws thinking blocks; else Pi does, live ones too. */
	readonly hidesLiveThinking?: unknown;
	/** Fold mode draws the transcript. */
	readonly folds?: unknown;
	/** The thinking style: tail, collapsed or full. */
	readonly thinking?: unknown;
	/** Pi's thinking toggle (ctrl+t) was pressed an odd number of times since the session started. */
	readonly thinkingToggled?: unknown;
	/** The fold group of the reply that streams now is open. */
	readonly liveOpen?: unknown;
}

/** The phase spinner draws the live thinking's tail under the transcript. */
export function liveTailShown(settings: LiveSettings): boolean {
	if (settings.hidesLiveThinking !== true) return false;
	const folded = settings.folds === true;
	return livePlace({ folded, open: folded && settings.liveOpen === true, mode: settings.thinking, toggled: settings.thinkingToggled === true }) === "tail";
}
