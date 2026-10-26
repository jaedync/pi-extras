/** Text shapes shared by the pull_link tool and auto-pull: pages, the untrusted wrapper and safe row text. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { cutIndex } from "./text.ts";

export const TOOL_NAME = "pull_link";
export const PAGE_CHARS = 40_000;

export interface Page {
	readonly text: string;
	readonly next?: number;
}

/** A page of `text` from `offset`, cut at a paragraph or line break near the limit. */
export function page(text: string, offset: number, limit = PAGE_CHARS): Page {
	if (offset >= text.length && offset > 0) return { text: `(offset ${offset} is past the end; the result has ${text.length} characters)` };
	const end = offset + limit;
	if (end >= text.length) return { text: text.slice(offset) };
	const window = text.slice(offset, end);
	const paragraph = window.lastIndexOf("\n\n");
	const line = window.lastIndexOf("\n");
	const cut = paragraph > limit * 0.6 ? paragraph : line > limit * 0.6 ? line : -1;
	const stop = cut > 0 ? offset + cut : cutIndex(text, end);
	return { text: text.slice(offset, stop), next: stop };
}

/** Breaks any `<untrusted-content` tag in third-party text, so the text cannot close or open a wrapper. */
export function defang(text: string): string {
	return text.replace(/<\/?untrusted-content/gi, (tag) => tag.replace("<", "&lt;"));
}

/** Third-party text in its wrapper; the source attribute cannot break out of its quotes. */
export function untrusted(url: string, text: string): string {
	const source = url.replace(/[\s"<>\x00-\x1f\x7f]/g, encodeURIComponent);
	return `<untrusted-content source="${source}">\n${defang(text)}\n</untrusted-content>`;
}

export function safe(theme: Theme, key: Parameters<Theme["fg"]>[0], text: string): string {
	try {
		return theme.fg(key, text);
	} catch {
		return text;
	}
}

/** Text from links and pages goes on one row with no terminal escapes: titles come from untrusted sites. */
export function clean(value: unknown, max = 160): string {
	const text = String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, cutIndex(text, max - 1))}…` : text;
}

/** The note under a preview: where the whole result is and how to read the rest. */
export function savedNote(chars: number, path: string, call: string): string {
	return `[Preview: the full result has ${chars.toLocaleString("en-US")} characters and is saved at ${path}. Read or search that file for the rest, or ${call} and offset=0 to page through it.]`;
}
