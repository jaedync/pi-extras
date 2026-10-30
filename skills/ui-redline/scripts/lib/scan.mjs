/**
 * `redline scan`: a line-by-line search of source files for the same signs,
 * for screens that cannot be rendered yet, and to find the source line of a
 * rendered finding. It reads Tailwind classes and plain CSS; it cannot see
 * computed values, so the rendered audit stays the measure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { hex, hueSpread, isChromatic, oklch } from "./color.mjs";
import { emojiIn } from "./rules/util.mjs";

const EXTENSIONS = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".vue", ".svelte", ".astro", ".mdx"]);
const MARKUP = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".mdx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "out", "coverage", "vendor", ".svelte-kit", ".turbo", ".cache", ".output"]);
const MAX_BYTES = 512 * 1024;
const MAX_FILES = 5000;
const TW_HUES = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/** Hex and rgb() colors on a line, as [r, g, b, a]. Other color syntaxes are skipped. */
export function colorsIn(line) {
	const out = [];
	for (const m of line.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
		const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
		out.push([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]);
	}
	for (const m of line.matchAll(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/gi)) out.push([+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]);
	return out;
}

/** The values of CSS declarations on a line whose property matches `property`. */
export function declarations(line, property) {
	return [...line.matchAll(new RegExp(`(?:^|[;{\\s])(?:${property})\\s*:\\s*([^;}]+)`, "g"))].map((m) => m[1]);
}

// The same allowance as the audit's off-grid rule: 1, 2, 6 and 10px pass.
const offGrid = (v, grid = 4) => ![1, 2, 6, 10].includes(v) && v > 0 && Math.abs(v / grid - Math.round(v / grid)) * grid > 0.25;
const chromatic = (line) => colorsIn(line).filter((c) => c[3] >= 0.15 && isChromatic(c));

