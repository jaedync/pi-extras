/**
 * The page checks of wv check (--page): the built film page is seeked to
 * settled times in every shot, and what it paints is checked against rules
 * that hold whatever the taste:
 *
 * - color: a painted colour that is not in the product's tokens and not a
 *   neutral grey. A film made from the product's CSS has no colour from nowhere.
 * - text_small: text under 30 px at 1080p (the phone sheet is 480 px wide,
 *   so that is about 8 px there). A shot with `smallText: true` is exempt
 *   (an establishing shot of the real app).
 * - text_cut: text that runs out of the frame.
 * - private: an e-mail address, a local or private address, a key or a home
 *   path in the film's text or its source.
 *
 * A text defect counts only when it shows in two samples of a shot, so a word
 * that pops in or slides through the edge is not one. Text inside captured
 * footage is pixels, not page text: wv capture records the app's text boxes at
 * each settle (events.json "texts"), and a clip with <clip>.events.json beside
 * it gets the same 30 px floor at the size the film draws it.
 *
 * Advice (not a defect): a shot's `subject` (a selector on the film page, or
 * a box in clip pixels) under 5 % of the frame width at its largest. The
 * film2 flyer was about 25 px wide (1.3 %) in the climax, 6 px on a phone;
 * all three critics named it. A small subject can be the point (a wide shot,
 * a scale reveal) and the box is the author's own measure, so it advises.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser, trackBrowser } from "../lib/browser.mjs";
import { loadPlaywright } from "../lib/runtime.mjs";
import { parseColor, toHex } from "./tokens.mjs";

/** The smallest text at a 1080 px high frame; it scales with the frame height. */
export const MIN_TEXT_PX = 30;
/** Colour steps (0 to 255 per channel) that still count as the same colour. */
const COLOR_SLACK = 10;
/** A colour whose channels differ by at most this is a grey. */
const NEUTRAL_SPREAD = 8;

/** A subject under this share of the frame width is a speck on a phone. */
export const SUBJECT_MIN_SHARE = 0.05;
/** The width of the phone sheet: what a frame shrinks to on a phone. */
const PHONE_PX = 480;

/**
 * Where to measure a shot's subject, in film seconds: each { t, box } of
 * subject.boxes (t in seconds from the shot start, box [x, y, w, h] in clip
 * pixels), or five times in the shot for one box or a selector.
 */
export function subjectSamples(shot) {
	const subject = shot.params?.subject;
	if (subject === undefined || subject === null) return [];
	const d = shot.end - shot.start;
	const spread = (fields) => [0.1, 0.3, 0.5, 0.7, 0.9].map((q) => ({ shot: shot.id, t: Number((shot.start + q * d).toFixed(4)), ...fields }));
	if (typeof subject === "string") return spread({ selector: subject, box: null });
	if (Array.isArray(subject.boxes)) return subject.boxes.map((b) => ({ shot: shot.id, t: Number((shot.start + Number(b.t)).toFixed(4)), box: b.box, selector: null }));
	if (Array.isArray(subject.box)) return spread({ box: subject.box, selector: null });
	return [];
}

