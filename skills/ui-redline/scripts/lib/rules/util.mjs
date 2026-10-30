/** Shared helpers for the rules. A rule gets the facts of one view and returns instances. */

export const SEVERITY_WEIGHT = { high: 6, medium: 3, low: 1 };

/** Elements whose own text people read: not pseudo, not code, with a letter or digit. */
export function textElements(elements) {
	return elements.filter((el) => !el.pseudo && el.text && /[\p{L}\p{N}]/u.test(el.text) && (el.color?.[3] ?? 1) > 0.05);
}

/** One finding instance that points at an element. */
export function at(el, detail) {
	return { sel: el.sel, text: el.text ? el.text.slice(0, 60) : "", rect: el.rect, detail };
}

/** One finding about the whole view, with up to `limit` example elements. */
export function summary(detail, examples = [], limit = 5) {
	return { detail, examples: examples.slice(0, limit).map((el) => ({ sel: el.sel, text: el.text ? el.text.slice(0, 60) : "", rect: el.rect })) };
}

/** Counts values; returns [value, count] pairs, most used first. */
export function tally(values) {
	const counts = new Map();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export const formatTally = (pairs, unit = "") => pairs.map(([v, n]) => `${v}${unit} ×${n}`).join(", ");

/** True when the element paints a box: a fill, a gradient, a border or a shadow. */
export function hasBox(el) {
	if ((el.bg?.[3] ?? 0) > 0.02 || el.bgImage?.length) return true;
	if (el.border?.widths.some((w, i) => w > 0 && (el.border.colors[i]?.[3] ?? 0) > 0.05)) return true;
	return Boolean(el.boxShadow?.length);
}

export const area = (rect) => rect.w * rect.h;