export const SCAN_RULES = [
	{ id: "hue-gradient", severity: "high", title: "Gradient between hues", test: (line) => {
		if (/\b(bg-gradient-to-|bg-linear-|bg-radial|bg-conic)/.test(line)) {
			const hues = new Set([...line.matchAll(new RegExp(`\\b(?:from|via|to)-(${TW_HUES})-\\d{2,3}`, "g"))].map((m) => m[1]));
			if (hues.size >= 2) return [...hues].join(" → ");
		}
		for (const value of declarations(line, "background|background-image")) {
			if (!/(linear|radial|conic)-gradient\(/.test(value)) continue;
			const stops = chromatic(value);
			if (stops.length >= 2 && hueSpread(stops.map((c) => oklch(c).h)) >= 30) return stops.map(hex).join(" → ");
		}
		return null;
	} },
	{ id: "gradient-text", severity: "high", title: "Gradient text", test: (line) => (/\bbg-clip-text\b/.test(line) && /\btext-transparent\b/.test(line)) || /background-clip\s*:\s*text/.test(line) ? "" : null },
	{ id: "colored-glow", severity: "high", title: "Colored glow", test: (line) => {
		if (/\b(?:drop-)?shadow-\[0_0_/.test(line) || new RegExp(`\\bshadow-(${TW_HUES})-\\d{2,3}`).test(line)) return "";
		for (const value of declarations(line, "box-shadow|text-shadow|filter")) {
			if (/\b0(px)?\s+0(px)?\s+([6-9]|\d{2,})px/.test(value) && chromatic(value).length) return chromatic(value).map(hex).join(", ");
		}
		return null;
	} },
	{ id: "color-wash", severity: "medium", title: "Large blur (blob or wash)", test: (line) => (/\bblur-(2xl|3xl)\b/.test(line) || /filter\s*:\s*blur\((1[6-9]|[2-9]\d|\d{3,})px/.test(line) ? "" : null) },
	{ id: "tracked-caps", severity: "medium", title: "Uppercase with wide tracking", test: (line) => {
		if (/\buppercase\b/.test(line) && /\btracking-(wide|wider|widest|\[)/.test(line)) return "";
		const caps = declarations(line, "text-transform").some((v) => /uppercase/.test(v));
		const wide = declarations(line, "letter-spacing").some((v) => (/em/.test(v) ? parseFloat(v) >= 0.05 : parseFloat(v) >= 1));
		return caps && wide ? "" : null;
	} },
	{ id: "heavy-weight", severity: "medium", title: "Weight 800 or 900", test: (line) => (/\bfont-(extrabold|black)\b/.test(line) || /font-weight\s*:\s*(800|900)\b/.test(line) ? "" : null) },
	{ id: "looping-animation", severity: "medium", title: "Animation that loops forever", test: (line) => /\banimate-(pulse|ping|bounce)\b/.exec(line)?.[0] ?? (/animation(-iteration-count)?\s*:[^;]*\binfinite\b/.test(line) ? "infinite" : null) },
	{ id: "transition-all", severity: "low", title: "transition: all", test: (line) => (/\btransition-all\b/.test(line) || /transition(-property)?\s*:\s*all\b/.test(line) ? "" : null) },
	{ id: "hover-scale", severity: "low", title: "Scale on hover", test: (line) => /\b(?:group-)?hover:-?scale-[\d[]+/.exec(line)?.[0] ?? null },
	{ id: "off-grid", severity: "medium", title: "Spacing off the 4px grid", test: (line) => {
		const tw = [...line.matchAll(/\b-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|h|w|size|top|right|bottom|left|inset(?:-[xy])?)-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => offGrid(+m[1])).map((m) => m[0]);
		const css = [...line.matchAll(/(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/g)].flatMap((m) => [...m[1].matchAll(/(\d+(?:\.\d+)?)px/g)].filter((v) => offGrid(+v[1])).map((v) => v[0]));
		const bad = [...tw, ...css];
		return bad.length ? bad.join(", ") : null;
	} },
	{ id: "emoji", severity: "high", title: "Emoji in markup", markupOnly: true, test: (line) => {
		if (/^\s*(\/\/|\/\*|\*|<!--)/.test(line)) return null;
		const found = emojiIn(line);
		return found.length ? found.join(" ") : null;
	} },
];

/** Source files under `dir`, at most MAX_FILES; folders that cannot be read are counted and skipped. */
function walk(dir, out = { files: [], unreadable: 0, more: false }) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		out.unreadable++;
		return out;
	}
	for (const entry of entries) {
		if (out.files.length >= MAX_FILES) {
			out.more = true;
			return out;
		}
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		// Dirent types do not follow symlinks, so a link loop is never entered.
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(path, out);
		} else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) out.files.push(path);
	}
	return out;
}

/** Scans one file or a folder; returns findings in the audit's shape, with file and line in each instance. */
export function scanSource(target) {
	const root = statSync(target).isDirectory() ? target : null;
	const listing = root ? walk(root) : { files: [target], unreadable: 0, more: false };
	const files = listing.files;
	const found = new Map();
	let skipped = listing.unreadable;
	for (const file of files) {
		let lines;
		try {
			if (statSync(file).size > MAX_BYTES) throw new Error("too large");
			lines = readFileSync(file, "utf8").split("\n");
		} catch {
			skipped++;
			continue;
		}
		const markup = MARKUP.has(extname(file).toLowerCase());
		lines.forEach((line, index) => {
			for (const rule of SCAN_RULES) {
				if (rule.markupOnly && !markup) continue;
				const detail = rule.test(line);
				if (detail === null) continue;
				if (!found.has(rule.id)) found.set(rule.id, { id: rule.id, severity: rule.severity, title: rule.title, instances: [] });
				found.get(rule.id).instances.push({ file: root ? relative(root, file) : file, line: index + 1, detail, code: line.trim().slice(0, 120) });
			}
		});
	}
	const findings = [...found.values()].map((f) => ({ ...f, count: f.instances.length }));
	return { files: files.length, skipped, truncated: listing.more, findings };
}

export function formatScan(result, limit = 10) {
	const lines = [`ui-redline scan: ${result.files} files${result.skipped ? `, ${result.skipped} skipped (over ${MAX_BYTES / 1024} KB, or a folder that cannot be read)` : ""}${result.truncated ? `; stopped at ${MAX_FILES} files, scan a smaller folder` : ""}`];
	if (!result.findings.length) lines.push("no findings");
	for (const f of result.findings) {
		lines.push("", `  ${f.severity.padEnd(6)} ${f.id} ×${f.count}  ${f.title}`);
		for (const inst of f.instances.slice(0, limit)) lines.push(`    ${inst.file}:${inst.line}${inst.detail ? `  ${inst.detail}` : ""}  | ${inst.code}`);
		if (f.instances.length > limit) lines.push(`    … ${f.instances.length - limit} more (use --json)`);
	}
	return lines.join("\n");
}
