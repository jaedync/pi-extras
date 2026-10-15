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
