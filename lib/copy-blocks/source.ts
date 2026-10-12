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

type Node = Token & { readonly tokens?: readonly Token[]; readonly items?: readonly Token[] };

/**
 * Fenced and indented code blocks, and quotes, in the order Pi draws them,
 * found by the same lexer, so block numbers match the cards. A quote's lines
 * lose one `>` level, and the blocks inside a quote stay part of it. An
 * unclosed fence runs to the end, as it does while a reply streams.
 */
export function sourceBlocks(markdown: string): SourceBlock[] {
	const own = collect(lexer.lexer(markdown));
	if (!markdown.includes("\t")) return own;
	// Pi lexes the text with its tabs expanded, and a tab in an indent can change a block's bounds. Keep the
	// tabs only where both readings agree; else take the blocks Pi drew.
	const drawn = collect(lexer.lexer(expandTabs(markdown)));
	const same = own.length === drawn.length && own.every((block, index) => block.kind === drawn[index]!.kind && expandTabs(block.text) === drawn[index]!.text);
	return same ? own : drawn;
}

function collect(tokens: readonly Token[]): SourceBlock[] {
	return tokens.flatMap((token): SourceBlock[] => {
		const node = token as Node;
		if (node.type === "code") return [{ kind: "code", text: codeText(node as Tokens.Code) }];
		if (node.type === "blockquote") return [{ kind: "quote", text: quoteText(node.raw) }];
		return [...collect(node.items ?? []), ...collect(node.tokens ?? [])];
	});
}

/** A fence's last line that is only part of its closing fence, still streaming in, is not code; Pi trims it too. */
function codeText(token: Tokens.Code): string {
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const last = token.raw.split("\n").pop() ?? "";
	const partial = !!marker && last.length > 0 && last.length < marker.length && last === marker[0]!.repeat(last.length);
	return partial ? token.text.slice(0, -last.length).replace(/\n$/, "") : token.text;
}

const quoteText = (raw: string) => raw.split("\n").map((line) => line.replace(/^\s{0,3}> ?/, "")).join("\n").replace(/\n+$/, "");

/** Pi's renderer expands each tab to three spaces before drawing. */
const expandTabs = (text: string) => text.replace(/\t/g, "   ");

/** The source of a drawn code block: the same text with its tabs, when the source has them. */
export function sourceCode(drawn: string, source: readonly SourceBlock[]): string {
	return source.find((block) => block.kind === "code" && block.text !== drawn && expandTabs(block.text) === drawn)?.text ?? drawn;
}
