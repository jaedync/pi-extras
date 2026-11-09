/**
 * The measure step: catalog sites per rule (source and tests apart), fix-commit evidence, linter overlap, and one
 * verdict per rule. The verdict is a rule of thumb that the agent checks against the samples, not a decision.
 */
import { scan } from "./ast-grep.mjs";
import { mineHistory } from "./history.mjs";
import { detectLinters, overlapOf } from "./linters.mjs";

/** @param {string} file */
export const isTestFile = (file) => /(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\.[^/]+$/.test(file);

/** @param {string} id */
const baseId = (id) => id.replace(/-tsx$/, "");

/**
 * Evenly spread picks, so the same repository gives the same samples every run.
 * @template T @param {T[]} items @param {number} n
 */
export function spread(items, n) {
	if (items.length <= n) return items;
	return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

/**
 * @param {{ sites: number, precision: string, enforcedBy: string[] }} rule
 * @returns {"adopt" | "sample" | "skip: linter" | "skip: no sites"}
 */
export function verdict({ sites, precision, enforcedBy }) {
	if (sites === 0) return "skip: no sites";
	if (enforcedBy.length) return "skip: linter";
	return precision === "high" ? "adopt" : "sample";
}

/**
 * @param {{ command: string, args: string[], version?: string }} tool
 * @param {{ root: string, config: string, paths: string[], historyLimit: number, sampleCount: number,
 *   samples: { js?: string, py?: string }, testGlobs: string[] }} options
 */
export function measureReport(tool, { root, config, paths, historyLimit, sampleCount, samples }) {
	const { ruleIds, findings } = scan(tool, { config, cwd: root, paths, metadata: true });
	const linters = detectLinters(root, samples);
	const history = historyLimit > 0 ? safeHistory(tool, { root, config, limit: historyLimit }) : null;
	/** @type {Map<string, any[]>} */
	const byRule = new Map([...new Set(ruleIds.map(baseId))].sort().map((id) => [id, []]));
	for (const finding of findings) {
		const id = baseId(finding.ruleId);
		if (!byRule.has(id)) byRule.set(id, []);
		byRule.get(id)?.push(finding);
	}
	const rules = [...byRule].map(([id, sites]) => {
		const metadata = sites[0]?.metadata ?? {};
		const tests = sites.filter((site) => isTestFile(site.file)).length;
		/** @type {Map<string, number>} */
		const perFile = new Map();
		for (const site of sites) perFile.set(site.file, (perFile.get(site.file) ?? 0) + 1);
		const { enforcedBy, unknown } = overlapOf(metadata.overlap, linters);
		const precision = metadata.precision ?? "";
		const fixes = history && "rules" in history ? history.rules[id] ?? history.rules[`${id}-tsx`] ?? null : null;
		return {
			id, family: metadata.family ?? "", precision, sites: sites.length, source: sites.length - tests, tests,
			topFiles: [...perFile].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([file, n]) => ({ file, n })),
			samples: spread(sites, sampleCount).map((site) => `${site.file}:${site.range.start.line + 1}: ${site.lines.replace(/\s+/g, " ").trim().slice(0, 160)}`),
			fixes, enforcedBy, overlapUnknown: unknown, overlapNote: metadata.overlapNote ?? "",
			verdict: verdict({ sites: sites.length, precision, enforcedBy }),
		};
	});
	const data = { astGrep: tool.version, root, paths, linters: linters.map(({ name, config: file, enforced, note }) => ({ name, config: file, readable: Boolean(enforced), note })),
		history: history ? { commits: history.commits, withFoundBy: history.withFoundBy, error: "error" in history ? history.error : undefined } : null, rules };
	return { data, markdown: formatMeasure(data) };
}

/** @param {{ command: string, args: string[] }} tool @param {{ root: string, config: string, limit: number }} options */
function safeHistory(tool, options) {
	try {
		return mineHistory(tool, options);
	} catch (error) {
		// No git history is a normal case (a fresh export); the table still has the site counts.
		return { commits: 0, withFoundBy: 0, rules: {}, error: error instanceof Error ? error.message : String(error) };
	}
}

/** @param {any} data */
export function formatMeasure(data) {
	const lines = [`# Slop measure (ast-grep ${data.astGrep})`, ""];
	lines.push(data.linters.length
		? `Linters: ${data.linters.map((/** @type {any} */ l) => `${l.name} (${l.config}${l.readable ? ", rule state read" : `, ${l.note || "rule state unknown"}`})`).join("; ")}.`
		: "Linters: none configured, so no catalog rule is enforced already.");
	if (data.history) {
		lines.push(data.history.error ? `History: not read (${data.history.error}).`
			: `History: ${data.history.commits} fix commits scanned before and after; ${data.history.withFoundBy} carry a Found-by trailer.`);
	}
	lines.push("", "| Rule | Family | Precision | Sites | Source | Tests | Fixes that removed sites | Fixes that added sites | Linter | Verdict |",
		"| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- |");
	for (const rule of data.rules) {
		const removed = rule.fixes?.fixesRemoving ? `${rule.fixes.fixesRemoving} (${Object.entries(rule.fixes.removingFoundBy).map(([k, v]) => `${k} ${v}`).join(", ")})` : "0";
		const linter = rule.enforcedBy.length ? rule.enforcedBy.join("; ") : rule.overlapUnknown.length ? `maybe: ${rule.overlapUnknown.join("; ")}` : "";
		lines.push(`| ${rule.id} | ${rule.family} | ${rule.precision} | ${rule.sites} | ${rule.source} | ${rule.tests} | ${removed} | ${rule.fixes?.fixesAdding ?? 0} | ${linter} | ${rule.verdict} |`);
	}
	lines.push("", "## Samples and top files", "");
	for (const rule of data.rules.filter((/** @type {any} */ r) => r.sites)) {
		lines.push(`### ${rule.id} (${rule.sites})`, "", `Top files: ${rule.topFiles.map((/** @type {any} */ f) => `${f.file} (${f.n})`).join(", ")}`, "");
		for (const sample of rule.samples) lines.push(`- \`${sample.replace(/`/g, "'")}\``);
		if (rule.fixes?.examples.length) lines.push(`- Fixes that removed sites: ${rule.fixes.examples.join("; ")}`);
		if (rule.overlapNote) lines.push(`- Linter note: ${rule.overlapNote}`);
		lines.push("");
	}
	return lines.join("\n");
}
