/** Synthetic facts for the ui-redline rule tests: one element at a time, changed one field at a time. */

const NONE = [0, 0, 0, 0];

export function el(patch = {}) {
	const base = {
		sel: "div",
		tag: "div",
		parent: null,
		text: "",
		rect: { x: 0, y: 0, w: 100, h: 20 },
		display: "block",
		position: "static",
		classKey: "div.x",
		interactive: false,
		inlineInText: false,
		inCode: false,
		live: false,
		color: [20, 20, 20, 1],
		bg: NONE,
		effBg: [255, 255, 255, 1],
		effBgUnknown: false,
		effBgStops: null,
		bgImage: [],
		boxShadow: [],
		textShadow: [],
		filter: null,
		clipText: false,
		textFill: [20, 20, 20, 1],
		border: { widths: [0, 0, 0, 0], colors: [NONE, NONE, NONE, NONE] },
		radius: [0, 0, 0, 0],
		transition: { props: ["all"], durations: [0], easings: ["ease"] },
		animation: { names: ["none"], iterations: ["1"], durations: [0] },
		clipped: false,
		opacity: 1,
	};
	return {
		...base,
		...patch,
		font: { size: 16, weight: 400, family: "Inter", mono: false, style: "normal", transform: "none", spacing: 0, numeric: "normal normal", ...(patch.font ?? {}) },
		spacing: { mt: 0, mr: 0, mb: 0, ml: 0, pt: 0, pr: 0, pb: 0, pl: 0, rowGap: 0, colGap: 0, ...(patch.spacing ?? {}) },
	};
}

/** Text element shortcut. */
export const text = (value, patch = {}) => el({ text: value, ...patch });

export function facts(elements, page = {}) {
	return {
		page: { url: "file:///fixture.html", viewport: { w: 1440, h: 900 }, scrollWidth: 1440, scrollHeight: 900, viewportMeta: "width=device-width, initial-scale=1", requestedWidth: 1440, truncated: false, ...page },
		elements: elements.map((e, i) => ({ ...e, i: e.i ?? i })),
	};
}

export const border = (color, width = 1) => ({ widths: [width, width, width, width], colors: [color, color, color, color] });
