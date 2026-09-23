// The preview card: one real staged frame (the edit tool call and its diff,
// running jobs, the phase row, voice mid-dictation and the footer) laid on a
// receding plane under a title band. One typeface, theme colors only, and
// everything that matters inside the centre 4:3 so cropped embeds still read.
(() => {
	const PANEL_BG = "#212823"; // Pi's tool-result panel
	const CURSOR = "#cfcdc6";
	const METER_ROW = 52;
	const WIDGET_ROW = 47; // rows above this carry Pi's scrollbar in the last column

	// Tuned against the 112x56 staged frame; any value can be overridden from the query string while adjusting.
	const LAYOUT = {
		r0: 24, cw: 11.5, ch: 24, left: 250, top: -128, rx: 36, ry: 12, rz: -10, persp: 1400, po: "40% 40%",
		far: "18%", solid: "45%", fadeRight: "20%", tx: 262, ty: 50, size: 58, band: 280, bandSolid: "72%",
	};

	const div = (style, parent, html) => {
		const node = document.createElement("div");
		Object.assign(node.style, style);
		if (html !== undefined) node.innerHTML = html;
		parent.appendChild(node);
		return node;
	};
	const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})`;

	/** Fine monochrome noise, so the gradients do not band. */
	function grain(stage, opacity) {
		const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1.4 -.2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
		div({ position: "absolute", inset: 0, backgroundImage: `url("data:image/svg+xml;utf8,${svg}")`, opacity, mixBlendMode: "overlay" }, stage);
	}

	window.drawHero = (stage) => {
		const frame = window.FRAME;
		window.markMeter(frame, METER_ROW);
		const P = Object.assign({}, LAYOUT, Object.fromEntries(new URLSearchParams(location.search)));
		const cw = +P.cw, ch = +P.ch, rows = [+P.r0, frame.rows.length];
		stage.style.background = [
			"radial-gradient(760px 420px at 58% 78%, rgba(178,148,176,.16), transparent 70%)",
			"radial-gradient(520px 260px at 42% 70%, rgba(236,182,78,.07), transparent 70%)",
			"#0b0c0f",
		].join(",");

		const scene = div({ position: "absolute", inset: 0, perspective: `${P.persp}px`, perspectiveOrigin: P.po }, stage);
		const plane = div({
			position: "absolute", left: `${P.left}px`, top: `${P.top}px`, width: `${frame.cols * cw}px`, height: `${(rows[1] - rows[0]) * ch}px`,
			transform: `rotateY(${P.ry}deg) rotateX(${P.rx}deg) rotateZ(${P.rz}deg)`, transformOrigin: "0 100%",
			webkitMaskImage: `linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.45) ${P.far}, #000 ${P.solid}), linear-gradient(to left, transparent 0%, #000 ${P.fadeRight})`,
			webkitMaskComposite: "source-in",
		}, scene);
		const meterGlow = (hex, info) => (info.meter || info.text === "●") ? `0 0 10px ${rgba(hex, 0.75)}` : null;
		plane.appendChild(window.renderTerm(frame, {
			rows, cw, ch, ghost: 0.14, blockHeight: 0.46, scrollbarRows: WIDGET_ROW,
			glow: (hex, info) => meterGlow(hex, info) ?? `0 0 10px ${rgba(hex, 0.25)}`,
			bg: (hex) => hex === PANEL_BG ? rgba("#26302b", 0.6) : hex === CURSOR ? CURSOR : rgba(hex, 0.9),
		}));

		// A quiet band for the title: the plane's far rows fade under it instead of fighting it.
		div({ position: "absolute", left: 0, right: 0, top: 0, height: `${P.band}px`,
			background: `linear-gradient(to bottom, #0b0c0f 0%, rgba(11,12,15,.94) ${P.bandSolid}, rgba(11,12,15,0) 100%)` }, stage);
		const size = +P.size;
		const block = div({ position: "absolute", left: `${P.tx}px`, top: `${P.ty}px` }, stage);
		div({ fontSize: `${size}px`, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em", color: "#ece8df" }, block,
			`pi<span style="color:#8fb4c8">-extras</span>`);
		div({ marginTop: `${Math.round(size * 0.36)}px`, fontSize: `${Math.round(size * 0.42)}px`, color: "#8a8882", letterSpacing: "-0.01em" }, block,
			"status, limits, background jobs and voice for Pi");
		grain(stage, 0.06);
	};
})();
