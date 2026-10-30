/**
 * The rule registry, the project config and the scores. A rule runs on the
 * facts of one view (desktop by default) and returns instances. There are two
 * scores: `slop` counts the signs of generated UI, `craft` the general defects
 * (contrast, spacing, sizes, focus) that polished sites also have. Each counts
 * at most CAP instances per rule, so one repeated defect cannot hide the rest.
 */
import { colorRules } from "./color.mjs";
import { copyRules } from "./copy.mjs";
import { layoutRules } from "./layout.mjs";
import { motionRules } from "./motion.mjs";
import { spaceRules } from "./space.mjs";
import { typeRules } from "./type.mjs";
import { SEVERITY_WEIGHT } from "./util.mjs";

export const RULES = [...colorRules, ...typeRules, ...spaceRules, ...copyRules, ...motionRules, ...layoutRules];
/** The rules whose findings are signs of generated UI; every other rule is craft. */
export const SLOP_RULES = new Set(["hue-gradient", "gradient-text", "colored-glow", "color-wash", "neon-border", "heavy-weight", "tracked-caps", "emoji", "exclamation", "hype-words", "unverified-claims", "greeting", "placeholder-data", "looping-animation"]);
export const kindOf = (id) => (SLOP_RULES.has(id) ? "slop" : "craft");
export const CAP = 5;
const SEVERITIES = new Set(Object.keys(SEVERITY_WEIGHT));

/**
 * @typedef {{ grid?: number, rules?: Record<string, "off" | Record<string, any>> }} RedlineConfig
 */

/**
 * Checks a project config (`.redline.json`) and returns it in normal form.
 * Shape: { "grid": 4, "rules": { "<id>": "off" | { "severity": "low", ...options } } }.
 * @param {any} raw
 * @returns {RedlineConfig}
 */
export function normalizeConfig(raw = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the config must be a JSON object");
	const known = new Set(RULES.map((r) => r.id));
	const rules = {};
	for (const [id, value] of Object.entries(raw.rules ?? {})) {
		if (!known.has(id)) throw new Error(`unknown rule "${id}" in the config; known rules: ${[...known].join(", ")}`);
		if (value === "off" || value === false) rules[id] = "off";
		else if (value && typeof value === "object" && !Array.isArray(value)) {
			if (value.severity !== undefined && !SEVERITIES.has(value.severity)) throw new Error(`rule "${id}": severity must be high, medium or low`);
			rules[id] = value;
		} else throw new Error(`rule "${id}": use "off" or an object of options`);
	}
	if (raw.grid !== undefined && !(Number.isFinite(raw.grid) && raw.grid > 0)) throw new Error("grid must be a positive number of pixels");
	return { grid: raw.grid, rules };
}

/** @param {any} rule @param {RedlineConfig} config */
function optionsFor(rule, config) {
	const own = config.rules?.[rule.id];
	const merged = { ...(rule.defaults ?? {}), ...(typeof own === "object" ? own : {}) };
	if (rule.id === "off-grid" && config.grid && !(typeof own === "object" && own.grid)) merged.grid = config.grid;
	return merged;
}

/**
 * Runs every rule that applies to `view`; returns findings with their instances.
 * @param {{ elements: any[], page: any }} facts
 * @param {{ view?: string, focus?: any[], config?: RedlineConfig }} [options]
 */
export function runRules(facts, { view = "desktop", focus = [], config = {} } = {}) {
	const ctx = { elements: facts.elements, page: facts.page, focus, view };
	const findings = [];
	for (const rule of RULES) {
		if (config.rules?.[rule.id] === "off") continue;
		if (!(rule.views ?? ["desktop"]).includes(view)) continue;
		const options = optionsFor(rule, config);
		const instances = rule.run(ctx, options);
		if (!instances.length) continue;
		findings.push({ id: rule.id, view, kind: kindOf(rule.id), category: rule.category, severity: options.severity ?? rule.severity, title: rule.title, fix: rule.fix, count: instances.length, instances });
	}
	return findings;
}

/** 100 minus the weighted, capped findings; never below 0. */
export function score(findings) {
	const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity] * Math.min(f.count, CAP), 0);
	return Math.max(0, 100 - penalty);
}

/** The slop and craft scores of a list of findings. */
export function scores(findings) {
	return { slop: score(findings.filter((f) => kindOf(f.id) === "slop")), craft: score(findings.filter((f) => kindOf(f.id) === "craft")) };
}
