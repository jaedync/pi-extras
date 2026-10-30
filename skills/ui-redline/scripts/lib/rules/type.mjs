import { at, formatTally, summary, tally, textElements } from "./util.mjs";

const letters = (text) => (text.match(/\p{L}/gu) ?? []).length;
const isAllCaps = (text) => letters(text) >= 4 && text === text.toUpperCase() && text !== text.toLowerCase();
const NUMBER_ONLY = /^[\s$€£¥+\-−~≈]*\d[\d,.\s]*\s?(%|[kmb]|ms|s|px)?$/i;
const CURRENCY = /[$€£¥]\s?\d{1,3}(?:,\d{3})*(?:\.(\d+))?/g;

export const typeRules = [
	{
		id: "font-sizes",
		category: "type",
		severity: "medium",
		title: "Too many font sizes",
		fix: "Pick sizes from one type scale (see references/passes.md) and map every size to its nearest step.",
		defaults: { max: 7 },
		run: ({ elements }, o) => {
			const sizes = tally(textElements(elements).map((el) => Math.round(el.font.size * 2) / 2));
			return sizes.length > o.max ? [summary(`${sizes.length} sizes (max ${o.max}): ${formatTally(sizes, "px")}`)] : [];
		},
	},
	{
		id: "heavy-weight",
		category: "type",
		severity: "medium",
		title: "Very heavy font weight",
		fix: "Make hierarchy with size and color. Use 400 and 500, and 600 at most for rare emphasis.",
		defaults: { min: 800 },
		run: ({ elements }, o) => textElements(elements).filter((el) => el.font.weight >= o.min).map((el) => at(el, `weight ${el.font.weight}, ${el.font.size}px`)),
	},
	{
		id: "font-weights",
		category: "type",
		severity: "low",
		title: "Too many font weights",
		fix: "Use two weights, and a third only for rare emphasis.",
		defaults: { max: 3 },
		run: ({ elements }, o) => {
			const weights = tally(textElements(elements).map((el) => el.font.weight));
			return weights.length > o.max ? [summary(`${weights.length} weights (max ${o.max}): ${formatTally(weights)}`)] : [];
		},
	},
	{
		id: "font-families",
		category: "type",
		severity: "low",
		title: "Too many font families",
		fix: "Use one family for the interface and at most one partner (a mono for figures or a display face for large headlines).",
		defaults: { max: 2 },
		run: ({ elements }, o) => {
			const families = tally(textElements(elements).filter((el) => !el.font.mono).map((el) => el.font.family));
			return families.length > o.max ? [summary(`${families.length} families (max ${o.max}): ${formatTally(families)}`)] : [];
		},
	},
	{
		id: "tracked-caps",
		category: "type",
		severity: "medium",
		title: "Uppercase label with wide letter spacing",
		fix: "Use sentence case at normal tracking. Keep caps only for real acronyms.",
		defaults: { minTrackingEm: 0.05 },
		run: ({ elements }, o) => textElements(elements)
			.filter((el) => (el.font.transform === "uppercase" ? letters(el.text) >= 3 : isAllCaps(el.text)) && el.font.spacing / el.font.size >= o.minTrackingEm)
			.map((el) => at(el, `${(el.font.spacing / el.font.size).toFixed(2)}em tracking`)),
	},
	{
		id: "tight-small-text",
		category: "type",
		severity: "low",
		title: "Negative letter spacing on small text",
		fix: "Set letter-spacing to 0 (or slightly positive) below 20px. Tight tracking is for large display text only.",
		defaults: { maxSize: 18, minEm: -0.02 },
		run: ({ elements }, o) => textElements(elements)
			.filter((el) => el.font.size <= o.maxSize && el.font.spacing / el.font.size < o.minEm)
			.map((el) => at(el, `${el.font.spacing}px at ${el.font.size}px`)),
	},
	{
		id: "tiny-text",
		category: "type",
		severity: "medium",
		title: "Text smaller than 11px",
		fix: "Use 12px or more for meta text, 11px as the absolute floor.",
		views: ["desktop", "mobile"],
		defaults: { min: 11 },
		run: ({ elements }, o) => textElements(elements).filter((el) => el.font.size < o.min).map((el) => at(el, `${el.font.size}px`)),
	},
	{
		id: "tabular-figures",
		category: "type",
		severity: "low",
		title: "Figures without tabular numerals",
		fix: "Set font-variant-numeric: tabular-nums on figures, so columns and changing numbers do not jitter.",
		defaults: { minCount: 3 },
		run: ({ elements }, o) => {
			const figures = textElements(elements).filter((el) => NUMBER_ONLY.test(el.text) && (el.text.match(/\d/g) ?? []).length >= 2 && !el.font.mono && !/tabular-nums|tnum/.test(el.font.numeric));
			return figures.length >= o.minCount ? [summary(`${figures.length} figures use proportional digits`, figures)] : [];
		},
	},
	{
		id: "mixed-number-format",
		category: "type",
		severity: "low",
		title: "Money shown in more than one format",
		fix: "Use one format per screen: all whole amounts or all with two decimals.",
		run: ({ elements }) => {
			const byDecimals = new Map();
			for (const el of textElements(elements)) {
				for (const m of el.text.matchAll(CURRENCY)) {
					const key = m[1] ? m[1].length : 0;
					if (!byDecimals.has(key)) byDecimals.set(key, { sample: m[0], el });
				}
			}
			if (byDecimals.size < 2) return [];
			const kinds = [...byDecimals.entries()];
			return [summary(`amounts with ${kinds.map(([d, v]) => `${d} decimals (${v.sample})`).join(" and ")}`, kinds.map(([, v]) => v.el))];
		},
	},
	{
		id: "long-lines",
		category: "type",
		severity: "low",
		title: "Paragraph lines longer than about 90 characters",
		fix: "Cap the text width near 65ch (max-width: 65ch) for paragraphs.",
		defaults: { maxEm: 45, minChars: 160 },
		run: ({ elements }, o) => textElements(elements)
			.filter((el) => el.text.length >= o.minChars && el.rect.w / el.font.size > o.maxEm)
			.map((el) => at(el, `about ${Math.round((el.rect.w / el.font.size) * 2)} characters per line`)),
	},
];
