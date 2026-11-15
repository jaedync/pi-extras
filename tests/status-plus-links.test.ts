import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copiedNotice, copyFailedNotice, isRemoteSession, keepLinkCopy, linkCopier, linkOpener, macOpenArgs, readCopyLinks, readOpenLinksOn, type LinkCopyDeps } from "../lib/status-plus-links.ts";
import { Text } from "@earendil-works/pi-tui";
import { fullscreen } from "./support/fullscreen.ts";
import { liveTuiReference, tuiReference } from "./support/tui-reference.ts";

/** TuiAltScreen keeps its link handler in a public field the constructor sets. */
class AltScreen {
	openUrl: ((url: string) => void) | undefined;
	constructor(openUrl: (url: string) => void) {
		this.openUrl = openUrl;
	}
	requestRender(): void {}
}

/** TuiMainScreen has no link handler: the terminal opens links in regular mode. */
class MainScreen {
	requestRender(): void {}
}

function recorder(copy: LinkCopyDeps["copy"] = () => undefined) {
	const notes: [string, string][] = [];
	const reports: unknown[] = [];
	const copied: string[] = [];
	const deps: LinkCopyDeps = {
		copy: (text) => {
			copied.push(text);
			return copy(text);
		},
		notify: (message, type) => notes.push([type, message]),
		report: (error) => reports.push(error),
	};
	return { deps, notes, reports, copied };
}

test("a session is remote by Pi's own clipboard test", () => {
	assert.equal(isRemoteSession({}), false);
	assert.equal(isRemoteSession({ SSH_CONNECTION: "", PI_CLIPBOARD_OSC52: "0" }), false);
	for (const env of [{ SSH_CONNECTION: "192.0.2.2 50000 192.0.2.1 22" }, { SSH_CLIENT: "192.0.2.2 50000 22" }, { MOSH_CONNECTION: "192.0.2.2" }, { PI_CLIPBOARD_OSC52: "1" }]) {
		assert.equal(isRemoteSession(env), true, JSON.stringify(env));
	}
});

test("a click on a link copies it and shows the link", async () => {
	const { deps, notes, copied } = recorder(async () => undefined);
	await linkCopier(deps).openUrl("https://example.test/a?b=1");
	assert.deepEqual(copied, ["https://example.test/a?b=1"]);
	assert.deepEqual(notes, [["info", "Copied link: https://example.test/a?b=1"]]);
	assert.equal(copiedNotice("https://example.test/"), "Copied link: https://example.test/");
});

test("a copy that fails or throws names the link in a warning, so it can still be selected", async () => {
	const rejected = recorder(async () => {
		throw new Error("Clipboard unavailable");
	});
	await linkCopier(rejected.deps).openUrl("https://example.test/one");
	assert.deepEqual(rejected.notes, [["warning", "Could not copy the link (Clipboard unavailable): https://example.test/one"]]);
	const thrown = recorder(() => {
		throw "no terminal";
	});
	await linkCopier(thrown.deps).openUrl("https://example.test/two");
	assert.deepEqual(thrown.notes, [["warning", copyFailedNotice("https://example.test/two", "no terminal")]]);
	assert.equal(copyFailedNotice("https://example.test/two", "no terminal"), "Could not copy the link (no terminal): https://example.test/two");
});

test("a notice that cannot be shown is reported, never thrown", async () => {
	const reports: unknown[] = [];
	const copier = linkCopier({
		copy: () => undefined,
		notify: () => {
			throw new Error("stale context");
		},
		report: (error) => reports.push(error),
	});
	await assert.doesNotReject(copier.openUrl("https://example.test/"));
	assert.equal((reports[0] as Error).message, "stale context");
});

test("the copier takes the fullscreen renderer's link handler once, and again on a new renderer", () => {
	const opened: string[] = [];
	const first = new AltScreen((url) => opened.push(`first ${url}`));
	let current: object = first;
	const tui = liveTuiReference<object>(() => current);
	const copier = linkCopier(recorder().deps);
	assert.equal(keepLinkCopy(tui, copier), true);
	assert.equal(first.openUrl, copier.openUrl);
	// Every frame checks; a renderer that has the copier already is left alone.
	assert.equal(keepLinkCopy(tui, copier), false);
	assert.equal(first.openUrl, copier.openUrl);
	// Regular mode opens links in the terminal: its renderer gets nothing.
	const main = new MainScreen();
	current = main;
	assert.equal(keepLinkCopy(tui, copier), false);
	assert.equal("openUrl" in main, false);
	assert.deepEqual(Object.getOwnPropertySymbols(main), []);
	// Back to fullscreen: Pi builds a new renderer with its own handler again.
	const second = new AltScreen((url) => opened.push(`second ${url}`));
	current = second;
	assert.equal(keepLinkCopy(tui, copier), true);
	assert.equal(second.openUrl, copier.openUrl);
	assert.equal(first.openUrl, copier.openUrl);
	assert.deepEqual(opened, []);
});

test("a copier from /reload replaces the old one, and with none Pi's own handler comes back", () => {
	const opened: string[] = [];
	const screen = new AltScreen((url) => opened.push(url));
	const tui = tuiReference(screen);
	const old = linkCopier(recorder().deps);
	keepLinkCopy(tui, old);
	const next = linkCopier(recorder().deps);
	assert.equal(keepLinkCopy(tui, next), true);
	assert.equal(screen.openUrl, next.openUrl);
	// Turned off, then /reload: the handler Pi set opens links again, not a copier wrapped in a copier.
	assert.equal(keepLinkCopy(tui, undefined), true);
	assert.notEqual(screen.openUrl, old.openUrl);
	assert.notEqual(screen.openUrl, next.openUrl);
	screen.openUrl?.("https://example.test/");
	assert.deepEqual(opened, ["https://example.test/"]);
	assert.equal(keepLinkCopy(tui, undefined), false);
});

