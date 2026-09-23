// Draw a parsed tmux frame as positioned DOM. Text keeps the real glyphs; the
// cell graphics a font renders unevenly (braille meters, block bars, cursor)
// are drawn as shapes so they sit exactly on the cell grid at any scale.
(() => {
	const BLOCKS = { "█": 1, "▉": 7 / 8, "▊": 3 / 4, "▋": 5 / 8, "▌": 1 / 2, "▍": 3 / 8, "▎": 1 / 4, "▏": 1 / 8, "░": -1 };
	// Braille dot n (bit n) sits at [column, row] of the 2x4 grid.
	const DOTS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
	const SCROLLBAR = new Set(["┃", "│"]);
	const isBraille = (ch) => ch >= "\u2800" && ch <= "\u28ff";

	function el(tag, style, parent) {
		const node = document.createElement(tag);
		Object.assign(node.style, style);
		parent?.appendChild(node);
		return node;
	}

	/**
	 * frame: parsed frame. opt:
	 *   rows [from, to), cols [from, to), cw (cell width px), ch (cell height px)
	 *   color(hex, info) -> css color, or null to hide the run
	 *   bg(hex, info) -> css color or null (null keys the background out)
	 *   ghost: opacity for unlit braille dots in the voice meter (0 = none)
	 *   glow(hex, text) -> css text-shadow / filter color or null
	 *   rowOffset(y) -> extra px added to a row's top (exploded layouts)
	 *   blockHeight: fraction of the cell a block bar fills
	 */
	window.renderTerm = function renderTerm(frame, opt) {
		const [r0, r1] = opt.rows;
		const [c0, c1] = opt.cols ?? [0, frame.cols];
		const { cw, ch } = opt;
		const fontSize = cw / 0.6; // JetBrains Mono advances 600/1000 em
		const color = opt.color ?? ((hex) => hex);
		const offset = opt.rowOffset ?? (() => 0);
		const root = el("div", { position: "absolute", width: `${(c1 - c0) * cw}px`, height: `${(r1 - r0) * ch + offset(r1 - 1)}px` });
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		Object.assign(svg.style, { position: "absolute", left: 0, top: 0, overflow: "visible" });
		svg.setAttribute("width", root.style.width);
		svg.setAttribute("height", root.style.height);

		const shape = (tag, attrs) => {
			const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
			for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
			svg.appendChild(node);
			return node;
		};

		for (let y = r0; y < r1; y++) {
			const row = frame.rows[y];
			if (!row) continue;
			const top = (y - r0) * ch + offset(y);
			for (const bg of row.bgs) {
				const fill = opt.bg?.(bg.bg, { y, x: bg.x, w: bg.w });
				const x0 = Math.max(bg.x, c0), x1 = Math.min(bg.x + bg.w, c1);
				if (!fill || x1 <= x0) continue;
				// A one-cell block cursor reads better as the caret Pi's editor means by it.
				const caret = bg.w === 1 && bg.bg === (opt.cursor ?? "#cfcdc6");
				shape("rect", { x: (x0 - c0) * cw, y: top + (caret ? ch * 0.18 : 0), width: caret ? Math.max(2, cw * 0.16) : (x1 - x0) * cw, height: caret ? ch * 0.64 : ch, fill, rx: opt.bgRadius ?? 0 });
			}
			for (const run of row.runs) {
				const chars = [...run.text];
				const info = { y, x: run.x, text: run.text, bold: run.b, italic: run.i, meter: run.meter };
				if (run.x === frame.cols - 1 && SCROLLBAR.has(run.text) && y < (opt.scrollbarRows ?? r1)) continue;
				const fg = color(run.fg, info);
				if (!fg) continue;
				const glow = opt.glow?.(run.fg, info);
				let text = "", textX = 0;
				const flush = () => {
					if (!text.trim()) { text = ""; return; }
					const span = el("span", {
						position: "absolute", left: `${(textX - c0) * cw}px`, top: `${top}px`, height: `${ch}px`, lineHeight: `${ch}px`,
						fontSize: `${fontSize}px`, color: fg, whiteSpace: "pre",
						fontWeight: run.b ? "700" : "400", fontStyle: run.i ? "italic" : "normal", opacity: run.d ? 0.55 : 1,
						...(glow ? { textShadow: glow } : {}),
					}, root);
					span.textContent = text;
					text = "";
				};
				chars.forEach((c, i) => {
					const x = run.x + i;
					if (x < c0 || x >= c1) { flush(); return; }
					const left = (x - c0) * cw;
					if (isBraille(c)) {
						flush();
						const bits = c.codePointAt(0) - 0x2800;
						const r = cw * (opt.dotRadius ?? 0.14), dx = cw * 0.42, dy = fontSize * 0.21, cy = top + ch / 2 - 1.5 * dy + fontSize * 0.02;
						DOTS.forEach(([col, rowIdx], bit) => {
							const lit = (bits >> bit) & 1;
							if (!lit && !(opt.ghost > 0 && info.meter)) return;
							const dot = shape("circle", { cx: left + cw * 0.29 + col * dx, cy: cy + rowIdx * dy, r, fill: fg, opacity: lit ? 1 : opt.ghost });
							if (lit && glow) dot.setAttribute("filter", "url(#glow)");
						});
					} else if (c in BLOCKS) {
						flush();
						const frac = BLOCKS[c], h = ch * (opt.blockHeight ?? 0.5);
						const rect = { x: left, y: top + (ch - h) / 2, width: cw * Math.abs(frac) + (frac === 1 ? 0.4 : 0), height: h, fill: fg };
						if (frac < 0) rect.opacity = opt.shadeOpacity ?? 0.7;
						shape("rect", rect);
					} else {
						if (!text) textX = x;
						text += c;
					}
				});
				flush();
			}
		}
		const defs = shape("defs", {});
		defs.innerHTML = `<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${cw * 0.18}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
		root.prepend(svg);
		return root;
	};

	/** Mark voice-meter braille cells so ghost dots only show there. */
	window.markMeter = function markMeter(frame, y) {
		for (const run of frame.rows[y].runs) if (isBraille(run.text[0]) && run.x > 8) run.meter = true;
	};
})();
