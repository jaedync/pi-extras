/**
 * A click on a link in fullscreen mode, over SSH: copy it, don't open it.
 * Pi's fullscreen renderer opens a clicked OSC 8 link with `xdg-open` (or
 * `open`) on the machine Pi runs on, and ignores a failure. Over SSH that
 * machine is the remote host: a headless one has no `xdg-open`, so the click
 * does nothing and says nothing. Copying sends OSC 52 through the terminal
 * to the clipboard of the machine the user sits at, and the notice shows the
 * link for terminals that drop OSC 52.
 *
 * The renderer keeps its handler in a public `openUrl` field and no extension
 * API sets it, so this writes the field through the `tui` reference a footer
 * gets. That reference is a Proxy to the renderer in use now: a read of a
 * function through it returns a new wrapper each time, so the mark that says
 * "done" is a plain object under a `Symbol.for` key, which reads back as
 * itself. A switch of the TUI mode builds a new renderer with Pi's handler,
 * so the footer calls `keepLinkCopy` on each render.
 */
import { execFile } from "node:child_process";
import { readSection } from "./extras-config.ts";

export const LINK_COPY_MARK = Symbol.for("pi-extras.status-plus.link-copy");
/** pi-extras.json section; `copyLinks: false` turns the copy off. */
const SECTION = "statusPlus";

/** Pi's own test (utils/clipboard.js), so the copy goes the way Pi's copies go. */
export function isRemoteSession(env: Readonly<Record<string, string | undefined>>): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION || env.PI_CLIPBOARD_OSC52 === "1");
}

export function readCopyLinks(file?: string): boolean {
	return readSection(SECTION, file).copyLinks !== false;
}

/** The characters of a URL (RFC 3986): unreserved, reserved and `%`. */
const URL_CHARS = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** A link longer than this is copied, not opened. */
const MAX_URL = 8192;

/** An SSH host name or alias; never one that ssh could read as an option. */
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/**
 * `openLinksOn`: the SSH host of the Mac in front of the user (an alias such as
 * `mac`). A click then opens the link in that Mac's browser, as a click in a
 * local terminal does. Unset (the default), a click copies the link.
 */
export function readOpenLinksOn(file?: string): string | undefined {
	const host = readSection(SECTION, file).openLinksOn;
	return typeof host === "string" && HOST.test(host) ? host : undefined;
}

/**
 * ssh's arguments to run macOS `open` on the host, or undefined for a link that
 * is not http(s) or a host that is not a plain name. ssh joins the remote
 * command into one line for the remote shell, so the link goes as one
 * single-quoted word: a quote, `$()` or `;` in it stays text.
 */
export function macOpenArgs(host: string, url: string): string[] | undefined {
	if (!HOST.test(host)) return undefined;
	// The link as shown must be plain URL text already: the parser drops tabs and newlines
	// and reads `\` as `/`, so a link with them would open somewhere other than it reads.
	if (url.length > MAX_URL || !URL_CHARS.test(url) || !URL.canParse(url)) return undefined;
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
	// The parsed form is ASCII (a host in punycode, the rest percent-encoded); anything else
	// in it is refused, so no space, control character or newline reaches ssh or the shell.
	if (!URL_CHARS.test(parsed.href)) return undefined;
	const quoted = `'${parsed.href.replaceAll("'", "'\\''")}'`;
	// -n -T: no stdin, no terminal; no forwardings from the user's ssh config on each click.
	// `open -u` takes the link as the value of -u, so it is never read as an option or a file.
	return ["-n", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", host, "open", "-u", quoted];
}

/** ssh with no local shell; at most 10 s, and its last error line as the reason. */
export function runSsh(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("ssh", args, { timeout: 10_000, windowsHide: true }, (error, _stdout, stderr) => {
			if (!error) return resolve();
			const line = String(stderr).trim().split("\n").pop();
			reject(new Error(line || error.message));
		});
	});
}

export interface LinkOpenDeps extends LinkCopyDeps {
	/** Runs ssh with these arguments, with no local shell; rejects when it fails. */
	run(args: string[]): Promise<void>;
}

/**
 * A click opens the link on the Mac (`openLinksOn`). A link that is not http(s),
 * or an open that fails, is copied as before, and the notice says why.
 */
export function linkOpener(deps: LinkOpenDeps, host: string): LinkCopier {
	const copier = linkCopier(deps);
	const notify = (message: string, type: "info" | "warning" = "info") => {
		try {
			deps.notify(message, type);
		} catch (error) {
			deps.report(error);
		}
	};
	const copyAfter = (url: string, error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		return Promise.resolve()
			.then(() => deps.copy(url))
			.then(() => notify(`Could not open it on ${host} (${reason}). ${copiedNotice(url)}`),
				(copyError: unknown) => notify(copyFailedNotice(url, copyError), "warning"));
	};
	return {
		openUrl: (url) => {
			const args = macOpenArgs(host, url);
			if (!args) return copier.openUrl(url);
			// The notice names what opened: the parsed link, which is plain ASCII.
			const opened = new URL(url).href;
			return Promise.resolve()
				.then(() => deps.run(args))
				.then(() => notify(`Opened on ${host}: ${opened}`), (error: unknown) => copyAfter(url, error));
		},
	};
}

export function copiedNotice(url: string): string {
	return `Copied link: ${url}`;
}

/** The link comes last and whole, so the user can still select it. */
export function copyFailedNotice(url: string, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Could not copy the link (${reason}): ${url}`;
}

export interface LinkCopyDeps {
	/** Pi's `copyToClipboard`. */
	copy(text: string): Promise<void> | void;
	notify(message: string, type: "info" | "warning"): void;
	/** A notice that could not be shown; the renderer does not wait for the copy, so nothing else would see it. */
	report(error: unknown): void;
}

/** The object is the mark: it is not a function, so it reads back through the Proxy as itself. */
export interface LinkCopier {
	readonly openUrl: (url: string) => Promise<void>;
}

export function linkCopier(deps: LinkCopyDeps): LinkCopier {
	const notify = (message: string, type: "info" | "warning") => {
		try {
			deps.notify(message, type);
		} catch (error) {
			deps.report(error);
		}
	};
	return {
		openUrl: (url) => Promise.resolve()
			.then(() => deps.copy(url))
			.then(() => notify(copiedNotice(url), "info"), (error: unknown) => notify(copyFailedNotice(url, error), "warning")),
	};
}

interface Mark {
	copier: LinkCopier;
	/** The handler the renderer had before any copier, to give back when copying is off. */
	original: unknown;
}

interface Renderer {
	openUrl?: unknown;
	[LINK_COPY_MARK]?: Mark;
}

/**
 * Give the renderer behind `tui` the copier's handler, or with no copier,
 * give back the handler it had. A renderer without a link handler (regular
 * mode, where the terminal opens links) is left alone. Returns whether
 * anything changed. The original is kept from the first copier, so a copier
 * never wraps another.
 */
export function keepLinkCopy(tui: object, copier: LinkCopier | undefined): boolean {
	const renderer = tui as Renderer;
	if (!("openUrl" in renderer)) return false;
	const mark = renderer[LINK_COPY_MARK];
	if (copier === undefined) {
		if (mark === undefined) return false;
		renderer.openUrl = mark.original;
		// A delete through the Proxy reaches its empty target, not the renderer.
		renderer[LINK_COPY_MARK] = undefined;
		return true;
	}
	if (mark?.copier === copier) return false;
	renderer[LINK_COPY_MARK] = { copier, original: mark ? mark.original : renderer.openUrl };
	renderer.openUrl = copier.openUrl;
	return true;
}
