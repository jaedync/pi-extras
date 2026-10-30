/**
 * The in-page collector. `collectFacts` runs inside the browser through
 * page.evaluate, so it must not use imports or names from this module: the
 * page receives only its source text. It reads computed styles and layout and
 * returns plain data; every judgment happens in the rules, in Node, so the
 * rules can be tested without a browser.
 */

/* eslint-disable no-undef -- runs in the page */
export function collectFacts(options) {
	const maxElements = options?.maxElements ?? 5000;
	const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "META", "LINK", "NOSCRIPT", "TEMPLATE", "TITLE", "BR", "WBR"]);
	const COLOR_RE = /(?:rgba?|hsla?|hwb|color|oklch|oklab|lab|lch)\([^()]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi;
	// createElementNS: in an SVG or XML document, createElement("canvas") is not an HTML canvas.
	const canvas = /** @type {HTMLCanvasElement} */ (document.createElementNS("http://www.w3.org/1999/xhtml", "canvas"));
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const colorCache = new Map();

	/** Any CSS color as [r, g, b, a]; rgb() is parsed directly, other spaces go through a canvas. */
	function rgba(css) {
		if (!css) return [0, 0, 0, 0];
		const cached = colorCache.get(css);
		if (cached) return cached;
		let out;
		const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(css.trim());
		if (m) {
			const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
			out = [+m[1], +m[2], +m[3], a];
		} else if (/^transparent$/i.test(css.trim())) {
			out = [0, 0, 0, 0];
		} else {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = "#000";
			ctx.fillStyle = css;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			out = [d[0], d[1], d[2], d[3] / 255];
		}
		colorCache.set(css, out);
		return out;
	}

	/** Splits a CSS list at top-level commas. */
	function layers(value) {
		const out = [];
		let depth = 0;
		let start = 0;
		for (let i = 0; i < value.length; i++) {
			if (value[i] === "(") depth++;
			else if (value[i] === ")") depth--;
			else if (value[i] === "," && depth === 0) {
				out.push(value.slice(start, i).trim());
				start = i + 1;
			}
		}
		out.push(value.slice(start).trim());
		return out.filter(Boolean);
	}

	function gradients(value) {
		if (!value || value === "none") return [];
		return layers(value).map((layer) => {
			const kind = /^url\(/.test(layer) ? "image" : (/(linear|radial|conic)-gradient/.exec(layer)?.[1] ?? "other");
			return { kind, stops: (layer.match(COLOR_RE) ?? []).map(rgba) };
		});
	}

	/** box-shadow, text-shadow or the inside of drop-shadow(): color, x, y, blur, spread, inset. */
	function shadows(value) {
		if (!value || value === "none") return [];
		return layers(value).map((layer) => {
			const color = layer.match(COLOR_RE)?.[0] ?? "currentcolor";
			const rest = layer.replace(COLOR_RE, " ");
			const lengths = (rest.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
			return { color: rgba(color), x: lengths[0] ?? 0, y: lengths[1] ?? 0, blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, inset: /\binset\b/.test(rest) };
		});
	}

	function filterFacts(value) {
		if (!value || value === "none") return null;
		const drops = [...value.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => shadows(m[1])[0]).filter(Boolean);
		const blur = /blur\(([\d.]+)px\)/.exec(value);
		return { drops, blur: blur ? parseFloat(blur[1]) : 0 };
	}

	const px = (v) => (v === "normal" || v === "auto" || v === "" ? 0 : parseFloat(v) || 0);
	const listOf = (v) => v.split(",").map((s) => s.trim());
	/** The parent element, crossing from a shadow root to its host. */
	const parentOf = (node) => node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
	const seconds = (v) => (v.endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v) || 0);

	function radius(value, w, h) {
		const first = String(value).split(" ")[0];
		const r = first.endsWith("%") ? (parseFloat(first) / 100) * Math.min(w, h) : parseFloat(first) || 0;
		return Math.round(Math.min(r, Math.min(w, h) / 2) * 10) / 10;
	}

	function selectorOf(el) {
		const parts = [];
		for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = parentOf(node)) {
			let part = node.tagName.toLowerCase();
			if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
				parts.unshift(`${part}#${node.id}`);
				break;
			}
			const classes = [...node.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length <= 24).slice(0, 2);
			if (classes.length) part += `.${classes.join(".")}`;
			parts.unshift(part);
			if (node.tagName === "BODY") break;
		}
		return parts.join(" > ");
	}

	/** The element's own text, with control characters removed: it goes to a terminal and to an agent. */
	function ownText(el) {
		let text = "";
		for (const child of el.childNodes) if (child.nodeType === 3) text += child.textContent;
		// eslint-disable-next-line no-control-regex
		return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
	}

	const INTERACTIVE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [tabindex]:not([tabindex='-1'])";
	const index = new Map();
	const bgMemo = new Map();
	const facts = [];
	const sx = window.scrollX;
	const sy = window.scrollY;

	const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);

	/**
	 * The color behind an element's text from its own and its ancestors'
	 * backgrounds. Over a gradient, `stops` holds each stop on its base so the
	 * contrast rule can test the worst one; over an image, `unknown` is true.
	 * Positioned layers from elsewhere in the tree are not seen.
	 */
	function background(el) {
		if (!el || el.nodeType !== 1) return { color: [255, 255, 255, 1], unknown: false, stops: null };
		if (bgMemo.has(el)) return bgMemo.get(el);
		const style = getComputedStyle(el);
		const own = rgba(style.backgroundColor);
		const parent = background(parentOf(el));
		const opaque = own[3] >= 0.99;
		const base = opaque ? own : over(own, parent.color);
		const image = style.backgroundImage;
		let out;
		if (image === "none") out = { color: base, unknown: !opaque && parent.unknown, stops: opaque ? null : (parent.stops?.map((s) => over(own, s)) ?? null) };
		else if (/url\(/.test(image)) out = { color: base, unknown: true, stops: null };
		else {
			const stops = (image.match(COLOR_RE) ?? []).map(rgba).map((s) => over(s, base)).slice(0, 8);
			const color = stops.length ? [0, 1, 2].map((i) => stops.reduce((sum, s) => sum + s[i], 0) / stops.length).concat(1) : base;
			out = { color, unknown: false, stops: stops.length ? stops : null };
		}
		bgMemo.set(el, out);
		return out;
	}

	const animationOf = (style) => ({ names: listOf(style.animationName), iterations: listOf(style.animationIterationCount), durations: listOf(style.animationDuration).map(seconds) });

	function pseudo(el, which, rect, parentIndex, live) {
		const style = getComputedStyle(el, which);
		if (!style.content || style.content === "none" || style.content === "normal") return;
		const bgImage = gradients(style.backgroundImage);
		const boxShadow = shadows(style.boxShadow);
		const filter = filterFacts(style.filter);
		const animation = animationOf(style);
		if (!bgImage.length && !boxShadow.length && !filter && animation.names.every((n) => n === "none")) return;
		facts.push({ i: facts.length, sel: `${selectorOf(el)}${which}`, tag: which, parent: parentIndex, pseudo: true, live, text: "", rect, bg: rgba(style.backgroundColor), bgImage, boxShadow, textShadow: [], filter, animation, clipText: false, opacity: parseFloat(style.opacity) });
	}

	const opacityMemo = new Map();
	/** The opacity the element is drawn with: its own times its ancestors'. */
	function drawnOpacity(el) {
		if (!el || el.nodeType !== 1) return 1;
		if (opacityMemo.has(el)) return opacityMemo.get(el);
		const value = (parseFloat(getComputedStyle(el).opacity) || 0) * drawnOpacity(parentOf(el));
		opacityMemo.set(el, value);
		return value;
	}

	const clipMemo = new Map();
	const clips = (style) => /hidden|clip|auto|scroll/.test(`${style.overflowX} ${style.overflowY}`);
	const rootStyle = getComputedStyle(document.documentElement);
	// When <html> has overflow visible, the body's overflow applies to the viewport, so the body clips nothing.
	const bodyClips = !/^visible$/.test(rootStyle.overflowX) || !/^visible$/.test(rootStyle.overflowY);

	/** The area in which the descendants of `node` can be seen: its clipping ancestors' boxes, intersected. */
	function clipArea(node) {
		if (!node || node.nodeType !== 1 || node === document.documentElement) return null;
		if (clipMemo.has(node)) return clipMemo.get(node);
		const outer = getComputedStyle(node).position === "fixed" ? null : clipArea(parentOf(node));
		let area = outer;
		if (clips(getComputedStyle(node)) && (node !== document.body || bodyClips)) {
			const b = node.getBoundingClientRect();
			const own = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
			area = outer ? { left: Math.max(own.left, outer.left), top: Math.max(own.top, outer.top), right: Math.min(own.right, outer.right), bottom: Math.min(own.bottom, outer.bottom) } : own;
		}
		clipMemo.set(node, area);
		return area;
	}

	/** False when a clipping ancestor hides the whole box (a carousel slide, a closed menu, a ticker line). */
	function insideClip(el, box) {
		if (getComputedStyle(el).position === "fixed") return true;
		const area = clipArea(parentOf(el));
		return !area || (Math.min(box.right, area.right) - Math.max(box.left, area.left) > 0.5 && Math.min(box.bottom, area.bottom) - Math.max(box.top, area.top) > 0.5);
	}

	let truncated = false;
	/** Every element in document order, with the content of open shadow roots after their host. */
	function* elementsOf(root) {
		for (const el of root.querySelectorAll("*")) {
			yield el;
			if (el.shadowRoot) yield* elementsOf(el.shadowRoot);
		}
	}
	const all = document.body ? [document.body, ...elementsOf(document.body)] : [];
	for (const el of all) {
		if (facts.length >= maxElements) {
			truncated = true;
			break;
		}
		if (SKIP.has(el.tagName) || el.closest("svg") !== el && el.closest("svg")) continue;
		if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
		const box = el.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0 || !insideClip(el, box)) continue;
		// Screen-reader-only text (the 1px clip pattern) is not on screen.
		if ((box.width <= 1.5 || box.height <= 1.5) && ownText(el)) continue;
		const style = getComputedStyle(el);
		const rect = { x: Math.round(box.x + sx), y: Math.round(box.y + sy), w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 };
		let parent = null;
		for (let p = parentOf(el); p; p = parentOf(p)) if (index.has(p)) {
			parent = index.get(p);
			break;
		}
		const text = ownText(el);
		const back = background(el);
		const tag = el.tagName.toLowerCase();
		const borderWidths = ["Top", "Right", "Bottom", "Left"].map((s) => px(style[`border${s}Width`]));
		const fact = {
			i: facts.length,
			sel: selectorOf(el),
			tag,
			parent,
			text,
			rect,
			display: style.display,
			position: style.position,
			classKey: `${tag}.${[...el.classList].sort().join(".")}`,
			interactive: el.matches(INTERACTIVE),
			inlineInText: tag === "a" && Boolean(parentOf(el) && ownText(parentOf(el))),
			inCode: Boolean(el.closest("pre, code, kbd, samp, textarea")),
			live: Boolean(el.closest("[aria-busy=true], [role=progressbar], [role=status], [role=alert], progress")),
			font: {
				size: px(style.fontSize),
				weight: parseInt(style.fontWeight, 10) || 400,
				family: style.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
				mono: /mono|code|courier|consol|menlo/i.test(style.fontFamily),
				style: style.fontStyle,
				transform: style.textTransform,
				spacing: px(style.letterSpacing),
				numeric: `${style.fontVariantNumeric} ${style.fontFeatureSettings}`,
			},
			color: rgba(style.color),
			bg: rgba(style.backgroundColor),
			effBg: back.color,
			effBgUnknown: back.unknown,
			effBgStops: back.stops,
			bgImage: gradients(style.backgroundImage),
			boxShadow: shadows(style.boxShadow),
			textShadow: shadows(style.textShadow),
			filter: filterFacts(style.filter),
			clipText: /text/.test(style.backgroundClip || "") || /text/.test(style.webkitBackgroundClip || ""),
			textFill: rgba(style.webkitTextFillColor || style.color),
			border: { widths: borderWidths, colors: ["Top", "Right", "Bottom", "Left"].map((s) => rgba(style[`border${s}Color`])) },
			radius: ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map((c) => radius(style[`border${c}Radius`], box.width, box.height)),
			spacing: {
				mt: px(style.marginTop), mr: px(style.marginRight), mb: px(style.marginBottom), ml: px(style.marginLeft),
				pt: px(style.paddingTop), pr: px(style.paddingRight), pb: px(style.paddingBottom), pl: px(style.paddingLeft),
				rowGap: px(style.rowGap), colGap: px(style.columnGap),
			},
			transition: { props: listOf(style.transitionProperty), durations: listOf(style.transitionDuration).map(seconds), easings: listOf(style.transitionTimingFunction) },
			animation: animationOf(style),
			clipped: Boolean(text) && el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(style.overflowX) && style.textOverflow !== "ellipsis",
			opacity: parseFloat(style.opacity),
			drawnOpacity: Math.round(drawnOpacity(el) * 1000) / 1000,
			clips: clips(style),
		};
		if (tag === "svg") {
			const shape = el.querySelector("path, line, circle, rect, polyline, polygon");
			const shapeStyle = shape ? getComputedStyle(shape) : null;
			fact.icon = { w: Math.round(box.width), h: Math.round(box.height), stroke: shapeStyle && shapeStyle.stroke !== "none" ? px(shapeStyle.strokeWidth) : null };
		}
		index.set(el, fact.i);
		facts.push(fact);
		pseudo(el, "::before", rect, fact.i, fact.live);
		pseudo(el, "::after", rect, fact.i, fact.live);
	}

	const root = document.documentElement;
	return {
		page: {
			url: location.href,
			title: document.title,
			lang: root.lang || null,
			viewport: { w: window.innerWidth, h: window.innerHeight },
			scrollWidth: Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0),
			scrollHeight: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0),
			pageBg: background(document.body).color,
			viewportMeta: document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? null,
			// Overflow that <html> or <body> hides cannot be scrolled to.
			overflowHidden: /hidden|clip/.test(`${rootStyle.overflowX} ${document.body ? getComputedStyle(document.body).overflowX : ""}`),
			iframes: document.querySelectorAll("iframe").length,
			elementCount: facts.length,
			truncated,
		},
		elements: facts,
	};
}

/**
 * The visible state of the focused element, then of the same element after a
 * blur, so the caller can tell whether focus changes anything on screen.
 * Transitions must be off (the caller injects a style) or the reads show the
 * start of a transition.
 */
export function probeFocus() {
	const el = document.activeElement;
	if (!(el instanceof HTMLElement || el instanceof SVGElement) || el === document.body || el.tagName === "IFRAME") return null;
	// A focus style may sit on a wrapper (:focus-within), so the parent and the grandparent count too.
	const watched = [el, el.parentElement, el.parentElement?.parentElement].filter((node) => node && node !== document.body);
	const read = () => watched.map((node) => {
		const s = getComputedStyle(node);
		return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join("|");
	}).join("||");
	const focused = read();
	el.blur();
	const blurred = read();
	el.focus();
	const box = el.getBoundingClientRect();
	const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 60);
	return {
		tag: el.tagName.toLowerCase(),
		label,
		rect: { x: Math.round(box.x + window.scrollX), y: Math.round(box.y + window.scrollY), w: Math.round(box.width), h: Math.round(box.height) },
		visible: focused !== blurred,
		key: `${el.tagName}|${label}|${Math.round(box.x)}|${Math.round(box.y)}`,
	};
}
