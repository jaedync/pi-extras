/**
 * Browser launches. Playwright installs its own SIGINT, SIGTERM and SIGHUP
 * handlers by default: they close the browsers and then call process.exit(130).
 * That cut wv's own shutdown short, so the child wait never finished and the
 * cleanup never ran. wv owns the shutdown, so every launch turns the three
 * handlers off, and every browser is registered as a cleanup with a timeout.
 */
import { withTimeout } from "./proc.mjs";
import { onSignalCleanup } from "./signals.mjs";

/** Playwright must not stop the process; wv stops it, waits and cleans up. */
export const OWN_SHUTDOWN = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };

/** Launches a browser with Playwright's own signal handling off. */
export function launchBrowser(chromium, options = {}) {
	return chromium.launch({ ...OWN_SHUTDOWN, ...options });
}

/**
 * Closes `browser` when wv is told to stop, with its own timeout. Returns a
 * function that unregisters the cleanup for the normal path.
 */
/**
 * Tracks a browser for the signal cleanup and drops that cleanup after a normal
 * close, so a long-lived process that opens several browsers keeps neither the
 * closed object nor a stale callback.
 */
export function trackUntilClosed(browser, register = onSignalCleanup) {
	const untrack = trackBrowser(browser, register);
	const close = browser.close.bind(browser);
	browser.close = async () => {
		try {
			return await close();
		} finally {
			untrack();
		}
	};
	return browser;
}

export function trackBrowser(browser, register = onSignalCleanup) {
	const cleanup = async () => {
		// No catch: the shutdown runner names the cleanup and prints the error or the timeout.
		await withTimeout(browser.close(), 5000, "the browser");
	};
	return register(cleanup, "the browser");
}
