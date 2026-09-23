// Parse a `tmux capture-pane -e -p` frame into rows of styled text runs and
// background runs, which term.js draws.
const PALETTE_16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
	"#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
const hex = (r, g, b) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
function color256(n) {
	if (n < 16) return PALETTE_16[n];
	if (n >= 232) { const v = 8 + (n - 232) * 10; return hex(v, v, v); }
	const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
	return hex(steps[Math.floor(i / 36)], steps[Math.floor(i / 6) % 6], steps[i % 6]);
}

function applySgr(style, params) {
	const p = params.length ? params : [0];
	for (let i = 0; i < p.length; i++) {
		const code = p[i];
		if (code === 0) Object.assign(style, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false });
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 7) style.inverse = true;
		else if (code === 9) style.strike = true;
		else if (code === 22) { style.bold = false; style.dim = false; }
		else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code === 27) style.inverse = false;
		else if (code === 29) style.strike = false;
		else if (code >= 30 && code <= 37) style.fg = PALETTE_16[code - 30];
		else if (code >= 90 && code <= 97) style.fg = PALETTE_16[code - 82];
		else if (code >= 40 && code <= 47) style.bg = PALETTE_16[code - 40];
		else if (code >= 100 && code <= 107) style.bg = PALETTE_16[code - 92];
		else if (code === 39) style.fg = null;
		else if (code === 49) style.bg = null;
		else if (code === 38 || code === 48) {
			const key = code === 38 ? "fg" : "bg";
			if (p[i + 1] === 2) { style[key] = hex(p[i + 2], p[i + 3], p[i + 4]); i += 4; }
			else if (p[i + 1] === 5) { style[key] = color256(p[i + 2]); i += 2; }
		}
	}
}

/** The frame as { cols, rows: [{ runs, bgs }] }; colours are resolved to hex. */
export function parseFrame(text, defaultFg = "#cfcdc6") {
	const rows = text.replace(/\n$/, "").split("\n").map((line) => {
		const style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
		const cells = [];
		// tmux resets styles at each line start, so every row parses independently.
		const pattern = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^\[\]]|([^\x1b])/gu;
		for (const match of line.matchAll(pattern)) {
			if (match[1] !== undefined) applySgr(style, match[1].split(/[;:]/).filter((v) => v !== "").map(Number));
			else if (match[2] !== undefined) {
				let fg = style.fg ?? defaultFg, bg = style.bg;
				if (style.inverse) [fg, bg] = [bg ?? "#101014", fg];
				cells.push({ ch: match[2], fg, bg, b: style.bold, d: style.dim, i: style.italic, u: style.underline, s: style.strike });
			}
		}
		return cells;
	});

	const key = (c) => [c.fg, c.b, c.d, c.i, c.u, c.s].join("|");
	return {
		cols: Math.max(...rows.map((r) => r.length)),
		rows: rows.map((cells) => {
			const runs = [], bgs = [];
			cells.forEach((c, x) => {
				const last = runs.at(-1);
				if (last && last.key === key(c) && last.x + [...last.text].length === x) last.text += c.ch;
				else runs.push({ key: key(c), x, text: c.ch, fg: c.fg, b: c.b, d: c.d, i: c.i, u: c.u, s: c.s });
				const lastBg = bgs.at(-1);
				if (c.bg && lastBg && lastBg.bg === c.bg && lastBg.x + lastBg.w === x) lastBg.w++;
				else if (c.bg) bgs.push({ x, w: 1, bg: c.bg });
			});
			return { runs: runs.filter((r) => r.text.trim()).map(({ key: _, ...r }) => r), bgs };
		}),
	};
}