/** A box in clip pixels on screen: scaled by the clip's drawn width, cut to the visible part. */
export function subjectOnScreen(box, view, videoWidth) {
	const k = view.content.w / videoWidth;
	const [bx, by, bw, bh] = box;
	const x0 = Math.max(view.content.x + bx * k, view.visible.x);
	const y0 = Math.max(view.content.y + by * k, view.visible.y);
	const x1 = Math.min(view.content.x + (bx + bw) * k, view.visible.x + view.visible.w);
	const y1 = Math.min(view.content.y + (by + bh) * k, view.visible.y + view.visible.h);
	return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** One advice line per shot whose subject is under the share at its largest. Facts: { shot, t, w } in frame px. */
export function subjectAdvice(facts, sb, minShare = SUBJECT_MIN_SHARE) {
	const out = [];
	for (const shot of sb.shots) {
		const mine = facts.filter((f) => f.shot === shot.id);
		if (!mine.length) continue;
		const best = mine.reduce((a, b) => (b.w > a.w ? b : a));
		const share = best.w / sb.width;
		if (share >= minShare) continue;
		out.push({
			kind: "subject",
			shot: shot.id,
			message: `shot "${shot.id}": the subject is at most ${Math.round(best.w)} px wide (${(share * 100).toFixed(1)} % of the frame width) at shot time ${(best.t - shot.start).toFixed(2)} s; on a phone (${PHONE_PX} px) that is ${Math.round((best.w * PHONE_PX) / sb.width)} px`,
			fix: `frame tighter on it, capture closer (a nearer camera, a larger model), or rebuild it large; under ${Math.round(minShare * 100)} % of the frame it is a speck on a phone. If the small size is the point (a wide shot, a scale reveal), say so in the shot's what line`,
		});
	}
	return out;
}

/** The pixel width of each clip: the capture viewport times its scale (events.json), else ffprobe. */
async function clipWidth(base, src) {
	const eventsFile = join(base, src.replace(/\.[^./]+$/, "") + ".events.json");
	if (existsSync(eventsFile)) {
		const v = JSON.parse(readFileSync(eventsFile, "utf8")).viewport;
		if (v?.width) return { width: v.width * (v.scale ?? 1), height: v.height * (v.scale ?? 1) };
	}
	if (!existsSync(join(base, src))) return null;
	const { probeVideo } = await import("./frames.mjs");
	const info = probeVideo(join(base, src));
	return { width: info.width, height: info.height };
}

/**
 * Measures each shot's subject in an open film page: seeks to each sample and
 * reads the subject's visible width in frame pixels. `base` is the page's folder.
 */
export async function measureSubjects(tab, sb, base, notes = []) {
	const facts = [];
	for (const shot of sb.shots) {
		const samples = subjectSamples(shot);
		if (!samples.length) continue;
		const src = shot.params?.clip?.src;
		const size = samples[0].box && typeof src === "string" ? await clipWidth(base, src) : null;
		if (samples[0].box && !size) {
			notes.push(`shot ${shot.id}: its subject is a box in clip pixels, but the shot has no clip (or its size is not known), so it was not measured`);
			continue;
		}
		for (const s of samples) {
			await tab.evaluate((t) => {
				/** @type {any} */ (window).__timelines.main.seek(t, false);
			}, s.t);
			let w = 0;
			if (s.selector) {
				w = await tab.evaluate((sel) => {
					let best = 0;
					for (const el of document.querySelectorAll(sel)) {
						const r = el.getBoundingClientRect();
						best = Math.max(best, Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)));
					}
					return best;
				}, s.selector);
			} else {
				const view = await tab.evaluate(clipView, { id: `clip-${shot.id}`, aspect: size.width / size.height });
				if (view) w = subjectOnScreen(s.box, view, size.width).w;
			}
			facts.push({ shot: shot.id, t: s.t, w });
		}
	}
	return facts;
}

/** Settled times in each shot: 40, 60 and 80 % in, and the last frame. */
export function sampleTimes(sb) {
	const out = [];
	for (const shot of sb.shots) {
		const n = shot.endFrame - shot.startFrame;
		const frames = [0.4, 0.6, 0.8].map((q) => shot.startFrame + Math.round(n * q));
		frames.push(shot.endFrame - 1);
		for (const f of [...new Set(frames)]) out.push({ shot: shot.id, t: Number((f / sb.fps).toFixed(4)) });
	}
	return out;
}

/** Every colour in the tokens: the palette, the roles, the inks on each ground and the literal colours. */
export function brandColors(tokens) {
	const out = new Set();
	const add = (c) => {
		const hex = toHex(c);
		if (hex) out.add(hex.slice(0, 7));
	};
	for (const value of Object.values(tokens?.palette ?? {})) add(value);
	for (const role of [tokens?.ground, tokens?.ink, tokens?.accent, ...(tokens?.inkSecondary ?? []), ...(tokens?.surfaces ?? [])]) if (role?.color) add(role.color);
	for (const [ground, inks] of Object.entries(tokens?.inksByGround ?? {})) {
		add(ground);
		for (const ink of inks) add(ink.color);
	}
	for (const literal of tokens?.literals ?? []) add(literal.value);
	return [...out];
}

/** True when a solid colour is neither a brand colour (within a few steps) nor a grey. */
export function offBrand(color, palette) {
	const c = parseColor(color);
	if (!c || c.a < 0.5) return false;
	if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= NEUTRAL_SPREAD) return false;
	return !palette.some((hex) => {
		const p = parseColor(hex);
		return p && Math.abs(p.r - c.r) <= COLOR_SLACK && Math.abs(p.g - c.g) <= COLOR_SLACK && Math.abs(p.b - c.b) <= COLOR_SLACK;
	});
}

