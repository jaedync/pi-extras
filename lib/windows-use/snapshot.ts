/**
 * Windows-MCP's snapshot text, made cheaper for an agent to read. The UI tree
 * becomes an indented outline without box-drawing prefixes or the
 * `[action: click]` that nearly every element carries, and the header loses
 * what says nothing on a guest with one desktop and one display. On a
 * 1024×768 dialog this saves about a third. Lines it doesn't recognize pass
 * through, so a changed format degrades to the original text.
 */

const TREE_HEADING = "UI Tree:";
/** The heading on a line of its own; a screenshot says "UI Tree: Skipped for ..." in its header instead. */
const TREE_START = /^[ \t]*UI Tree:[ \t]*$/m;
/** What an agent can do about a window Windows-MCP sees nothing in. */
const OPAQUE = "[no elements: it runs as administrator or draws itself. Read it with win.console.ocr; click and type with win.console.*, since Windows-MCP input doesn't reach it]";
/** Header lines that say nothing an agent acts on. */
const NOISE = /^(?:Screenshot Backend: |UI Tree: Skipped)/;
/** A tree line: "│   " or "    " per level above it, then "├── " or "└── ". */
const TREE_LINE = /^((?:[│ ] {3})*)[├└]── ([^\n]*)$/;
/**
 * Longest tree line kept whole. A document's text is its value, so a large
 * file open in an editor would otherwise ride along in every snapshot.
 */
const MAX_LINE = 2000;
/** Direction marks that UI Automation leaves in dates and names. */
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e]/g;

/**
 * The tree's lines, with a name or value that spans lines (a clock's
 * "6:07 PM\n9/28/2026", a document's text) joined back onto its element with a
 * visible "\\n". A blank line ends an element, so a note after the tree stays apart.
 */
function logicalLines(tree: string): string[] {
	const lines = tree.split(/\r\n|\r|\n/);
	// Every tree line carries the root line's indent; continuations and notes may not.
	const indent = " ".repeat(/^ */.exec(lines.find((line) => line.trim()) ?? "")![0].length);
	const out: string[] = [];
	let open = false;
	for (const raw of lines) {
		const line = (raw.startsWith(indent) ? raw.slice(indent.length) : raw).replace(BIDI_MARKS, "");
		if (TREE_LINE.test(line) || line.trim() === "desktop") { out.push(line); open = true; }
		else if (open && line.trim()) out[out.length - 1] += `\\n${line.trim()}`;
		else { out.push(line); open = false; }
	}
	return out;
}

