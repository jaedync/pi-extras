/**
 * Boxes in CSS pixels of the viewport: reading DOM rects, unions for the
 * `changed` box, clipping to the viewport and the camera transform into
 * output pixels. Pure; no DOM here.
 */

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** Reads {x, y, width, height} or a DOMRect-like {left, top, right, bottom}. */
export function normalizeBox(box) {
	if (!box || typeof box !== "object") return null;
	if (finite(box.x) && finite(box.y) && finite(box.width) && finite(box.height)) {
		return { x: box.x, y: box.y, width: box.width, height: box.height };
	}
	if (finite(box.left) && finite(box.top) && finite(box.right) && finite(box.bottom)) {
		return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
	}
	return null;
}

/** The smallest box that covers all given boxes; null when none has area. */
export function unionRects(boxes) {
	let result = null;
	for (const raw of boxes ?? []) {
		const box = normalizeBox(raw);
		if (!box || box.width <= 0 || box.height <= 0) continue;
		if (!result) {
			result = { ...box };
			continue;
		}
		const x = Math.min(result.x, box.x);
		const y = Math.min(result.y, box.y);
		result = { x, y, width: Math.max(result.x + result.width, box.x + box.width) - x, height: Math.max(result.y + result.height, box.y + box.height) - y };
	}
	return result;
}

export function intersectBox(a, b) {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right <= left || bottom <= top) return null;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Keeps the visible part of a box; subpixel noise is rounded to 0.1 px. */
export function clipToViewport(box, viewport) {
	const clipped = intersectBox(normalizeBox(box) ?? { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: viewport.width, height: viewport.height });
	return clipped ? roundBox(clipped, 1) : null;
}

export function insetBox(box, px) {
	const x = box.x + px;
	const y = box.y + px;
	const width = box.width - 2 * px;
	const height = box.height - 2 * px;
	return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function containsPoint(box, x, y) {
	return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

export function boxCenter(box) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function roundTo(value, digits) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function roundBox(box, digits = 2) {
	if (!box) return null;
	return { x: roundTo(box.x, digits), y: roundTo(box.y, digits), width: roundTo(box.width, digits), height: roundTo(box.height, digits) };
}