/** A long lowercase hex run: a content hash, a git SHA or a key. Only a key word makes it secret. */
const HASH_LIKE = /\b[0-9a-f]{32,}\b/g;
const SECRET_CONTEXT = /\b(?:key|keys|token|tokens|secret|secrets|password|passwd|bearer|credential)s?\b/i;

/** @type {[string, RegExp][]} */
const PRIVATE = [
	["local address", /\b(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::\d{2,5})?\b/gi],
	["private IP", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/g],
	["email", /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g],
	["secret", /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/gi],
	["home path", /(?:\/home\/[a-z_][\w-]*|\/Users\/[A-Za-z][\w-]*|[A-Z]:\\Users\\[\w-]+)/g],
];

/**
 * Private data in a text: [{kind, match}]. `hashes: false` drops the hash rule,
 * for a minified bundle and for film data, where a content hash or a git SHA is
 * a public value and not a key.
 */
export function privateFindings(text, { hashes = true } = {}) {
	const s = String(text);
	const found = [];
	for (const [kind, re] of PRIVATE) for (const m of s.matchAll(re)) found.push({ kind, match: m[0] });
	if (hashes)
		for (const m of s.matchAll(HASH_LIKE)) {
			const around = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
			if (SECRET_CONTEXT.test(around)) found.push({ kind: "secret", match: m[0] });
		}
	return found;
}

/**
 * The private data in a clip's own text snapshots, inside the part of the clip
 * that its shot shows. A local URL or an e-mail in the recorded app is on
 * screen even when the recreated page is clean, so the page check reads the
 * capture's `texts` too. Returns [{kind, match, shot, frame, message}].
 */
export function clipPrivateFindings(clip, shot, filmFps) {
	const fromFrame = Math.round(clip.from * clip.fps);
	const toFrame = fromFrame + Math.round((shot.end - shot.start) * clip.fps);
	const found = [];
	for (const snap of clip.texts ?? []) {
		if (snap.f < fromFrame || snap.f > toFrame) continue;
		for (const item of snap.items ?? []) {
			for (const f of privateFindings(item?.text ?? "")) {
				const t = clip.start + (snap.f / clip.fps - clip.from);
				found.push({ ...f, shot: shot.id, frame: Math.max(Math.round(shot.start * filmFps), Math.round(t * filmFps)), t });
			}
		}
	}
	return found.map((f) => ({ ...f, message: `shot ${f.shot}: the captured clip has ${f.kind} "${f.match}" at ${f.t.toFixed(2)} s, so it is on screen`, fix: "re-capture the clip without it (a made-up host, a public URL, a fake mailbox), or cut that part out of the shot" }));
}

/**
 * The capture's text at a film time: the last snapshot at or before the clip
 * frame that the film shows then. Null when the capture has none.
 * @param {{f: number, items: any[]}[]} texts
 */
export function textAt(texts, { t, shotStart, from = 0, fps }) {
	const frame = Math.round((from + Math.max(0, t - shotStart)) * fps);
	let found = null;
	for (const snap of texts ?? []) if (snap.f <= frame && (!found || snap.f >= found.f)) found = snap;
	return found;
}

/**
 * Capture text boxes (CSS px of the capture viewport) on screen: the clip's
 * content box on screen sets the scale, so a push in makes the same label
 * larger. Text that is mostly outside the visible part (the crop, the frame)
 * is not on screen and is left out.
 */
export function clipTextFacts(items, { view, capture, shot, t }) {
	const k = view.content.w / capture.width;
	const v = view.visible;
	const out = [];
	for (const item of items) {
		const rect = { x: view.content.x + item.rect.x * k, y: view.content.y + item.rect.y * k, w: item.rect.w * k, h: item.rect.h * k };
		const iw = Math.max(0, Math.min(rect.x + rect.w, v.x + v.w) - Math.max(rect.x, v.x));
		const ih = Math.max(0, Math.min(rect.y + rect.h, v.y + v.h) - Math.max(rect.y, v.y));
		if (rect.w <= 0 || rect.h <= 0 || iw * ih < 0.5 * rect.w * rect.h) continue;
		const round = (n) => Math.round(n * 10) / 10;
		out.push({ text: item.text, selector: item.selector ?? "clip", px: round(item.px * k), color: null, rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }, source: "clip", shot, t });
	}
	return out;
}

