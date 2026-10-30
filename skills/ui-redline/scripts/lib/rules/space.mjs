import { at, hasBox, summary, tally } from "./util.mjs";

const SIDES = [["pt", "padding-top"], ["pr", "padding-right"], ["pb", "padding-bottom"], ["pl", "padding-left"], ["mt", "margin-top"], ["mb", "margin-bottom"]];
const ROW_TAGS = new Set(["li", "tr", "a", "button", "dt", "dd", "label"]);

function offGrid(value, grid, allow) {
	if (value <= 0 || allow.includes(value)) return false;
	const steps = value / grid;
	return Math.abs(steps - Math.round(steps)) * grid > 0.25;
}

/** Siblings that look alike: same parent and same tag and classes, at least three. */
function siblingGroups(elements) {
	const groups = new Map();
	for (const el of elements) {
		if (el.pseudo || el.parent === null || el.display === "inline" || el.position === "absolute" || el.position === "fixed") continue;
		const [tag, ...classes] = el.classKey.split(".");
		if (!classes.filter(Boolean).length && !ROW_TAGS.has(tag)) continue;
		const key = `${el.parent}|${el.classKey}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(el);
	}
	return [...groups.values()].filter((g) => g.length >= 3);
}

const MAX_LIST_GAP = 64;
const near = (values, tolerance) => Math.max(...values) - Math.min(...values) <= tolerance;

export const spaceRules = [
	{
		id: "off-grid",
		category: "spacing",
		severity: "medium",
		title: "Spacing off the grid",
		fix: "Move padding, margins and gaps to multiples of the grid (4px by default). 1 and 2px nudges and the 6 and 10px half-steps inside small controls are fine.",
		defaults: { grid: 4, allow: [1, 2, 6, 10] },
		run: ({ elements }, o) => elements.filter((el) => !el.pseudo && el.tag !== "body").flatMap((el) => {
			const bad = SIDES.filter(([key]) => offGrid(el.spacing[key], o.grid, o.allow)).map(([key, name]) => `${name} ${el.spacing[key]}px`);
			// Horizontal margins are often the used value of `auto`; check them only when small and not a centering pair.
			for (const [key, name] of [["ml", "margin-left"], ["mr", "margin-right"]]) {
				if (el.spacing.ml !== el.spacing.mr && el.spacing[key] <= 64 && offGrid(el.spacing[key], o.grid, o.allow)) bad.push(`${name} ${el.spacing[key]}px`);
			}
			if (/flex|grid/.test(el.display ?? "")) {
				if (offGrid(el.spacing.rowGap, o.grid, o.allow)) bad.push(`row-gap ${el.spacing.rowGap}px`);
				if (offGrid(el.spacing.colGap, o.grid, o.allow)) bad.push(`column-gap ${el.spacing.colGap}px`);
			}
			return bad.length ? [at(el, bad.join(", "))] : [];
		}),
	},
	{
		id: "uneven-siblings",
		category: "spacing",
		severity: "medium",
		title: "Matching items with different padding or row height",
		fix: "Give items of one kind one padding and, for rows, one height.",
		run: ({ elements }) => siblingGroups(elements).flatMap((group) => {
			const paddings = tally(group.map((el) => [el.spacing.pt, el.spacing.pr, el.spacing.pb, el.spacing.pl].join("/")));
			if (paddings.length > 1) return [at(group[0], `${group.length} × ${group[0].classKey}: paddings ${paddings.map(([p, n]) => `${p} ×${n}`).join(", ")}`)];
			const rows = group.every((el) => el.rect.h <= 72) && group.every((el) => el.rect.w === group[0].rect.w);
			if (rows && !near(group.map((el) => el.rect.h), 2)) return [at(group[0], `${group.length} rows, heights ${[...new Set(group.map((el) => el.rect.h))].join(", ")}px`)];
			return [];
		}),
	},
	{
		id: "uneven-rhythm",
		category: "spacing",
		severity: "medium",
		title: "Uneven gaps between items of one list or row",
		fix: "Use one gap for one list. Set it on the parent (gap) instead of on each child.",
		run: ({ elements }) => siblingGroups(elements).flatMap((group) => {
			if (group.some((el) => el.rect.w < 8 || el.rect.h < 8)) return [];
			const sameX = near(group.map((el) => el.rect.x), 2);
			const sameY = near(group.map((el) => el.rect.y), 2);
			if (sameX === sameY) return [];
			const sorted = [...group].sort((a, b) => (sameX ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
			const gaps = sorted.slice(1).map((el, i) => Math.round(sameX ? el.rect.y - (sorted[i].rect.y + sorted[i].rect.h) : el.rect.x - (sorted[i].rect.x + sorted[i].rect.w)));
			// Gaps over MAX_LIST_GAP separate page sections, not the items of one list.
			if (gaps.some((g) => g < 0 || g > MAX_LIST_GAP) || near(gaps, 2)) return [];
			// Flush rows (code lines, table-like lists) break with blank space on purpose.
			if (tally(gaps)[0][0] === 0 || sorted[0].inCode) return [];
			return [at(sorted[0], `${sameX ? "vertical" : "horizontal"} gaps ${gaps.join(", ")}px`)];
		}),
	},
	{
		id: "nested-radius",
		category: "details",
		severity: "low",
		title: "Inner corner radius does not follow the outer one",
		fix: "Inner radius = outer radius − the inset between them (not less than 4px when the inner box is rounded at all).",
		defaults: { tolerance: 4 },
		run: ({ elements }, o) => {
			const byIndex = new Map(elements.map((el) => [el.i, el]));
			return elements.filter((el) => !el.pseudo && hasBox(el)).flatMap((el) => {
				let outer = byIndex.get(el.parent);
				while (outer && !(hasBox(outer) && Math.max(...outer.radius) > 0)) outer = byIndex.get(outer.parent);
				if (!outer) return [];
				const R = Math.max(...outer.radius);
				const r = Math.max(...el.radius);
				const inset = Math.min(el.rect.x - outer.rect.x, el.rect.y - outer.rect.y, outer.rect.x + outer.rect.w - (el.rect.x + el.rect.w), outer.rect.y + outer.rect.h - (el.rect.y + el.rect.h));
				// A clipping parent cuts the inner corners itself.
				if (inset < 0 || inset >= R || (outer.clips && inset < 1)) return [];
				const pill = r >= Math.min(el.rect.w, el.rect.h) / 2 - 0.5;
				if (pill) return [];
				const expected = r > 0 ? Math.max(R - inset, 4) : Math.max(R - inset, 0);
				if (r > R + 1 || Math.abs(r - expected) > Math.max(o.tolerance, 0.35 * R)) return [at(el, `radius ${r}px inside ${R}px at ${Math.round(inset)}px inset, expected about ${Math.round(expected)}px`)];
				return [];
			});
		},
	},
	{
		id: "radius-count",
		category: "details",
		severity: "low",
		title: "Too many corner radii",
		fix: "Use a few radii by size: controls 6 to 10px, cards 12 to 16px, panels 16 to 20px, and full pills only where meant.",
		defaults: { max: 5 },
		run: ({ elements }, o) => {
			const radii = tally(elements.filter((el) => !el.pseudo && hasBox(el)).map((el) => ({ el, r: Math.max(...el.radius) }))
				.filter(({ el, r }) => r > 0 && r < Math.min(el.rect.w, el.rect.h) / 2 - 0.5).map(({ r }) => Math.round(r)));
			return radii.length > o.max ? [summary(`${radii.length} radii (max ${o.max}): ${radii.map(([r, n]) => `${r}px ×${n}`).join(", ")}`)] : [];
		},
	},
];