/** `listed` holds the windows the header names; only those can be told apart from hidden helper windows. */
function compactTree(tree: string, listed: ReadonlySet<string>): string {
	const lines = logicalLines(tree);
	const out: { depth: number; body: string }[] = [];
	let rootSeen = false;
	for (const line of lines) {
		if (!rootSeen && line.trim() === "desktop") { rootSeen = true; continue; }
		const match = TREE_LINE.exec(line);
		if (!match) { out.push({ depth: -1, body: line.trimEnd() }); continue; }
		// Under the dropped "desktop" root, the top-level windows sit at depth 0.
		const depth = match[1]!.length / 4 + (rootSeen ? 0 : 1);
		out.push({ depth, body: match[2]!.replace(/ {2}\[action: click\]/g, "").replace(/ {2}\[/g, " [").trimEnd() });
	}
	const empty = (index: number) => !((out[index + 1]?.depth ?? -1) > out[index]!.depth);
	// An unnamed window with nothing under it says nothing. A listed one, without even
	// its title bar's buttons, is one Windows-MCP may not read: UI Automation hides
	// administrators' windows from a server without those rights, and drops its input to them.
	const opaque = (body: string, index: number) => {
		const name = /^window "(.*)"$/.exec(body)?.[1];
		return name !== undefined && listed.has(name) && empty(index);
	};
	const kept = mergeWords(out
		.filter((line, index) => !(line.body === 'window ""' && empty(index)))
		.map((line, index, lines) => line.depth === 0 && opaque(line.body, index) && !((lines[index + 1]?.depth ?? -1) > 0) ? { ...line, body: `${line.body} ${OPAQUE}` } : line));
	return kept.map((line) => cap(line.depth < 0 ? line.body : `${"  ".repeat(line.depth)}${line.body}`)).join("\n").replace(/^\n+/, "").trimEnd();
}

/** An element UI Automation gives one word of text, as rich text boxes and translated pages do. */
const WORD = /^\((-?\d+),(-?\d+)\) word "(.*)"$/;

/**
 * Runs of word elements side by side, one line each and in no set order, as
 * one text line read top to bottom, left to right, at the first word.
 */
function mergeWords(lines: readonly { depth: number; body: string }[]): { depth: number; body: string }[] {
	const out: { depth: number; body: string }[] = [];
	for (let at = 0; at < lines.length;) {
		let end = at;
		while (end < lines.length && lines[end]!.depth === lines[at]!.depth && WORD.test(lines[end]!.body)) end++;
		if (end - at < 2) { out.push(lines[at]!); at++; continue; }
		const words = lines.slice(at, end).map((line) => WORD.exec(line.body)!).map(([, x, y, word]) => ({ x: Number(x), y: Number(y), word: word! }))
			.sort((a, b) => a.y - b.y || a.x - b.x);
		out.push({ depth: lines[at]!.depth, body: `(${words[0]!.x},${words[0]!.y}) text "${words.map((entry) => entry.word).join(" ")}"` });
		at = end;
	}
	return out;
}

function cap(line: string): string {
	if (line.length <= MAX_LINE) return line;
	return `${line.slice(0, MAX_LINE)}…[${line.length - MAX_LINE} more characters]`;
}

/** Header sections split on blank lines, each with the dedent artifact (4 spaces) removed. */
function sections(head: string): string[][] {
	const blocks: string[][] = [[]];
	for (const raw of head.split("\n")) {
		const line = raw.replace(/^ {4}/, "").trimEnd();
		if (line) blocks.at(-1)!.push(line);
		else if (blocks.at(-1)!.length) blocks.push([]);
	}
	return blocks.filter((block) => block.length > 0);
}

/** A table section's data rows: after its title, column header and dashes. */
const rows = (block: readonly string[]) => block.slice(3);
const WINDOW_SECTIONS = new Set(["Focused Window:", "Opened Windows:"]);

/**
 * A window table's rows by column, or undefined if it isn't one. Columns are
 * read from the dashes under the header, as the table is fixed-width.
 */
function readTable(block: readonly string[]): Record<string, string>[] | undefined {
	const [, header, dashes] = block;
	if (!header || !dashes || !/^-+(?: +-+)*$/.test(dashes)) return undefined;
	const spans = [...dashes.matchAll(/-+/g)].map((match) => [match.index, match.index + match[0].length] as const);
	const columns = spans.map(([from, to]) => header.slice(from, to).trim());
	if (!columns.includes("Name")) return undefined;
	return rows(block).map((row) => Object.fromEntries(columns.map((column, index) => [column, row.slice(spans[index]![0], spans[index]![1]).trim()])));
}

/** A window table as one line per window, name, state and size; the depth and handle columns mean nothing to an agent. */
function windowList(block: readonly string[]): readonly string[] {
	const table = readTable(block);
	if (!table) return block;
	return [block[0]!, ...table.map((row) => `- ${row.Name} (${row.Status || "?"}${row.Width && row.Height ? `, ${row.Width}x${row.Height}` : ""})`)];
}

/** The windows the header's window tables name. */
function listedWindows(head: string): Set<string> {
	return new Set(sections(head).filter((block) => WINDOW_SECTIONS.has(block[0]!)).flatMap((block) => (readTable(block) ?? []).map((row) => row.Name!)));
}

function compactHeader(head: string): string {
	const blocks = sections(head);
	const all = blocks.find((block) => block[0] === "All Desktops:");
	const oneDesktop = all !== undefined && rows(all).length === 1;
	return blocks
		.filter((block) => !(oneDesktop && (block[0] === "Active Desktop:" || block[0] === "All Desktops:")))
		.map((block) => WINDOW_SECTIONS.has(block[0]!) ? windowList(block) : block.filter((line) => !NOISE.test(line) && !(/^Visible Displays: /.test(line) && !line.includes(";"))))
		.filter((block) => block.length > 0)
		.map((block) => block.join("\n"))
		.join("\n\n");
}

export function compactSnapshot(text: string): string {
	const found = TREE_START.exec(text);
	const at = found ? found.index : -1;
	if (at < 0) {
		// Not a snapshot this knows; keep it whole unless it has the header's shape.
		return /Cursor Position: /.test(text) ? compactHeader(text) : text;
	}
	const head = compactHeader(text.slice(0, at));
	const tree = compactTree(text.slice(at + found![0].length), listedWindows(text.slice(0, at)));
	return `${head ? `${head}\n\n` : ""}${TREE_HEADING}\n${tree}`;
}