/** Text facts to defects: small or cut text that shows in at least two samples of a shot. */
export function textDefects(facts, { frame, sb }) {
	const minPx = (MIN_TEXT_PX * frame.height) / 1080;
	const exempt = new Set(sb.shots.filter((s) => s.params?.smallText === true).map((s) => s.id));
	const groups = new Map();
	const note = (kind, f) => {
		const key = `${kind}|${f.shot}|${f.selector}|${f.text}`;
		if (!groups.has(key)) groups.set(key, { kind, shot: f.shot, items: [] });
		groups.get(key).items.push(f);
	};
	for (const f of facts) {
		if (f.px < minPx && !exempt.has(f.shot)) note("text_small", f);
		const r = f.rect;
		// A clip's crop and push cut its text on purpose; only its size counts.
		if (f.source === "clip") continue;
		if (r.x < -2 || r.y < -2 || r.x + r.w > frame.width + 2 || r.y + r.h > frame.height + 2) note("text_cut", f);
	}
	const defects = [];
	/** Small clip text by shot: an app view has many labels and one fix, so it is one defect. */
	const clipSmall = new Map();
	for (const g of groups.values()) {
		if (new Set(g.items.map((f) => f.t)).size < 2) continue;
		const f = g.items[0];
		const frameNo = Math.round(f.t * sb.fps);
		const px = Math.round(Math.min(...g.items.map((i) => i.px)));
		if (g.kind === "text_small" && f.source === "clip") {
			if (!clipSmall.has(g.shot)) clipSmall.set(g.shot, []);
			clipSmall.get(g.shot).push({ text: f.text, px, frame: frameNo, rect: f.rect });
		} else if (g.kind === "text_small")
			defects.push({ kind: "text_small", shot: g.shot, frame: frameNo, message: `shot ${g.shot}: "${f.text}" is ${px} px on screen; text under ${Math.round(minPx)} px does not read on a phone`, fix: "make it larger or scale its container up, cut it, or mark an establishing shot smallText: true" });
		else defects.push({ kind: "text_cut", shot: g.shot, frame: frameNo, message: `shot ${g.shot}: "${f.text}" runs out of the frame at ${f.t} s`, fix: "keep text inside the frame (with a margin) once it has arrived" });
	}
	for (const [shot, list] of clipSmall) {
		const sorted = [...list].sort((a, b) => a.px - b.px);
		const named = sorted.slice(0, 5).map((i) => `"${i.text}" ${i.px} px`).join(", ");
		// The push that the smallest label needs, about the frame centre; a HUD at the edge leaves the frame.
		const need = minPx / sorted[0].px;
		const r = sorted[0].rect;
		const cx = frame.width / 2;
		const cy = frame.height / 2;
		const crops = r && (cx + (r.x - cx) * need < 0 || cx + (r.x + r.w - cx) * need > frame.width || cy + (r.y - cy) * need < 0 || cy + (r.y + r.h - cy) * need > frame.height);
		const scale = `the smallest needs ${(Math.ceil(need * 100) / 100).toFixed(2)}x on screen`;
		const fix = crops
			? `${scale}, and a push that large would crop it (it sits at the frame edge, like a HUD): raise the app's label size with CSS in the flow (wv.page.addInitScript with a style that sets its font-size, references/capture.md) and capture again; or rebuild this view from the app's markup at 2.5x, or mark an establishing shot smallText: true`
			: `${scale}: frame tighter or push more on the part that matters, rebuild this view from the app's markup at 2.5x, or mark an establishing shot smallText: true`;
		defects.push({ kind: "text_small", shot, frame: Math.min(...list.map((i) => i.frame)), message: `shot ${shot}: ${list.length === 1 ? "1 text in the captured clip is" : `${list.length} texts in the captured clip are`} under ${Math.round(minPx)} px on screen: ${named}${list.length > 5 ? ", ..." : ""}; they do not read on a phone`, fix });
	}
	return defects.sort((a, b) => a.frame - b.frame);
}

