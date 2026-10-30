import { at, summary } from "./util.mjs";

const LAYOUT_PROPS = /^(width|height|min-|max-|top|left|right|bottom|inset|margin|padding|flex-basis|grid-template)/;

/** Pairs each transition property with its duration and easing (CSS repeats the shorter lists). */
function transitions(el) {
	const t = el.transition;
	if (!t) return [];
	return t.props.map((prop, i) => ({ prop, duration: t.durations[i % t.durations.length] ?? 0, easing: t.easings[i % t.easings.length] ?? "ease" })).filter((x) => x.duration > 0 && x.prop !== "none");
}

function animations(el) {
	const a = el.animation;
	if (!a) return [];
	return a.names.map((name, i) => ({ name, iterations: a.iterations[i % a.iterations.length], duration: a.durations[i % a.durations.length] ?? 0 })).filter((x) => x.name !== "none" && x.duration > 0);
}

export const motionRules = [
	{
		id: "looping-animation",
		category: "motion",
		severity: "medium",
		title: "Animation that loops forever",
		fix: "Remove it unless the element shows live state (loading, recording, a live feed). Pulses, shimmer, floating and breathing glows go.",
		run: ({ elements }) => elements.filter((el) => !el.live).flatMap((el) => {
			const loops = animations(el).filter((x) => x.iterations === "infinite");
			return loops.length ? [at(el, loops.map((x) => `${x.name} ${x.duration}s`).join(", "))] : [];
		}),
	},
	{
		id: "transition-all",
		category: "motion",
		severity: "low",
		title: "transition: all",
		fix: "Name the properties: color, background-color, border-color, opacity, transform.",
		run: ({ elements }) => elements.filter((el) => transitions(el).some((x) => x.prop === "all")).map((el) => at(el, "")),
	},
	{
		id: "layout-transition",
		category: "motion",
		severity: "medium",
		title: "Transition on a layout property",
		fix: "Animate transform and opacity instead. Width, height, position and margins re-layout every frame and stutter.",
		run: ({ elements }) => elements.flatMap((el) => {
			const props = transitions(el).filter((x) => LAYOUT_PROPS.test(x.prop)).map((x) => x.prop);
			return props.length ? [at(el, props.join(", "))] : [];
		}),
	},
	{
		id: "motion-curves",
		category: "motion",
		severity: "low",
		title: "Too many easing curves or durations",
		fix: "Use one easing curve and two or three durations (short for feedback, longer for entering).",
		defaults: { maxEasings: 2, maxDurations: 4 },
		run: ({ elements }, o) => {
			const all = elements.flatMap(transitions);
			const easings = [...new Set(all.map((x) => x.easing))];
			const durations = [...new Set(all.map((x) => x.duration))];
			const out = [];
			if (easings.length > o.maxEasings) out.push(summary(`${easings.length} easings: ${easings.join(", ")}`));
			if (durations.length > o.maxDurations) out.push(summary(`${durations.length} durations: ${durations.map((d) => `${Math.round(d * 1000)}ms`).join(", ")}`));
			return out;
		},
	},
];
