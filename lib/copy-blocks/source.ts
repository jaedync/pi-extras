/**
 * What a copy takes, read from the Markdown source: Pi's renderer turns tabs
 * into spaces and draws quotes wrapped, so the source is the exact text.
 */

export interface SourceBlock {
	readonly kind: "code" | "quote";
	readonly text: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const QUOTE = /^\s{0,3}>/;

/**
 * Fenced code blocks and top-level quotes, in order. A code block's lines lose
 * its fence's indentation, as Markdown does; a quote's lose one `>` level.
 * An unclosed fence runs to the end, as it does while a reply streams.
 */
export function sourceBlocks(markdown: string): SourceBlock[] {
	const blocks: SourceBlock[] = [];
	const lines = markdown.split("\n");
	for (let row = 0; row < lines.length; row++) {
		const line = lines[row]!;
		const fence = FENCE.exec(line);
		if (fence) {
			const [, indent = "", marker = "```"] = fence;
			const body: string[] = [];
			for (row++; row < lines.length; row++) {
				const next = lines[row]!;
				const close = FENCE.exec(next);
				if (close && close[2]![0] === marker[0] && close[2]!.length >= marker.length && next.trim() === close[2]) break;
				body.push(unindent(next, indent.length));
			}
			blocks.push({ kind: "code", text: body.join("\n") });
		} else if (QUOTE.test(line)) {
			const body: string[] = [];
			for (; row < lines.length && QUOTE.test(lines[row]!); row++) body.push(lines[row]!.replace(/^\s{0,3}> ?/, ""));
			row--;
			blocks.push({ kind: "quote", text: body.join("\n").replace(/\n+$/, "") });
		}
	}
	return blocks;
}

function unindent(line: string, columns: number): string {
	let cut = 0;
	while (cut < columns && line[cut] === " ") cut++;
	return line.slice(cut);
}

/** Pi's renderer expands each tab to three spaces before drawing. */
const expandTabs = (text: string) => text.replace(/\t/g, "   ");

/** The source of a drawn code block: the same text with its tabs, when the source has them. */
export function sourceCode(drawn: string, source: readonly SourceBlock[]): string {
	return source.find((block) => block.kind === "code" && block.text !== drawn && expandTabs(block.text) === drawn)?.text ?? drawn;
}
