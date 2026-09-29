import assert from "node:assert/strict";
import test from "node:test";
import { ocrItems, readOcr } from "../lib/windows-use/ocr.ts";

const word = (text: string, x: number, y: number, w: number, h: number) => ({ text, x, y, w, h });

/** Word boxes as Windows OCR reports them for a window's title, menu bar, a tree item and a clock. */
const LINES = [
	{ words: [word("Help", 122, 16, 24, 12)] },
	{ words: [word("File", 62, 181, 17, 9), word("Action", 95, 181, 34, 9), word("View", 146, 181, 25, 9), word("Help", 188, 181, 24, 12)] },
	{ words: [word("OCMC", 81, 155, 34, 9), word("-", 120, 160, 3, 1), word("[Operations", 128, 155, 61, 12), word("Console]", 235, 155, 46, 11)] },
	{ words: [word("Galaxy", 97, 269, 33, 12), word("Database", 134, 269, 47, 9), word("Manager", 185, 269, 46, 12)] },
	{ words: [word("8:00", 964, 732, 22, 8), word("PM", 990, 732, 16, 8)] },
	{ words: [word("Search", 237, 739, 39, 10)] },
];

test("OCR lines become clickable items: split where words sit far apart, centered, in reading order", () => {
	const items = ocrItems(LINES);
	assert.deepEqual(items.map((item) => `(${item.x},${item.y}) ${item.text}`), [
		"(134,22) Help",
		"(135,161) OCMC - [Operations",
		"(258,161) Console]",
		"(71,186) File",
		"(112,186) Action",
		"(159,186) View",
		"(200,187) Help",
		"(164,275) Galaxy Database Manager",
		"(985,736) 8:00 PM",
		"(257,744) Search",
	]);
});

test("a region keeps only the items centered inside it", () => {
	const items = ocrItems(LINES, { x: 50, y: 170, width: 200, height: 120 });
	assert.deepEqual(items.map((item) => item.text), ["File", "Action", "View", "Help", "Galaxy Database Manager"]);
});

test("the host's OCR answer is checked before use", () => {
	assert.deepEqual(readOcr({ width: 10, height: 10, lines: [{ words: [{ text: "a", x: 1, y: 2, w: 3, h: 4 }] }] }).lines[0]!.words[0], word("a", 1, 2, 3, 4));
	assert.deepEqual(readOcr({ width: 10, height: 10, lines: [] }).lines, []);
	assert.throws(() => readOcr({ lines: "x" }), /malformed OCR/);
	assert.throws(() => readOcr({ width: 1, height: 1, lines: [{ words: [{ text: 5 }] }] }), /malformed OCR/);
});
