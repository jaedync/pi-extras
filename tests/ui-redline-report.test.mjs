import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { overlayBoxes, toUrl } from "../skills/ui-redline/scripts/lib/audit.mjs";
import { compareAudits, formatAudit, formatCompare, numberFindings } from "../skills/ui-redline/scripts/lib/report.mjs";
import { declarations, scanSource } from "../skills/ui-redline/scripts/lib/scan.mjs";
import { parseArgs } from "../skills/ui-redline/scripts/redline.mjs";
import { RULES } from "../skills/ui-redline/scripts/lib/rules/index.mjs";

const SKILL = new URL("../skills/ui-redline/", import.meta.url);

test("the README names the rule count, and every rule and linked reference is documented", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.ok(readme.includes(`${RULES.length} rules`), `the README says ${RULES.length} rules`);
	const signs = readFileSync(new URL("references/signs.md", SKILL), "utf8");
	for (const rule of RULES) assert.ok(signs.includes(`\`${rule.id}\``), `references/signs.md documents ${rule.id}`);
	const skill = readFileSync(new URL("SKILL.md", SKILL), "utf8");
	for (const [, link] of skill.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(existsSync(new URL(link, SKILL)), `${link} exists`);
});

const rect = { x: 10, y: 20, w: 100, h: 30 };
const finding = (id, severity, count, category = "color", view = "desktop") => ({ id, view, severity, category, title: id, fix: "fix it", count, instances: Array.from({ length: count }, () => ({ sel: "div", text: "", rect, detail: "" })) });
const audit = (findings) => ({ url: "file:///x.html", views: { desktop: { page: { viewport: { w: 1440, h: 900 } }, scores: { slop: 50, craft: 50 }, findings } } });

test("numberFindings puts high first and numbers every instance once", () => {
	const numbered = numberFindings([finding("a", "low", 1), finding("b", "high", 2), finding("c", "medium", 1)]);
	assert.deepEqual(numbered.map((f) => f.id), ["b", "c", "a"]);
	assert.deepEqual(numbered.flatMap((f) => f.instances.map((i) => i.n)), [1, 2, 3, 4]);
});

test("overlayBoxes merges findings on one element and colors it by the worst", () => {
	const boxes = overlayBoxes(numberFindings([finding("a", "low", 1), finding("b", "high", 1)]));
	assert.equal(boxes.length, 1);
	assert.equal(boxes[0].label, "1,2");
	assert.equal(boxes[0].color, "#e5484d");
});

test("compareAudits passes a clean after and fails on a regression or a high left", () => {
	const before = audit([finding("emoji", "high", 5), finding("off-grid", "medium", 3, "spacing")]);
	const fixed = compareAudits(before, audit([]));
	assert.equal(fixed.pass, true);
	assert.match(formatCompare(fixed), /PASS/);
	assert.match(formatCompare(fixed), /Slop 70 → 100, craft 91 → 100/);
	const worse = compareAudits(before, audit([finding("off-grid", "medium", 4, "spacing")]));
	assert.equal(worse.pass, false);
	assert.deepEqual(worse.regressions.map((r) => r.id), ["off-grid"]);
	const highLeft = compareAudits(before, audit([finding("emoji", "high", 1)]));
	assert.equal(highLeft.pass, false);
	assert.equal(highLeft.rows.find((r) => r.id === "emoji").state, "better");
	assert.equal(compareAudits(audit([]), audit([finding("greeting", "medium", 1, "copy")])).regressions[0].state, "new");
});

test("formatAudit lists findings with numbers and caps long lists", () => {
	const out = formatAudit({ ...audit(numberFindings([finding("off-grid", "medium", 12, "spacing")])), notes: ["a note"] });
	assert.match(out, /medium off-grid ×12/);
	assert.match(out, /Slop 100\/100, craft 85\/100/);
	assert.match(out, /\[1\] div 100×30 at 10,20/);
	assert.match(out, /… 4 more in audit\.json/);
	assert.match(out, /note: a note/);
});

test("toUrl keeps URLs and turns an existing path into a file URL", () => {
	assert.equal(toUrl("https://example.com/a"), "https://example.com/a");
	assert.match(toUrl(import.meta.filename), /^file:\/\//);
	assert.throws(() => toUrl("/no/such/file.html"), /no such file/);
});

test("parseArgs reads flags, values and positionals and rejects a missing value", () => {
	assert.deepEqual(parseArgs(["page.html", "--out", "o", "--json"]), { flags: { out: "o", json: true }, positional: ["page.html"] });
	assert.throws(() => parseArgs(["--out"]), /needs a value/);
});

test("scan: finds Tailwind and CSS signs with file and line, and skips node_modules", () => {
	const dir = mkdtempSync(join(tmpdir(), "redline-scan-"));
	try {
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
		writeFileSync(join(dir, "src", "Hero.tsx"), [
			'<h1 className="bg-gradient-to-r from-purple-500 to-blue-500 bg-clip-text text-transparent">Hi</h1>',
			'<div className="mt-[13px] p-4 transition-all hover:scale-105 animate-pulse">🚀 Launch</div>',
			'<p className="uppercase tracking-widest font-black">Plans</p>',
			"// 🚀 a comment is not markup",
		].join("\n"));
		writeFileSync(join(dir, "src", "app.css"), ".card { padding: 10px 16px; box-shadow: 0 0 24px rgba(168, 85, 247, 0.5); border: 1px solid #8b5cf6; }\n.ok { padding: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }\n");
		writeFileSync(join(dir, "node_modules", "x", "a.css"), ".x { transition: all 1s; }\n");
		const result = scanSource(dir);
		const byId = Object.fromEntries(result.findings.map((f) => [f.id, f]));
		for (const id of ["hue-gradient", "gradient-text", "off-grid", "transition-all", "hover-scale", "looping-animation", "emoji", "tracked-caps", "heavy-weight", "colored-glow"]) assert.ok(byId[id], `expected ${id}`);
		assert.equal(byId.emoji.count, 1, "comments are skipped");
		assert.equal(byId["transition-all"].count, 1, "node_modules is skipped");
		assert.deepEqual(byId["off-grid"].instances.map((i) => `${i.file}:${i.line}`).sort(), ["src/Hero.tsx:2", "src/app.css:1"]);
		assert.equal(byId["colored-glow"].instances[0].detail, "#a855f780", "the border color is not part of the glow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("declarations reads only the named properties of a one-line rule", () => {
	assert.deepEqual(declarations(".a { color: red; box-shadow: 0 0 4px blue; }", "box-shadow"), ["0 0 4px blue"]);
	assert.deepEqual(declarations(".a { border-color: red }", "color"), []);
});
