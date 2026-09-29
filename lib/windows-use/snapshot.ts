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
/** Header lines that say nothing an agent acts on. */
const NOISE = /^(?:Screenshot Backend: |UI Tree: Skipped)/;
/** A tree line: "│   " or "    " per level above it, then "├── " or "└── ". */
const TREE_LINE = /^((?:[│ ] {3})*)[├└]── ([^\n]*)$/;
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

function compactTree(tree: string): string {
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
	// An unnamed window with nothing under it says nothing.
	const kept = out.filter((line, index) => !(line.body === 'window ""' && !((out[index + 1]?.depth ?? -1) > line.depth)));
	return kept.map((line) => line.depth < 0 ? line.body : `${"  ".repeat(line.depth)}${line.body}`).join("\n").replace(/^\n+/, "").trimEnd();
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
 * A window table as one line per window, name, state and size; the depth and
 * handle columns mean nothing to an agent. Columns are read from the dashes
 * under the header, as the table is fixed-width. Anything else is kept.
 */
function windowList(block: readonly string[]): readonly string[] {
	const [title, header, dashes] = block;
	if (!header || !dashes || !/^-+(?: +-+)*$/.test(dashes)) return block;
	const spans = [...dashes.matchAll(/-+/g)].map((match) => [match.index, match.index + match[0].length] as const);
	const columns = spans.map(([from, to]) => header.slice(from, to).trim());
	const at = (row: string, column: string) => {
		const index = columns.indexOf(column);
		return index < 0 ? "" : row.slice(spans[index]![0], spans[index]![1]).trim();
	};
	if (!columns.includes("Name")) return block;
	return [title!, ...rows(block).map((row) => {
		const size = at(row, "Width") && at(row, "Height") ? `, ${at(row, "Width")}x${at(row, "Height")}` : "";
		return `- ${at(row, "Name")} (${at(row, "Status") || "?"}${size})`;
	})];
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
	return `${head ? `${head}\n\n` : ""}${TREE_HEADING}\n${compactTree(text.slice(at + found![0].length))}`;
}
