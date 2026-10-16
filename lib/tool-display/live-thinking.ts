/**
 * Where a reply's live thinking shows. Tool Display draws finished thinking
 * in the transcript; the thinking a reply streams now draws either in the
 * transcript or under it, in the phase spinner's tail. Both sides decide
 * with this rule, from the settings Tool Display publishes, so the live
 * thinking never shows in two places.
 */

/** What Tool Display publishes for the phase spinner (DISPLAY_SETTINGS_EVENT) that bears on live thinking. */
export interface LiveSettings {
	/** Tool Display draws thinking blocks; else Pi does, live ones too. */
	readonly hidesLiveThinking?: unknown;
	/** Fold mode draws the transcript. */
	readonly folds?: unknown;
	/** The thinking style: tail, collapsed or full. */
	readonly thinking?: unknown;
}

/** The phase spinner draws the live thinking's tail under the transcript. */
export function liveTailShown(settings: LiveSettings): boolean {
	return settings.hidesLiveThinking === true && settings.folds !== true && settings.thinking !== "collapsed";
}
