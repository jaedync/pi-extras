/**
 * Finding code blocks and quotes in Pi's rendered Markdown. Pi's Markdown
 * component draws a code block's fences with the theme's `codeBlockBorder`
 * and every quote line with `quoteBorder`, so a wrapped theme can tag those
 * lines with an escape the terminal never sees: `scan` reads the tags back
 * and removes them. `highlightCode` gets each block's exact code, which is
 * what a copy takes.
 */
import type { MarkdownTheme } from "@earendil-works/pi-tui";

/** An OSC nobody answers; `scan` strips it before a line reaches the terminal. */
const TAG = (kind: "o" | "c" | "q", index = "") => `\x1b]7717;${kind}${index}\x07`;
const TAGS = /\x1b\]7717;([ocq])(\d*)\x07/g;

export interface Code {
	readonly code: string;
	readonly lang: string;
}

/** What one render of the tagged theme saw. */
export interface Recorder {
	/** The code of each block, in the order Pi drew them; kept from the last render that drew any. */
	codes: Code[];
	/** Filled during a render; undefined outside one or when Pi reused its cached lines. */
	pending?: Code[];
	open: boolean;
}

export const newRecorder = (): Recorder => ({ codes: [], open: false });

/** Pi's Markdown theme with tagged fences and quote borders, recording each block's code. */
export function taggedTheme(theme: MarkdownTheme, recorder: Recorder): MarkdownTheme {
	const record = () => (recorder.pending ??= []);
	return {
		...theme,
		codeBlockBorder: (text) => {
			// Pi draws the opening fence, the code, then the closing fence, one block at a time.
			const tag = recorder.open ? TAG("c") : TAG("o", String(record().length));
			recorder.open = !recorder.open;
			return tag + theme.codeBlockBorder(text);
		},
		highlightCode: (code, lang) => {
			record().push({ code, lang: lang ?? "" });
			return theme.highlightCode ? theme.highlightCode(code, lang) : code.split("\n").map((line) => theme.codeBlock(line));
		},
		quoteBorder: (text) => TAG("q") + theme.quoteBorder(text),
	};
}

export interface Block {
	readonly kind: "code" | "quote";
	/** First and last rendered row, inclusive. */
	readonly start: number;
	readonly end: number;
	/** The code block's place in Pi's drawing order, or the quote's among quotes. */
	readonly index: number;
	/** A code block whose closing fence is drawn; one still streaming runs to the last row. */
	readonly closed: boolean;
}

/** The lines without tags, and the blocks they marked, in order of their first row. */
export function scan(raw: readonly string[]): { lines: string[]; blocks: Block[] } {
	const lines: string[] = [];
	const blocks: Block[] = [];
	let code: { index: number; start: number } | undefined;
	let quoteStart: number | undefined;
	let quotes = 0;
	raw.forEach((line, row) => {
		const tags: Array<[string, string]> = [];
		lines.push(line.includes("\x1b]7717;") ? line.replace(TAGS, (_, kind: string, index: string) => (tags.push([kind, index]), "")) : line);
		for (const [kind, index] of tags) {
			if (kind === "o" && !code) code = { index: Number(index), start: row };
			else if (kind === "c" && code) {
				blocks.push({ kind: "code", start: code.start, end: row, index: code.index, closed: true });
				code = undefined;
			}
		}
		const quoted = tags.some(([kind]) => kind === "q");
		if (quoted && quoteStart === undefined) quoteStart = row;
		if (!quoted && quoteStart !== undefined) {
			blocks.push({ kind: "quote", start: quoteStart, end: row - 1, index: quotes++, closed: true });
			quoteStart = undefined;
		}
	});
	const last = raw.length - 1;
	if (code) blocks.push({ kind: "code", start: code.start, end: last, index: code.index, closed: false });
	if (quoteStart !== undefined) blocks.push({ kind: "quote", start: quoteStart, end: last, index: quotes, closed: true });
	return { lines, blocks: blocks.sort((a, b) => a.start - b.start || (a.kind === "quote" ? -1 : 1)) };
}
