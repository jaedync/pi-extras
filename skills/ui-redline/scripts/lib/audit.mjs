/**
 * The rendered audit: open the page at each viewport, collect facts, probe
 * keyboard focus, run the rules, and save audit.json with plain and redlined
 * screenshots.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectFacts, probeFocus } from "./collect.mjs";
import { numberFindings } from "./report.mjs";
import { runRules, scores } from "./rules/index.mjs";
import { launch } from "./runtime.mjs";

export const VIEWS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const MAX_SHOT_HEIGHT = 8000;
const MAX_TABS = 15;
const SEVERITY_COLOR = { high: "#e5484d", medium: "#f5a524", low: "#8e8e93" };
const FREEZE = "*,*::before,*::after{transition:none!important;animation-play-state:paused!important;caret-color:transparent!important}";

/** A URL as given, or a local file path as a file:// URL. */
export function toUrl(target) {
	if (/^(https?|file):\/\//i.test(target)) return target;
	const path = resolve(target);
	if (!existsSync(path)) throw new Error(`no such file, and not an http(s) or file URL: ${target}`);
	return pathToFileURL(path).href;
}

/** Draws numbered boxes over the findings; runs in the page. */
function drawOverlay(boxes) {
	const layer = document.createElement("redline-overlay");
	const doc = document.documentElement;
	layer.style.cssText = `all:initial;position:absolute;left:0;top:0;width:${doc.scrollWidth}px;height:${doc.scrollHeight}px;z-index:2147483647;pointer-events:none;display:block`;
	for (const box of boxes) {
		const frame = document.createElement("redline-box");
		frame.style.cssText = `all:initial;position:absolute;display:block;box-sizing:border-box;left:${box.rect.x}px;top:${box.rect.y}px;width:${box.rect.w}px;height:${box.rect.h}px;border:1.5px solid ${box.color}`;
		const tag = document.createElement("redline-tag");
		tag.textContent = box.label;
		tag.style.cssText = `all:initial;position:absolute;display:block;left:-1.5px;top:${box.rect.y >= 16 ? -16 : 0}px;padding:1px 4px;white-space:nowrap;font:600 11px/14px ui-monospace,Menlo,monospace;color:#fff;background:${box.color}`;
		frame.append(tag);
		layer.append(frame);
	}
	doc.append(layer);
}

/**
 * One box per element: the numbers of all its findings in one tag, in the
 * color of the worst one. High boxes are drawn last so they stay on top.
 */
export function overlayBoxes(findings) {
	const rank = { low: 0, medium: 1, high: 2 };
	const byRect = new Map();
	for (const f of findings) {
		for (const inst of f.instances) {
			if (!inst.rect) continue;
			const key = `${inst.rect.x},${inst.rect.y},${inst.rect.w},${inst.rect.h}`;
			const box = byRect.get(key) ?? { rect: inst.rect, numbers: [], severity: "low" };
			box.numbers.push(inst.n);
			if (rank[f.severity] > rank[box.severity]) box.severity = f.severity;
			byRect.set(key, box);
		}
	}
	return [...byRect.values()]
		.sort((a, b) => rank[a.severity] - rank[b.severity])
		.map((box) => {
			const numbers = box.numbers.sort((a, b) => a - b);
			const label = numbers.length > 4 ? `${numbers.slice(0, 4).join(",")} +${numbers.length - 4}` : numbers.join(",");
			return { rect: box.rect, label, color: SEVERITY_COLOR[box.severity] };
		});
}

async function screenshot(page, path, facts) {
	const height = Math.min(facts.page.scrollHeight, MAX_SHOT_HEIGHT);
	await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width: facts.page.viewport.w, height } });
}

async function probeKeyboardFocus(page) {
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	});
	const seen = new Map();
	for (let k = 0; k < MAX_TABS; k++) {
		await page.keyboard.press("Tab");
		const probe = await page.evaluate(probeFocus);
		if (!probe) continue;
		if (seen.has(probe.key)) break;
		seen.set(probe.key, probe);
	}
	return [...seen.values()];
}

async function auditView(browser, url, name, size, options) {
	const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: options.scheme ?? "no-preference", hasTouch: name === "mobile", isMobile: name === "mobile" });
	try {
		const page = await context.newPage();
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(options.wait ?? 400);
		const facts = await page.evaluate(collectFacts, { maxElements: options.maxElements ?? 5000 });
		facts.page.requestedWidth = size.width;
		const shot = join(options.out, `${name}.png`);
		await screenshot(page, shot, facts);
		await page.addStyleTag({ content: FREEZE });
		const focus = name === "desktop" ? await probeKeyboardFocus(page) : [];
		const findings = numberFindings(runRules(facts, { view: name, focus, config: options.config }));
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.evaluate(drawOverlay, overlayBoxes(findings));
		const redline = join(options.out, `${name}-redline.png`);
		await screenshot(page, redline, facts);
		if (options.keepFacts) writeFileSync(join(options.out, `${name}-facts.json`), JSON.stringify(facts));
		const unmeasuredText = facts.elements.filter((el) => el.text && el.effBgUnknown).length;
		return { page: facts.page, scores: scores(findings), findings, focusChecked: focus.length, unmeasuredText, files: [shot, redline] };
	} finally {
		await context.close();
	}
}

export async function runAudit({ chromium, target, out, views = ["desktop", "mobile"], sizes = {}, scheme, config = {}, wait, keepFacts = false }) {
	const url = toUrl(target);
	mkdirSync(out, { recursive: true });
	const browser = await launch(chromium);
	const result = { version: 1, tool: "ui-redline", url, at: new Date().toISOString(), scheme: scheme ?? null, views: {}, notes: [] };
	try {
		for (const name of views) {
			const size = { ...VIEWS[name], ...(sizes[name] ?? {}) };
			result.views[name] = await auditView(browser, url, name, size, { out, scheme, config, wait, keepFacts });
		}
	} finally {
		await browser.close();
	}
	const all = Object.values(result.views).flatMap((v) => v.findings);
	result.scores = scores(all);
	const desktop = result.views.desktop;
	if (desktop && desktop.focusChecked === 0) result.notes.push("Tab reached no element: the page has no keyboard-focusable controls, or focus is trapped. Check by hand.");
	const unknown = Object.values(result.views).some((v) => v.page.truncated);
	if (unknown) result.notes.push("The element limit was reached; findings cover the first 5000 elements only.");
	const overImages = Object.values(result.views).reduce((n, v) => n + (v.unmeasuredText ?? 0), 0);
	if (overImages) result.notes.push(`${overImages} text element(s) sit on a background image, so their contrast was not measured; check them by eye in the screenshots.`);
	writeFileSync(join(out, "audit.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}