test("in Pi's real fullscreen TUI, a click on a link reaches the copier through the footer's reference", async (t) => {
	const screen = fullscreen();
	t.after(() => screen.stop());
	// Under the two lines fullscreen() adds: row 3, 1-based.
	screen.tui.addChild(new Text("\x1b]8;;https://example.test/page\x07open the page\x1b]8;;\x07", 0, 0));
	await screen.settle();
	const { deps, copied, notes } = recorder(async () => undefined);
	assert.equal(keepLinkCopy(tuiReference(screen.tui), linkCopier(deps)), true);
	await screen.click(4, 3);
	assert.deepEqual(copied, ["https://example.test/page"]);
	assert.deepEqual(notes, [["info", "Copied link: https://example.test/page"]]);
});

test("a local session leaves Pi's link handler as it is", () => {
	const open = (_url: string) => undefined;
	const screen = new AltScreen(open);
	assert.equal(keepLinkCopy(tuiReference(screen), undefined), false);
	assert.equal(screen.openUrl, open);
	assert.deepEqual(Object.getOwnPropertySymbols(screen), []);
});

test("statusPlus.copyLinks: false turns link copy off; anything else keeps it on", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "status-plus-links-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "pi-extras.json");
	assert.equal(readCopyLinks(file), true);
	writeFileSync(file, JSON.stringify({ statusPlus: { copyLinks: false } }));
	assert.equal(readCopyLinks(file), false);
	writeFileSync(file, JSON.stringify({ statusPlus: { copyLinks: "no" } }));
	assert.equal(readCopyLinks(file), true);
	writeFileSync(file, "{ not json");
	assert.equal(readCopyLinks(file), true);
});

test("the Mac to open links on is an SSH host name from pi-extras.json, or none", () => {
	const dir = mkdtempSync(join(tmpdir(), "open-on-"));
	try {
		const file = join(dir, "pi-extras.json");
		for (const [value, want] of [["mac", "mac"], ["mac-mini.local", "mac-mini.local"], ["", undefined], ["-oProxyCommand=x", undefined], ["a b", undefined], [7, undefined]] as const) {
			writeFileSync(file, JSON.stringify({ statusPlus: { openLinksOn: value } }));
			assert.equal(readOpenLinksOn(file), want, String(value));
		}
		writeFileSync(file, "{}");
		assert.equal(readOpenLinksOn(file), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a link opens on the Mac with ssh: one quoted argument that its shell cannot run", () => {
	assert.deepEqual(macOpenArgs("mac", "https://inbox.example/#abc"),
		["-n", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", "mac", "open", "-u", "'https://inbox.example/#abc'"]);
	// The remote shell reads the command line: a quote, $() or ; in the link stays text.
	const odd = macOpenArgs("mac", "https://x.example/a'b$(touch%20/tmp/p);c")!;
	assert.equal(odd.at(-1), `'https://x.example/a'\\''b$(touch%20/tmp/p);c'`);
	// A link that the parser would change on the way (a tab, a newline, a backslash, a space)
	// reads as one place and opens another: it is copied, not opened. So is a very long one.
	for (const url of ["https://good.example\t.evil.example/", "https:\\\\evil.example", "https://x.example/a b", "https://x.example/" + "a".repeat(9000)]) {
		assert.equal(macOpenArgs("mac", url), undefined, url.slice(0, 40));
	}
	for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://x", "not a url"]) assert.equal(macOpenArgs("mac", url), undefined, url);
	assert.equal(macOpenArgs("-oProxyCommand=x", "https://x.example/"), undefined);
	// What the parser lets through is plain ASCII: a newline, a control character, a space or
	// a look-alike letter never reaches the remote shell as itself.
	for (const url of ["https://x.example/a\nb", "https://x.example/a\u0007b", "https://x.example/a b", "https://аpple.example/", "https://x.example/\u202eb"]) {
		const args = macOpenArgs("mac", url);
		if (args) assert.match(args.at(-1)!, /^'https:\/\/[\x21-\x7e]+'$/, url);
	}
	assert.equal(macOpenArgs("mac", " -n https://x.example/"), undefined);
	assert.equal(macOpenArgs("mac", "--args https://x.example/"), undefined);
});

test("a click opens the link on the Mac, and a failure copies it as before", async () => {
	const ran: string[][] = [];
	const { deps, notes, copied } = recorder(async () => undefined);
	const opener = linkOpener({ ...deps, run: async (args) => { ran.push(args); } }, "mac");
	await opener.openUrl("https://inbox.example/#abc");
	assert.equal(ran.length, 1);
	assert.deepEqual(copied, []);
	assert.deepEqual(notes, [["info", "Opened on mac: https://inbox.example/#abc"]]);

	const failing = recorder(async () => undefined);
	const broken = linkOpener({ ...failing.deps, run: async () => { throw new Error("ssh: connect timed out"); } }, "mac");
	await broken.openUrl("https://inbox.example/#abc");
	assert.deepEqual(failing.copied, ["https://inbox.example/#abc"]);
	assert.deepEqual(failing.notes, [["info", "Could not open it on mac (ssh: connect timed out). Copied link: https://inbox.example/#abc"]]);

	const other = recorder(async () => undefined);
	const never = linkOpener({ ...other.deps, run: async () => { throw new Error("must not run"); } }, "mac");
	await never.openUrl("file:///etc/passwd");
	assert.deepEqual(other.copied, ["file:///etc/passwd"]);
	assert.deepEqual(other.notes, [["info", "Copied link: file:///etc/passwd"]]);
});
