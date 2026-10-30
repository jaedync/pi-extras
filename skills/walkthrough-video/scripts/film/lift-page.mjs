/**
 * The page side of wv lift: one function that page.evaluate runs in the live
 * app. It must not use anything from this module's scope. It returns raw
 * facts only; tokens.mjs gives them roles.
 */
export function collectPageFacts() {
	const W = innerWidth;
	const H = innerHeight;
	// A tint under half opacity (a glass chip, a hover wash) is not a ground: the colour behind it is.
	const transparent = (c) => {
		if (!c || c === "transparent") return true;
		const m = c.match(/rgba\([^)]*[,/]\s*([\d.]+)\)$/);
		return Boolean(m) && parseFloat(m[1]) < 0.5;
	};
	const selectorOf = (el) => {
		if (!el || !el.tagName) return "";
		const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
		return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
	};
	/** The first ancestor (or the element) that paints an opaque background. */
	const groundOf = (el) => {
		for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
			const s = getComputedStyle(e);
			if (!transparent(s.backgroundColor)) {
				// A texture often sits on a pseudo-element (a dot grid on ::before).
				const pseudo = [s.backgroundImage, getComputedStyle(e, "::before").backgroundImage, getComputedStyle(e, "::after").backgroundImage];
				return { el: e, color: s.backgroundColor, image: pseudo.filter((x) => x && x !== "none").join(", ") || "none" };
			}
		}
		const root = getComputedStyle(document.documentElement).backgroundColor;
		const body = document.body ? getComputedStyle(document.body).backgroundColor : "";
		return { el: document.body, color: transparent(body) ? (transparent(root) ? "rgb(255, 255, 255)" : root) : body, image: "none" };
	};

	// Grounds: a grid of points, each counted once for the colour that paints it.
	const grounds = new Map();
	const COLS = 48;
	const ROWS = 27;
	for (let i = 0; i < COLS; i++)
		for (let j = 0; j < ROWS; j++) {
			const el = document.elementFromPoint(((i + 0.5) * W) / COLS, ((j + 0.5) * H) / ROWS);
			const g = groundOf(el);
			const key = `${g.color}|${selectorOf(g.el)}`;
			const row = grounds.get(key) ?? { color: g.color, selector: selectorOf(g.el), image: g.image, share: 0 };
			row.share += 1 / (COLS * ROWS);
			grounds.set(key, row);
		}

	// Text: every visible text node, with its font, its colour and the ground behind it.
	const texts = [];
	const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent.replace(/\s+/g, "");
		if (!text) continue;
		const el = node.parentElement;
		if (!el || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
		const s = getComputedStyle(el);
		texts.push({
			color: s.color,
			family: s.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""),
			weight: Number(s.fontWeight) || 400,
			size: parseFloat(s.fontSize) || 16,
			variation: s.fontVariationSettings,
			chars: text.length,
			ground: groundOf(el).color,
			selector: selectorOf(el),
		});
	}

	// Stylesheets: custom properties, easings, keyframes, literal colours, font faces.
	const vars = new Map();
	const easings = [];
	const keyframes = [];
	const literals = [];
	const fontFaces = [];
	const skipped = [];
	const css = [];
	const EASE = /cubic-bezier\([^)]*\)|steps\([^)]*\)|\b(?:ease-in-out|ease-in|ease-out|linear)\b/g;
	const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/;
	const walk = (rules, sheetHref) => {
		for (const rule of rules) {
			if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) walk(rule.cssRules, sheetHref);
			if (rule instanceof CSSKeyframesRule) {
				keyframes.push({ name: rule.name, css: rule.cssText });
				for (const m of rule.cssText.match(/cubic-bezier\([^)]*\)/g) ?? []) easings.push({ value: m, selector: `@keyframes ${rule.name}`, prop: "animation-timing-function" });
				continue;
			}
			if (rule instanceof CSSFontFaceRule) {
				const src = rule.style.getPropertyValue("src");
				const url = src.match(/url\(["']?([^"')]+)["']?\)/);
				fontFaces.push({
					family: rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, ""),
					src: url ? new URL(url[1], sheetHref || location.href).href : null,
					weight: rule.style.getPropertyValue("font-weight") || "normal",
					style: rule.style.getPropertyValue("font-style") || "normal",
				});
				continue;
			}
			if (!(rule instanceof CSSStyleRule)) continue;
			const style = rule.style;
			for (let k = 0; k < style.length; k++) {
				const prop = style[k];
				const value = style.getPropertyValue(prop).trim();
				if (prop.startsWith("--")) {
					if (/^(:root|html|body)$/.test(rule.selectorText.trim()) && !vars.has(prop)) vars.set(prop, { name: prop, value, selector: rule.selectorText });
					continue;
				}
				if (/^(transition|animation)/.test(prop)) for (const m of value.match(EASE) ?? []) if (m.startsWith("cubic") || m.startsWith("steps") || prop.endsWith("timing-function")) easings.push({ value: m, selector: rule.selectorText, prop });
				if (/color|background|border|fill|stroke|shadow/.test(prop) && COLOR.test(value) && literals.length < 400) literals.push({ selector: rule.selectorText, prop, value: value.match(COLOR)[0] });
			}
		}
	};
	for (const sheet of document.styleSheets) {
		try {
			walk(sheet.cssRules, sheet.href);
			css.push({ href: sheet.href, text: [...sheet.cssRules].map((r) => r.cssText).join("\n") });
		} catch {
			skipped.push(sheet.href);
		}
	}
	const rootStyle = getComputedStyle(document.documentElement);
	for (const v of vars.values()) v.computed = rootStyle.getPropertyValue(v.name).trim() || v.value;

	return {
		url: location.href,
		title: document.title,
		viewport: { width: W, height: H },
		vars: [...vars.values()],
		grounds: [...grounds.values()],
		texts,
		fontFaces,
		easings,
		keyframes,
		literals,
		css,
		skippedSheets: skipped,
	};
}