/** Runs in the page: the visible text with its on-screen size and box, and the solid colours painted. */
function collectFrame() {
	const W = innerWidth;
	const H = innerHeight;
	const opacity = (el) => {
		let o = 1;
		for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
		return o;
	};
	const shown = (el) => el.checkVisibility({ visibilityProperty: true }) && opacity(el) >= 0.5;
	const sel = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("")}`;
	const texts = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent.replace(/\s+/g, " ").trim();
		const el = node.parentElement;
		if (!text || !el || el.closest("script,style") || !shown(el)) continue;
		const range = document.createRange();
		range.selectNodeContents(node);
		const r = range.getBoundingClientRect();
		if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue;
		const box = el.getBoundingClientRect();
		const scale = el instanceof HTMLElement && el.offsetHeight > 0 ? box.height / el.offsetHeight : 1;
		texts.push({ text: text.slice(0, 60), selector: sel(el), px: parseFloat(getComputedStyle(el).fontSize) * scale, color: getComputedStyle(el).color, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
	}
	const colors = [];
	for (const el of document.body.querySelectorAll("*")) {
		if (el.closest("script,style") || !shown(el)) continue;
		const r = el.getBoundingClientRect();
		const area = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
		if (area < 400) continue;
		const bg = getComputedStyle(el).backgroundColor;
		if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") colors.push({ color: bg, selector: sel(el), use: "background" });
	}
	for (const t of texts) colors.push({ color: t.color, selector: t.selector, use: "text" });
	return { texts, colors, bodyText: document.body.innerText };
}

/**
 * Runs in the page: where the shot's clip draws on screen. `content` is the
 * whole video picture after object-fit (centred) and the camera's transforms;
 * `visible` is the part that the frame and every clipping parent let through.
 */
export function clipView({ id, aspect }) {
	const video = document.getElementById(id);
	if (!video || !video.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
	const box = video.getBoundingClientRect();
	if (box.width < 1 || box.height < 1) return null;
	const fit = getComputedStyle(video).objectFit;
	let w = box.width;
	let h = box.height;
	if (fit === "contain" || fit === "cover" || fit === "scale-down") {
		const wide = box.width / box.height > aspect;
		if ((fit === "cover") === wide) h = w / aspect;
		else w = h * aspect;
	}
	const content = { x: box.left + (box.width - w) / 2, y: box.top + (box.height - h) / 2, w, h };
	let v = { x0: Math.max(0, box.left), y0: Math.max(0, box.top), x1: Math.min(innerWidth, box.right), y1: Math.min(innerHeight, box.bottom) };
	for (let el = video.parentElement; el && el !== document.body; el = el.parentElement) {
		const style = getComputedStyle(el);
		if (style.overflowX === "visible" && style.overflowY === "visible" && style.clipPath === "none") continue;
		const r = el.getBoundingClientRect();
		v = { x0: Math.max(v.x0, r.left), y0: Math.max(v.y0, r.top), x1: Math.min(v.x1, r.right), y1: Math.min(v.y1, r.bottom) };
	}
	return { content, visible: { x: v.x0, y: v.y0, w: Math.max(0, v.x1 - v.x0), h: Math.max(0, v.y1 - v.y0) } };
}

/** The capture's text snapshots of each clip shot: out/<clip>.events.json beside the clip. */
function clipTexts(file, sb, notes) {
	const out = new Map();
	for (const shot of sb.shots) {
		const src = shot.params?.clip?.src;
		if (typeof src !== "string") continue;
		const eventsFile = join(dirname(file), src.replace(/\.[^./]+$/, "") + ".events.json");
		const events = existsSync(eventsFile) ? JSON.parse(readFileSync(eventsFile, "utf8")) : null;
		if (!events?.texts?.length) {
			notes.push(`shot ${shot.id}: the text in its clip was not checked; copy the capture's events.json beside the clip as ${src.replace(/\.[^./]+$/, "")}.events.json (a capture from before this check has no text, so capture it again)`);
			continue;
		}
		out.set(shot.id, { texts: events.texts, fps: events.fps, capture: { width: events.viewport.width, height: events.viewport.height }, from: Number(shot.params.clip.from ?? 0), start: shot.start });
	}
	return out;
}

