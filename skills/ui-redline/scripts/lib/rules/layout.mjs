import { at, summary, tally } from "./util.mjs";

export const layoutRules = [
	{
		id: "mobile-viewport",
		category: "layout",
		severity: "high",
		title: "No responsive viewport meta tag",
		fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">. Without it, phones show the desktop layout zoomed out.',
		views: ["mobile"],
		run: ({ page }) => (/width\s*=\s*device-width/i.test(page.viewportMeta ?? "") ? [] : [summary(page.viewportMeta ? `content="${page.viewportMeta}"` : "no meta viewport tag")]),
	},
	{
		id: "horizontal-overflow",
		category: "layout",
		severity: "high",
		title: "Page scrolls sideways",
		fix: "Find the element that is wider than the viewport and let it wrap, shrink or scroll inside its own box.",
		views: ["desktop", "mobile"],
		run: ({ elements, page, view }) => {
			// A mobile browser zooms out to fit wide content, so innerWidth grows; compare with the device width asked for.
			if (view === "mobile" && !/width\s*=\s*device-width/i.test(page.viewportMeta ?? "")) return [];
			if (page.overflowHidden) return [];
			const limit = page.requestedWidth ?? page.viewport.w;
			const width = Math.max(page.scrollWidth, page.viewport.w);
			if (width <= limit + 1) return [];
			const wide = elements.filter((el) => !el.pseudo && el.rect.x + el.rect.w > limit + 1).sort((a, b) => a.rect.w - b.rect.w);
			return [summary(`content is ${width}px wide on a ${limit}px screen`, wide)];
		},
	},
	{
		id: "clipped-text",
		category: "layout",
		severity: "medium",
		title: "Text cut off without an ellipsis",
		fix: "Let the text wrap, give the box room, or add text-overflow: ellipsis with the full text in a title or tooltip.",
		views: ["desktop", "mobile"],
		run: ({ elements }) => elements.filter((el) => el.clipped).map((el) => at(el, "")),
	},
	{
		id: "tap-target",
		category: "layout",
		severity: "medium",
		title: "Touch target smaller than 24 × 24px and crowded by another",
		fix: "Make each control at least 24px (44px is better on touch screens) with padding, not a bigger icon.",
		views: ["mobile"],
		defaults: { min: 24 },
		run: ({ elements }, o) => {
			const targets = elements.filter((el) => el.interactive && !el.inlineInText && !el.pseudo);
			const small = (el) => el.rect.w < o.min || el.rect.h < o.min;
			const center = (el) => [el.rect.x + el.rect.w / 2, el.rect.y + el.rect.h / 2];
			const toRect = (c, r) => Math.hypot(Math.max(r.x - c[0], 0, c[0] - (r.x + r.w)), Math.max(r.y - c[1], 0, c[1] - (r.y + r.h)));
			// WCAG 2.5.8 spacing exception: a small target passes when a 24px circle on its center touches no other target or circle.
			const crowded = (el) => targets.some((other) => {
				if (other === el) return false;
				const c = center(el);
				if (toRect(c, other.rect) < o.min / 2) return true;
				return small(other) && Math.hypot(c[0] - center(other)[0], c[1] - center(other)[1]) < o.min;
			});
			return targets.filter((el) => small(el) && crowded(el)).map((el) => at(el, `${el.rect.w}×${el.rect.h}px`));
		},
	},
	{
		id: "focus-ring",
		category: "details",
		severity: "high",
		title: "No visible focus state for keyboard users",
		fix: "Add a :focus-visible style: an outline or ring in the accent with a 2px offset.",
		run: ({ focus }) => (focus ?? []).filter((f) => !f.visible).map((f) => ({ sel: f.tag, text: f.label, rect: f.rect, detail: "focus changes nothing on screen" })),
	},
	{
		id: "icon-sizes",
		category: "icons",
		severity: "low",
		title: "Icons in many sizes",
		fix: "Use one icon size in the chrome (16 or 20px) and one larger size only where it is meant.",
		defaults: { max: 2, maxIcon: 40 },
		run: ({ elements }, o) => {
			const sizes = tally(elements.filter((el) => el.icon && Math.max(el.icon.w, el.icon.h) <= o.maxIcon).map((el) => Math.max(el.icon.w, el.icon.h)));
			return sizes.length > o.max ? [summary(`${sizes.length} icon sizes: ${sizes.map(([s, n]) => `${s}px ×${n}`).join(", ")}`)] : [];
		},
	},
	{
		id: "icon-strokes",
		category: "icons",
		severity: "low",
		title: "Line icons with different stroke widths",
		fix: "Use one icon set with one stroke width.",
		defaults: { max: 1, maxIcon: 40 },
		run: ({ elements }, o) => {
			const strokes = tally(elements.filter((el) => el.icon?.stroke && Math.max(el.icon.w, el.icon.h) <= o.maxIcon).map((el) => el.icon.stroke));
			return strokes.length > o.max ? [summary(`${strokes.length} stroke widths: ${strokes.map(([s, n]) => `${s} ×${n}`).join(", ")}`)] : [];
		},
	},
];
