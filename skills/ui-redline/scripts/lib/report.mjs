/** Text output of an audit and of a before/after comparison. */
import { scores } from "./rules/index.mjs";

const ORDER = { high: 0, medium: 1, low: 2 };
const CATEGORY_ORDER = ["color", "type", "spacing", "icons", "copy", "layout", "details", "motion"];
const MAX_LISTED = 8;

/** Sorts findings (high first, then by category) and numbers every instance for the redline screenshot. */
export function numberFindings(findings) {
	const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
	let n = 0;
	return sorted.map((f) => ({ ...f, instances: f.instances.map((inst) => ({ ...inst, n: ++n })) }));
}

const where = (inst) => (inst.rect ? ` ${Math.round(inst.rect.w)}×${Math.round(inst.rect.h)} at ${inst.rect.x},${inst.rect.y}` : "");
const quote = (text) => (text ? ` "${text}"` : "");

function instanceLines(inst) {
	const lines = [`    [${inst.n}] ${inst.sel ?? "(page)"}${quote(inst.text)}${where(inst)}${inst.detail ? `: ${inst.detail}` : ""}`];
	for (const ex of inst.examples ?? []) lines.push(`         e.g. ${ex.sel}${quote(ex.text)}${where(ex)}`);
	return lines;
}

function counts(findings) {
	const by = { high: 0, medium: 0, low: 0 };
	for (const f of findings) by[f.severity] += 1;
	return `${findings.length} findings: ${by.high} high, ${by.medium} medium, ${by.low} low`;
}

export function formatAudit(audit) {
	const all = Object.values(audit.views).flatMap((v) => v.findings);
	const s = audit.scores ?? scores(all);
	const lines = [
		`ui-redline audit of ${audit.url}`,
		`Slop ${s.slop}/100, craft ${s.craft}/100 (${Object.entries(audit.views).map(([name, v]) => `${name}: slop ${v.scores.slop}, craft ${v.scores.craft}`).join("; ")}). ${counts(all)}.`,
		"Slop counts the signs of generated UI; craft counts general defects. 100 means no known defect was found, not that the screen is good.",
	];
	for (const [name, view] of Object.entries(audit.views)) {
		lines.push("", `== ${name} ${view.page.viewport.w}×${view.page.viewport.h}${view.page.truncated ? " (element limit reached: only the first elements were read)" : ""}`);
		for (const file of view.files ?? []) lines.push(`   ${file}`);
		if (!view.findings.length) lines.push("   no findings");
		for (const f of view.findings) {
			lines.push("", `  ${f.severity.padEnd(6)} ${f.id} ×${f.count}  ${f.title}`, `         fix: ${f.fix}`);
			for (const inst of f.instances.slice(0, MAX_LISTED)) lines.push(...instanceLines(inst));
			if (f.instances.length > MAX_LISTED) lines.push(`         … ${f.instances.length - MAX_LISTED} more in audit.json`);
		}
	}
	for (const note of audit.notes ?? []) lines.push("", `note: ${note}`);
	return lines.join("\n");
}

const key = (f) => `${f.view}:${f.id}`;

/**
 * Compares two audits rule by rule. `pass` is true when the after audit has no
 * high finding and no rule has more instances than before.
 */
export function compareAudits(before, after) {
	const flat = (audit) => Object.values(audit.views).flatMap((v) => v.findings);
	const a = new Map(flat(before).map((f) => [key(f), f]));
	const b = new Map(flat(after).map((f) => [key(f), f]));
	const rows = [...new Set([...a.keys(), ...b.keys()])].map((k) => {
		const was = a.get(k)?.count ?? 0;
		const now = b.get(k)?.count ?? 0;
		const f = b.get(k) ?? a.get(k);
		const state = now === 0 ? "fixed" : was === 0 ? "new" : now < was ? "better" : now > was ? "worse" : "same";
		return { key: k, id: f.id, view: f.view, severity: f.severity, was, now, state };
	});
	const remainingHigh = rows.filter((r) => r.now > 0 && r.severity === "high");
	const warnings = [];
	if (before.url !== after.url) warnings.push(`the audits are of different pages: ${before.url} and ${after.url}`);
	for (const [name, view] of Object.entries(after.views)) {
		const was = before.views?.[name]?.page?.elementCount;
		const now = view.page?.elementCount;
		// A page that lost most of its elements is more likely broken than fixed.
		if (was && now !== undefined && now < was * 0.3) warnings.push(`${name}: ${now} elements after, ${was} before; check that the after page rendered fully`);
	}
	const regressions = rows.filter((r) => r.state === "new" || r.state === "worse");
	return { before: before.scores ?? scores(flat(before)), after: after.scores ?? scores(flat(after)), rows, remainingHigh, regressions, warnings, pass: !remainingHigh.length && !regressions.length };
}

export function formatCompare(result) {
	const order = { worse: 0, new: 1, same: 2, better: 3, fixed: 4 };
	const lines = [`Slop ${result.before.slop} → ${result.after.slop}, craft ${result.before.craft} → ${result.after.craft}`];
	for (const r of [...result.rows].sort((x, y) => order[x.state] - order[y.state])) {
		lines.push(`  ${r.state.padEnd(6)} ${r.severity.padEnd(6)} ${r.view}:${r.id} ${r.was} → ${r.now}`);
	}
	for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);
	lines.push("", result.pass ? "PASS: no high findings and no regressions." : `FAIL: ${result.remainingHigh.length} high finding(s) left, ${result.regressions.length} regression(s). Fix them, or say in the report why each one stays.`);
	return lines.join("\n");
}
