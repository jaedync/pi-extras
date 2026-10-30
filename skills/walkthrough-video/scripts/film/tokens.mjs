/**
 * Brand tokens from the raw facts that the page collector (lift-page.mjs)
 * returns. Every choice here is mechanical, so two lifts of one page give
 * the same tokens: the ground is the colour that covers most of the screen,
 * the ink is the text colour with the most weight on that ground, and a
 * curve that overshoots is a spring.
 */

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

/** { r, g, b, a } from a CSS colour (hex, rgb(), rgba(), a few names); null when it is not a plain colour. */
export function parseColor(value) {
	const s = String(value ?? "").trim().toLowerCase();
	if (NAMED[s]) {
		const [r, g, b, a] = NAMED[s];
		return { r, g, b, a };
	}
	let m = s.match(/^#([0-9a-f]{3,8})$/);
	if (m) {
		let hex = m[1];
		if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
		if (hex.length !== 6 && hex.length !== 8) return null;
		const n = (i) => parseInt(hex.slice(i, i + 2), 16);
		return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
	}
	m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
	if (m) {
		let a = m[4] === undefined ? 1 : parseFloat(m[4]);
		if (m[4]?.endsWith("%")) a /= 100;
		return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a };
	}
	return null;
}

/** Lower-case #rrggbb, or #rrggbbaa when the alpha is not 1; null when it is not a plain colour. */
export function toHex(value) {
	const c = parseColor(value);
	if (!c) return null;
	const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a >= 1 ? "" : h(c.a * 255)}`;
}

/** spring (overshoots), anticipate (pulls back first), linear or ease. */
export function easeKind(value) {
	const m = String(value).match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
	if (!m) return String(value).trim() === "linear" ? "linear" : "ease";
	const [y1, y2] = [+m[2], +m[4]];
	if (y1 > 1 || y2 > 1) return "spring";
	if (y1 < 0 || y2 < 0) return "anticipate";
	return "ease";
}

/** The stylesheet without transitions: a lifted UI moves only when the film moves it. */
export function stripTransitions(css) {
	return String(css).replace(/(^|[;{\s])transition(?:-[a-z-]+)?\s*:[^;}]*;?/g, "$1");
}

const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
const textWeight = (t) => (Number(t.chars) || 0) * (Number(t.size) || 0) ** 2;

/** Groups items by key; returns [key, items] sorted by the summed score, largest first. */
function ranked(items, key, score) {
	const groups = new Map();
	for (const item of items) {
		const k = key(item);
		if (k == null) continue;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(item);
	}
	return [...groups].map(([k, list]) => [k, list, sum(list, score)]).sort((a, b) => b[2] - a[2]);
}

/** For each ground behind text, its text colours, heaviest first. Grounds are in order of their text weight. */
export function inksByGround(texts, varOf = {}) {
	const table = {};
	for (const [ground, list] of ranked(texts ?? [], (t) => toHex(t.ground), textWeight)) {
		table[ground] = ranked(list, (t) => toHex(t.color), textWeight).map(([color, items]) => ({
			color,
			...(varOf[color] ? { var: varOf[color] } : {}),
			selectors: [...new Set(items.map((t) => t.selector))].slice(0, 4),
		}));
	}
	return table;
}

/** Tokens with roles from the raw page facts. */
export function assignRoles(raw) {
	const palette = {};
	const varOf = new Map();
	for (const v of raw.vars ?? []) {
		const hex = toHex(v.computed ?? v.value);
		if (!hex) continue;
		palette[v.name] = hex;
		// The shortest name wins: --accent before --accent-hover.
		if (!varOf.has(hex) || v.name.length < varOf.get(hex).length) varOf.set(hex, v.name);
	}
	const named = (hex, extra = {}) => ({ color: hex, ...(varOf.has(hex) ? { var: varOf.get(hex) } : {}), ...extra });

	const grounds = ranked(raw.grounds ?? [], (g) => toHex(g.color), (g) => g.share);
	const [groundHex, groundList, groundShare] = grounds[0] ?? [null, [], 0];
	const groundTop = [...groundList].sort((a, b) => b.share - a.share)[0] ?? {};
	const ground = groundHex ? named(groundHex, { share: +groundShare.toFixed(3), selector: groundTop.selector, ...(groundTop.image && groundTop.image !== "none" ? { image: groundTop.image } : {}) }) : null;

	const onGround = (raw.texts ?? []).filter((t) => groundHex && toHex(t.ground) === groundHex);
	const inks = ranked(onGround, (t) => toHex(t.color), textWeight).map(([hex, list]) => named(hex, { selectors: [...new Set(list.map((t) => t.selector))].slice(0, 4) }));

	const surfaceName = /(^--(bg|background)$)|surface|card-face|paper|panel/;
	const surfaces = (raw.vars ?? []).filter((v) => surfaceName.test(v.name) && toHex(v.computed ?? v.value)?.length === 7).map((v) => ({ var: v.name, color: toHex(v.computed ?? v.value) }));

	const accentVar = (raw.vars ?? []).filter((v) => /accent|brand|primary/.test(v.name) && toHex(v.computed ?? v.value)?.length === 7).sort((a, b) => a.name.length - b.name.length)[0];
	const accent = accentVar ? { var: accentVar.name, color: toHex(accentVar.computed ?? accentVar.value) } : null;

	const families = ranked(raw.texts ?? [], (t) => t.family, textWeight);
	const maxSize = new Map(families.map(([family, list]) => [family, Math.max(...list.map((t) => t.size))]));
	const display = [...maxSize].sort((a, b) => b[1] - a[1])[0]?.[0];
	const body = ranked(raw.texts ?? [], (t) => t.family, (t) => t.chars)[0]?.[0];
	const fonts = families.map(([family, list]) => {
		const [weight, wl] = ranked(list, (t) => Number(t.weight), textWeight)[0];
		const variation = ranked(wl, (t) => t.variation, textWeight)[0][0];
		const face = (raw.fontFaces ?? []).find((f) => f.family === family);
		return {
			family,
			role: family === display ? "display" : family === body ? "body" : "other",
			weight,
			weights: [...new Set(list.map((t) => Number(t.weight)))].sort((a, b) => a - b),
			...(variation && variation !== "normal" ? { variation } : {}),
			maxSize: maxSize.get(family),
			...(face ? { src: face.src } : {}),
		};
	});

	const curves = ranked(raw.easings ?? [], (e) => e.value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", "), () => 1).map(([value, list]) => ({
		value,
		uses: list.length,
		selectors: [...new Set(list.map((e) => e.selector))].slice(0, 6),
	}));
	const springs = curves.filter((c) => easeKind(c.value) === "spring");
	const eases = curves.filter((c) => easeKind(c.value) !== "spring" && /cubic-bezier/.test(c.value));

	return {
		source: raw.url,
		viewport: raw.viewport,
		ground,
		ink: inks[0] ?? null,
		inkSecondary: inks.slice(1, 4),
		surfaces,
		accent,
		fonts,
		motion: { springs, eases, keyframes: (raw.keyframes ?? []).map((k) => k.name) },
		palette,
		literals: (raw.literals ?? []).map((l) => ({ ...l, value: toHex(l.value) ?? l.value })),
	};
}

/** One IPv4 octet: 0 to 255, so 10.999.0.1 is not an address. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

/**
 * Local and private hosts, with an optional scheme and port. The lookarounds
 * make it a whole address: 110.1.2.3 does not hold 10.1.2.3, and a number that
 * runs into a letter or a dot is not a host.
 */
const LOCAL_HOST = new RegExp(
	`(?<![\\w.])(?:(?:https?:\\/\\/)?(?:localhost|127(?:\\.${OCTET}){3}|0\\.0\\.0\\.0|\\[::1\\]|10(?:\\.${OCTET}){3}|192\\.168(?:\\.${OCTET}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.${OCTET}){2})(?::\\d{2,5})?)(?![\\w.])`,
	"g",
);

/**
 * Lifted markup with the app's own address (and any local or private host)
 * replaced by app.example, so a scene that pastes it does not leak a host.
 * @param {string} html
 * @param {string} pageUrl the address the lift opened
 * @returns {{html: string, replaced: number}}
 */
export function scrubMarkup(html, pageUrl) {
	let replaced = 0;
	let out = html;
	const swapAll = (needle, by) => {
		const parts = out.split(needle);
		replaced += parts.length - 1;
		out = parts.join(by);
	};
	if (URL.canParse(pageUrl)) {
		const { origin, host, hostname } = new URL(pageUrl);
		if (!hostname.endsWith(".example")) {
			swapAll(origin, "https://app.example");
			swapAll(host, "app.example");
		}
	}
	out = out.replace(LOCAL_HOST, (match) => {
		replaced++;
		return /^https?:\/\//.test(match) ? "https://app.example" : "app.example";
	});
	return { html: out, replaced };
}
