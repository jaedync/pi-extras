/**
 * The clock install script of a capture, through CDP. A document reads the
 * capture time from the script that is registered when it is created, so the
 * script is replaced after every advance. The replacement is serialized: two
 * callers (an advance and a navigation) never interleave their remove and add,
 * and the new script is added before the old one is removed, so a document that
 * is created in between still gets a clock, with the later start time.
 */
export function createClockScripts({ send, source, log = (_line) => {} }) {
	let active = null;
	let queue = Promise.resolve();
	// The highest start time ever published. A navigation can compute an earlier value than
	// the pump forecast; a document must never start before the document it replaces.
	let highest = -1;
	/**
	 * Adds a script that starts a document at `ms` of capture time, then removes
	 * the previous one. A failure reaches the caller, so the pump stops instead of
	 * capturing frames whose documents start at the wrong time. The queue itself
	 * survives: a later replacement still runs, in order.
	 */
	const replace = (ms) => {
		const value = Math.max(highest, ms);
		highest = value;
		const mine = queue.then(async () => {
			const added = await send("Page.addScriptToEvaluateOnNewDocument", { source: source(value) });
			const previous = active;
			active = added.identifier;
			if (previous) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous }).catch(() => {});
		});
		queue = mine.catch((error) => log(`clock: the start time was not updated: ${error?.message ?? error}`));
		return mine;
	};
	return { replace, active: () => active, idle: () => queue };
}
