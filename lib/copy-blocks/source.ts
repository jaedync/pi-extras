/**
 * What a copy takes, read from the Markdown source: Pi's renderer turns tabs
 * into spaces and draws quotes wrapped, so the source is the exact text.
 */
import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";

export interface SourceBlock {
	readonly kind: "code" | "quote";
	readonly text: string;
}

/** The lexer Pi's Markdown component uses; pi-tui exports the class, not its configured instance. */
const lexer = new Marked();
/** Pi's renderer expands each tab to three spaces before it lexes, so the block bounds are the ones that text has. */
const TAB = "   ";

type Node = Token & { readonly tokens?: readonly Token[]; readonly items?: readonly Token[] };

/**
 * The source lines, the same lines with tabs expanded, and the lines a
 * block's search may use: from the next unread line to the end of the lines
 * its token covers.
 */
interface Reader {
	readonly source: readonly string[];
	readonly expanded: readonly string[];
	from: number;
	to: number;
}

/**
 * Code blocks (fenced and indented) and quotes, in the order Pi draws their
 * cards: a code block inside a quote follows its quote. Blocks are found in
 * the text Pi lexes, with tabs expanded, then read back from the source line
 * by line, so a copy keeps its tabs. A quote's lines lose one `>` level. An
 * unclosed fence runs to the end, as it does while a reply streams.
 */
export function sourceBlocks(markdown: string): SourceBlock[] {
	const source = markdown.split(/\r?\n/);
	const reader: Reader = { source, expanded: source.map(expandTabs), from: 0, to: source.length };
	const tokens = lexer.lexer(expandTabs(markdown));
	return collect(tokens, reader, false, tokens.at(-1), 0);
}

/**
 * The blocks in `tokens`. When `base` is known, the tokens' raw text joins to
 * the lines from `base` on, one to one (expanding tabs keeps every line
 * break), so each token's search stays within its own lines; prose that reads
 * like a later block's code cannot be taken for it.
 */
function collect(tokens: readonly Token[], reader: Reader, quoted: boolean, last: Token | undefined, base?: number): SourceBlock[] {
	let line = base;
	return tokens.flatMap((token): SourceBlock[] => {
		const node = token as Node;
		const start = line;
		if (line !== undefined) {
			const breaks = token.raw.split("\n").length - 1;
			reader.from = Math.max(reader.from, line);
			reader.to = line + breaks + (token.raw.endsWith("\n") ? 0 : 1);
			line += breaks;
		}
		const lastHere = token === last;
		if (node.type === "code") return [{ kind: "code", text: codeSource(node as Tokens.Code, reader, quoted, lastHere) }];
		if (node.type === "blockquote") return quoteBlocks(node, reader, quoted, lastHere);
		const inner = node.items ?? node.tokens ?? [];
		// A list's items, and an item's blocks, keep the line count of the list's own lines.
		const known = node.type === "list" || node.type === "list_item" ? start : undefined;
		return collect(inner, reader, quoted, lastHere ? lastOf(node) : undefined, known);
	});
}

/** Pi trims a partial closing fence only in the last block, looking into a last list item or quote. */
function lastOf(node: Node): Token | undefined {
	if (node.type === "list") return node.items?.at(-1);
	return node.type === "list_item" || node.type === "blockquote" ? node.tokens?.at(-1) : undefined;
}

/** Pi draws every quote line with one border, so a quote inside a quote is part of it; its code blocks are cards. */
function quoteBlocks(node: Node, reader: Reader, quoted: boolean, lastHere: boolean): SourceBlock[] {
	const raw = node.raw.replace(/\n+$/, "").split("\n");
	const at = findLines(reader, raw, quoted);
	const lines = at ? at.lines : raw;
	const quote: SourceBlock[] = quoted ? [] : [{ kind: "quote", text: lines.map((line) => line.replace(/^\s{0,3}> ?/, "")).join("\n") }];
	// The quote's own code blocks lie within its lines, which keep their count without the `>`.
	if (at) reader.from = at.start;
	const inner = collect(node.tokens ?? [], reader, true, lastHere ? lastOf(node) : undefined, at?.start);
	if (at) reader.from = Math.max(reader.from, at.end);
	return [...quote, ...inner];
}

function codeSource(token: Tokens.Code, reader: Reader, quoted: boolean, lastHere: boolean): string {
	const drawn = lastHere ? trimPartialFence(token) : token.text;
	if (drawn === "") return drawn;
	// Indented code can end with new lines that its token's line window does not cover.
	const body = drawn.replace(/\n+$/, "");
	const at = findLines(reader, body.split("\n"), quoted);
	if (!at) return drawn;
	reader.from = at.end;
	return at.lines.join("\n") + drawn.slice(body.length);
}

/** A last line that is only part of the closing fence, still streaming in, is not code. */
function trimPartialFence(token: Tokens.Code): string {
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const last = token.raw.split("\n").pop() ?? "";
	const partial = !!marker && last.length > 0 && last.length < marker.length && last === marker[0]!.repeat(last.length);
	return partial ? token.text.slice(0, -last.length).replace(/\n$/, "") : token.text;
}

/**
 * The first run of source lines, from the reader's place on, whose expanded
 * form ends with `drawn`, after only indentation (and `>` inside a quote).
 * Each line loses that many leading columns, a tab counting three.
 */
function findLines(reader: Reader, drawn: readonly string[], quoted: boolean): { lines: string[]; start: number; end: number } | undefined {
	const lead = quoted ? /^[ >]*$/ : /^ *$/;
	const fits = (row: number, index: number) => {
		const line = reader.expanded[row]!;
		const want = drawn[index]!;
		return line.endsWith(want) && lead.test(line.slice(0, line.length - want.length));
	};
	for (let start = reader.from; start + drawn.length <= Math.min(reader.to, reader.source.length); start++) {
		if (!drawn.every((_, index) => fits(start + index, index))) continue;
		const lines = drawn.map((want, index) => cutColumns(reader.source[start + index]!, reader.expanded[start + index]!.length - want.length));
		return { lines, start, end: start + drawn.length };
	}
	return undefined;
}

/** `line` without its first `columns` columns; a tab cut part way leaves its other columns as spaces. */
function cutColumns(line: string, columns: number): string {
	let column = 0;
	for (let index = 0; index < line.length; index++) {
		if (column >= columns) return line.slice(index);
		const width = line[index] === "\t" ? TAB.length : 1;
		if (column + width > columns) return " ".repeat(column + width - columns) + line.slice(index + 1);
		column += width;
	}
	return "";
}

const expandTabs = (text: string) => text.replace(/\t/g, TAB);

/**
 * The source of the `index`th code card Pi drew: the block found at that place
 * when it reads the same as the card, else the first block that does, else the
 * drawn text.
 */
export function sourceCode(drawn: string, source: readonly SourceBlock[], index?: number): string {
	const codes = source.filter((block) => block.kind === "code");
	const placed = index === undefined ? undefined : codes[index];
	if (placed && expandTabs(placed.text) === drawn) return placed.text;
	return codes.find((block) => expandTabs(block.text) === drawn)?.text ?? drawn;
}
