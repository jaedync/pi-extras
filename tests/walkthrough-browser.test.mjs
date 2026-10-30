/**
 * The browser cleanup: a close that fails or hangs must reach the shutdown
 * runner, which names the cleanup and prints the error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, OWN_SHUTDOWN, trackBrowser, trackUntilClosed } from "../skills/walkthrough-video/scripts/lib/browser.mjs";

test("a browser close that fails is not swallowed by its cleanup", async () => {
	const browser = {
		close: async () => {
			throw new Error("the browser is already gone");
		},
	};
	let cleanup = null;
	trackBrowser(browser, (fn, name) => {
		assert.equal(name, "the browser", "the runner names the cleanup");
		cleanup = fn;
		return () => {};
	});
	// The cleanup rejects: the runner reports it instead of the browser hiding the error.
	await assert.rejects(cleanup(), /already gone/);
});

test("every launch passes the three flags that turn Playwright's own signal handling off", async () => {
	assert.deepEqual(OWN_SHUTDOWN, { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
	const options = await launchBrowser({ launch: async (given) => given }, { executablePath: "/bin/true" });
	assert.equal(options.handleSIGINT, false);
	assert.equal(options.handleSIGHUP, false);
	assert.equal(options.executablePath, "/bin/true");
});

test("a normal close removes the browser's signal cleanup (G7)", async () => {
	let removed = 0;
	let registered = 0;
	const browser = {
		closed: false,
		close: async () => {
			browser.closed = true;
		},
	};
	trackUntilClosed(browser, () => {
		registered++;
		return () => {
			removed++;
		};
	});
	assert.equal(registered, 1, "the browser was registered for the signal cleanup");
	await browser.close();
	assert.equal(browser.closed, true, "the browser closed");
	assert.equal(removed, 1, "its cleanup was unregistered after the close");
	// A close that fails must still unregister, or a signal would close it twice.
	let brokenRemoved = 0;
	const broken = { close: async () => Promise.reject(new Error("already gone")) };
	trackUntilClosed(broken, () => () => {
		brokenRemoved++;
	});
	await assert.rejects(broken.close(), /already gone/);
	assert.equal(brokenRemoved, 1, "a failed close still unregisters");
});
