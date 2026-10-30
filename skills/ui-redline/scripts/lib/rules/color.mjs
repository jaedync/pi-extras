import { CHROMATIC, clusterColors, composite, contrastRatio, hex, hueSpread, isChromatic, oklch } from "../color.mjs";
import { area, at, summary, textElements } from "./util.mjs";

const chromaticStops = (layer) => layer.stops.filter((s) => s[3] >= 0.15 && isChromatic(s));
const isGradient = (layer) => ["linear", "radial", "conic"].includes(layer.kind);

/** Shadows that glow: an outer shadow with a soft blur in a clear hue. */
function glows(el) {
	const all = [...(el.boxShadow ?? []), ...(el.textShadow ?? []), ...(el.filter?.drops ?? [])];
	return all.filter((s) => !s.inset && s.blur >= 6 && s.color[3] >= 0.15 && isChromatic(s.color));
}

export const colorRules = [
	{
		id: "hue-gradient",
		category: "color",
		severity: "high",
		title: "Gradient from one hue to another on a surface",
		fix: "Use one solid surface from the neutral ramp. A gradient may only shift the tone of one neutral.",
		defaults: { minSpread: 30 },
		run: ({ elements }, o) => elements.filter((el) => !el.clipText).flatMap((el) => {
			const hit = (el.bgImage ?? []).filter(isGradient).find((layer) => {
				const stops = chromaticStops(layer);
				return stops.length >= 2 && hueSpread(stops.map((s) => oklch(s).h)) >= o.minSpread;
			});
			return hit ? [at(el, `${hit.kind} ${chromaticStops(hit).map(hex).join(" → ")}`)] : [];
		}),
	},
	{
		id: "gradient-text",
		category: "color",
		severity: "high",
		title: "Gradient text",
		fix: "Give the text one solid color from the text roles.",
		run: ({ elements }) => elements
			.filter((el) => el.clipText && (el.bgImage ?? []).some(isGradient) && ((el.textFill?.[3] ?? 1) < 0.1 || (el.color?.[3] ?? 1) < 0.1))
			.map((el) => at(el, (el.bgImage ?? []).filter(isGradient).flatMap((l) => l.stops).map(hex).join(" → "))),
	},
	{
		id: "colored-glow",
		category: "color",
		severity: "high",
		title: "Colored glow (box-shadow, text-shadow or drop-shadow in a hue)",
		fix: "Remove the glow. Show depth with a surface step and a hairline; on light themes a small neutral shadow is enough.",
		run: ({ elements }) => elements.flatMap((el) => {
			const g = glows(el);
			return g.length ? [at(el, g.map((s) => `${hex(s.color)} blur ${s.blur}px`).join(", "))] : [];
		}),
	},
	{
		id: "color-wash",
		category: "color",
		severity: "medium",
		title: "Colored wash or blurred blob behind content",
		fix: "Remove it. Put the color into one element that carries meaning, not into the background.",
		defaults: { minViewportShare: 0.05, minBlur: 16 },
		run: ({ elements, page }, o) => {
			const viewport = page.viewport.w * page.viewport.h;
			return elements.flatMap((el) => {
				const radial = (el.bgImage ?? []).find((l) => (l.kind === "radial" || l.kind === "conic") && chromaticStops(l).length > 0);
				if (radial && area(el.rect) >= viewport * o.minViewportShare) return [at(el, `${radial.kind} wash ${chromaticStops(radial).map(hex).join(", ")}`)];
				const blurred = (el.filter?.blur ?? 0) >= o.minBlur;
				if (blurred && (isChromatic(el.bg ?? [0, 0, 0, 0]) || (el.bgImage ?? []).some((l) => chromaticStops(l).length))) return [at(el, `blur(${el.filter.blur}px) on a colored fill`)];
				return [];
			});
		},
	},
	{
		id: "low-contrast",
		category: "color",
		severity: "high",
		title: "Text below WCAG AA contrast",
		fix: "Raise the contrast to 4.5:1 (3:1 for text of 24px, or 18.66px bold, and up). Use a darker or lighter step of the ramp.",
		run: ({ elements }) => textElements(elements).filter((el) => !el.effBgUnknown && !el.clipText).flatMap((el) => {
			// Over a gradient, test every stop and keep the worst.
			const backs = el.effBgStops?.length ? el.effBgStops : [el.effBg];
			// Opacity on the element or an ancestor fades the text toward what is behind it.
			const drawn = [...el.color.slice(0, 3), (el.color[3] ?? 1) * (el.drawnOpacity ?? 1)];
			const [ratio, back, fg] = backs.map((b) => {
				const f = composite(drawn, b);
				return [contrastRatio(f, b), b, f];
			}).sort((x, y) => x[0] - y[0])[0];
			const large = el.font.size >= 24 || (el.font.size >= 18.66 && el.font.weight >= 700);
			const where = el.effBgStops?.length ? " (worst gradient stop)" : "";
			return ratio < (large ? 3 : 4.5) ? [at(el, `${ratio.toFixed(2)}:1, ${hex(fg)} on ${hex(back)}${where}, ${el.font.size}px`)] : [];
		}),
	},
	{
		id: "text-colors",
		category: "color",
		severity: "medium",
		title: "Too many text colors",
		fix: "Use three text roles (primary, secondary, muted) and the accent. Map every other text color to one of them.",
		defaults: { max: 5 },
		run: ({ elements }, o) => {
			// Text on its own fill (a button label, a chip) is an inverse role, not one more text color.
			const texts = textElements(elements).filter((el) => !el.clipText && (el.bg?.[3] ?? 0) < 0.5 && !el.bgImage?.length);
			const groups = clusterColors(texts.map((el) => composite(el.color, el.effBg)));
			if (groups.length <= o.max) return [];
			return [summary(`${groups.length} text colors (max ${o.max}): ${groups.map((g) => `${hex(g.color)} ×${g.count}`).join(", ")}`)];
		},
	},
	{
		id: "accent-hues",
		category: "color",
		severity: "medium",
		title: "Too many hues in the interface chrome",
		fix: "Keep one accent hue, plus muted semantic colors that carry a meaning (error, success). Charts and images are not counted.",
		defaults: { max: 3, hueTolerance: 25, minUses: 2 },
		run: ({ elements }, o) => {
			// Families grow around their first hue, so one color ramp (sky-500 and sky-600) stays one family.
			const families = [];
			for (const el of elements) {
				if (el.pseudo) continue;
				const colors = [el.text ? el.color : null, (el.bg?.[3] ?? 0) > 0.2 ? el.bg : null, ...(el.border?.widths ?? []).map((w, i) => (w > 0 ? el.border.colors[i] : null))];
				const seen = new Set();
				for (const color of colors) {
					if (!color || !isChromatic(color, CHROMATIC)) continue;
					const h = oklch(color).h;
					let family = families.find((f) => hueSpread([f.hue, h]) <= o.hueTolerance);
					if (!family) families.push((family = { hue: h, sample: color, el, elements: 0 }));
					// Each element counts once per family, not once per border side.
					if (!seen.has(family)) {
						seen.add(family);
						family.elements++;
					}
				}
			}
			const used = families.filter((f) => f.elements >= o.minUses);
			if (used.length <= o.max) return [];
			return [summary(`${used.length} hue families (max ${o.max}): ${used.map((f) => `${hex(f.sample)} ×${f.elements}`).join(", ")}`, used.map((f) => f.el))];
		},
	},
	{
		id: "neon-border",
		category: "color",
		severity: "medium",
		title: "Saturated colored borders on many elements",
		fix: "Use hairlines: the text color of the ramp at 6 to 12% opacity. Keep a colored border only for the selected or focused element.",
		defaults: { minChroma: 0.12, minCount: 3 },
		run: ({ elements }, o) => {
			const neon = (el) => el.border?.widths.findIndex((w, i) => w >= 1 && el.border.colors[i][3] >= 0.5 && oklch(el.border.colors[i]).c >= o.minChroma) ?? -1;
			const hits = elements.filter((el) => !el.pseudo && !el.inCode && neon(el) >= 0);
			if (hits.length < o.minCount) return [];
			return hits.map((el) => at(el, `border ${hex(el.border.colors[neon(el)])}`));
		},
	},
];