/** Opens the built page, samples every shot and returns the page defects. */
export async function pageDefects({ page, tokens = null, storyboard: sb, log = (_line) => {}, notes = [], advice = [] }) {
	const file = resolve(page);
	if (!existsSync(file)) throw new Error(`the page ${file} does not exist; build it with wv film build`);
	const tokensFile = tokens ? resolve(tokens) : join(dirname(file), "brand", "tokens.json");
	const palette = existsSync(tokensFile) ? brandColors(JSON.parse(readFileSync(tokensFile, "utf8"))) : null;
	const frame = { width: sb.width, height: sb.height };
	const { chromium } = await loadPlaywright();
	const browser = await launchBrowser(chromium);
	const untrack = trackBrowser(browser);
	const facts = [];
	const colorHits = new Map();
	const defects = [];
	try {
		const tab = await browser.newPage({ viewport: frame });
		await tab.goto(pathToFileURL(file).href, { waitUntil: "load" });
		await tab.waitForFunction(() => Boolean(/** @type {any} */ (window).__timelines?.main), null, { timeout: 15000 });
		await tab.evaluate(() => document.fonts.ready);
		const samples = sampleTimes(sb);
		const clips = clipTexts(file, sb, notes);
		const visible = [];
		/** A value that one check already reported is not reported again. */
		const seen = new Set();
		for (const s of samples) {
			await tab.evaluate((t) => {
				/** @type {any} */ (window).__timelines.main.seek(t, false);
			}, s.t);
			const got = await tab.evaluate(collectFrame);
			for (const t of got.texts) facts.push({ ...t, shot: s.shot, t: s.t });
			const clip = clips.get(s.shot);
			const snap = clip && textAt(clip.texts, { t: s.t, shotStart: clip.start, from: clip.from, fps: clip.fps });
			const view = snap && (await tab.evaluate(clipView, { id: `clip-${s.shot}`, aspect: clip.capture.width / clip.capture.height }));
			if (view) facts.push(...clipTextFacts(snap.items, { view, capture: clip.capture, shot: s.shot, t: s.t }));
			visible.push({ shot: s.shot, t: s.t, text: got.bodyText });
			if (palette)
				for (const c of got.colors) {
					if (!offBrand(c.color, palette)) continue;
					const key = `${s.shot}|${toHex(c.color)}`;
					if (!colorHits.has(key)) colorHits.set(key, { ...c, shot: s.shot, times: new Set() });
					colorHits.get(key).times.add(s.t);
				}
		}
		log(`page: ${samples.length} samples, ${facts.length} text facts`);
		// The clip's own snapshots: a local URL or an e-mail in the recorded app is on screen too.
		for (const shot of sb.shots) {
			const clip = clips.get(shot.id);
			if (!clip) continue;
			for (const f of clipPrivateFindings(clip, shot, sb.fps)) {
				if (seen.has(f.match)) continue;
				seen.add(f.match);
				defects.push({ kind: "private", shot: f.shot, frame: f.frame, message: f.message, fix: f.fix });
			}
		}
		advice.push(...subjectAdvice(await measureSubjects(tab, sb, dirname(file), notes), sb));
		defects.push(...textDefects(facts, { frame, sb }));
		for (const hit of colorHits.values()) {
			if (hit.times.size < 2) continue;
			const t = Math.min(...hit.times);
			defects.push({ kind: "color", shot: hit.shot, frame: Math.round(t * sb.fps), message: `shot ${hit.shot}: ${toHex(hit.color)} (${hit.use} of ${hit.selector}) is not in the product's tokens`, fix: "use a colour from brand/tokens.json (wv lift), or lift the app state that has it" });
		}
		if (!palette) log(`page: no tokens at ${tokensFile}, so the colour check is skipped`);
		for (const v of visible)
			for (const f of privateFindings(v.text)) {
				if (seen.has(f.match)) continue;
				seen.add(f.match);
				defects.push({ kind: "private", shot: v.shot, frame: Math.round(v.t * sb.fps), message: `shot ${v.shot}: ${f.kind} "${f.match}" is on screen`, fix: "replace it with a public or made-up value before the film is shared" });
			}
		// The source can carry what the screen does not show (film data, clip paths).
		const source = readFileSync(file, "utf8").replace(/<script src[^>]*><\/script>/g, "");
		// The bundle and the film data are minified: a content hash there is public, so no hash rule.
		for (const m of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
			for (const f of privateFindings(m[1], { hashes: false })) {
				if (seen.has(f.match)) continue;
				seen.add(f.match);
				defects.push({ kind: "private", shot: null, frame: 0, message: `the built bundle has ${f.kind} "${f.match}"`, fix: "remove it from a scene module or a storyboard field" });
			}
		}
		for (const f of privateFindings(source.replace(/<script>[\s\S]*?<\/script>/g, ""))) {
			if (seen.has(f.match)) continue;
			seen.add(f.match);
			defects.push({ kind: "private", shot: null, frame: 0, message: `the page source has ${f.kind} "${f.match}"`, fix: "remove it from the storyboard, the scenes or the assets paths" });
		}
	} finally {
		untrack();
		await browser.close().catch(() => {});
	}
	return defects;
}
