/**
 * The page-side instrument: a MutationObserver window around each action, the
 * quiet check (300 ms quiet, 3 s cap) and box measurements that CSS alone
 * cannot give (the caret of an input or of a contenteditable).
 *
 * Installed with page.addInitScript so it survives navigation, then called
 * through page.evaluate. Everything here runs in the page.
 */

/* The quiet window is 300 ms and the cap is 3 s, as the design sets them. */
/* eslint-disable no-undef */
function initInstrument() {
	const state = { last: 0, els: new Set(), observer: null, listeners: [] };

	const rectOf = (element) => {
		if (!(element instanceof Element)) return null;
		if (element.checkVisibility && !element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return null;
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
	};

	// A pulsing status dot or a ticking clock must not keep the page "busy": changes to boxes under
	// 32 x 32 CSS px are not activity and not part of the changed region.
	const MIN_AREA = 1024;
	const collect = (node) => {
		if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
		if (!(node instanceof Element)) return false;
		const rect = rectOf(node);
		if (!rect || rect.width * rect.height < MIN_AREA) return false;
		state.els.add(node);
		return true;
	};
	const finite = (animation) => {
		try {
			return animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity;
		} catch {
			return false;
		}
	};

	const stop = () => {
		state.observer?.disconnect();
		state.observer = null;
		for (const [type, listener] of state.listeners) document.removeEventListener(type, listener, true);
		state.listeners = [];
	};

	const api = {
		begin() {
			stop();
			state.els = new Set();
			state.last = performance.now();
			state.observer = new MutationObserver((records) => {
				let seen = false;
				for (const record of records) {
					seen = collect(record.target) || seen;
					if (record.type === "childList") for (const node of record.addedNodes) seen = collect(node) || seen;
				}
				if (seen) state.last = performance.now();
			});
			state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
			// Typing changes a value, not the DOM, so keys and input events are activity too.
			for (const type of ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel", "animationiteration", "input", "keydown", "pointerdown", "pointerup", "scroll"]) {
				const listener = (event) => {
					const user = type === "input" || type === "keydown" || type.startsWith("pointer");
					if (event.type === "animationiteration") return;
					if (collect(event.target) || user) state.last = performance.now();
				};
				document.addEventListener(type, listener, true);
				state.listeners.push([type, listener]);
			}
			return true;
		},

		/** Resolves when the DOM has been quiet for 300 ms, or at the 3 s cap. */
		settle() {
			return new Promise((resolve) => {
				const deadline = performance.now() + 3000;
				const finish = () => {
					const rects = [];
					for (const element of state.els) {
						const rect = rectOf(element);
						if (rect) rects.push(rect);
					}
					stop();
					resolve({ rects, quietMs: Math.round(performance.now() - state.last) });
				};
				const tick = () => {
					const now = performance.now();
					let running = false;
					try {
						running = document.getAnimations().some(finite);
					} catch {
						running = false;
					}
					if ((now - state.last >= 300 && !running) || now >= deadline) finish();
					else setTimeout(tick, 40);
				};
				tick();
			});
		},

		/**
		 * The box of an input's or textarea's value text. The element box of a wide field is mostly empty:
		 * the text is at the left, and a camera framed on the whole field cannot zoom to reading size.
		 * Null when the field is empty or draws no text of its own.
		 */
		valueBox(element) {
			if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") return null;
			const value = element.value ?? "";
			if (!value.trim()) return null;
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			const number = (v) => parseFloat(v) || 0;
			const fontSize = number(style.fontSize) || 16;
			const lineHeight = number(style.lineHeight) || fontSize * 1.2;
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d");
			context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const spacing = style.letterSpacing && style.letterSpacing !== "normal" ? number(style.letterSpacing) : 0;
			const widths = value.split("\n").map((line) => context.measureText(line).width + spacing * line.length);
			const left = rect.left + number(style.borderLeftWidth) + number(style.paddingLeft) - (element.scrollLeft || 0);
			const right = rect.right - number(style.borderRightWidth) - number(style.paddingRight);
			const top = rect.top + number(style.borderTopWidth) + number(style.paddingTop) - (element.scrollTop || 0);
			const bottom = rect.bottom - number(style.borderBottomWidth) - number(style.paddingBottom);
			// The text starts at the padding edge; an overflowing value is clipped at the content edge.
			const x = Math.min(Math.max(left, rect.left), Math.max(left, right));
			const width = Math.min(Math.max(...widths), Math.max(0, right - x));
			const height = Math.min(widths.length * lineHeight, Math.max(lineHeight, bottom - Math.max(top, rect.top)));
			return width > 0 && height > 0 ? { x, y: Math.max(top, rect.top), width, height } : null;
		},

		/** The box of what an element draws (its text and children), inside its own box. */
		ink(element) {
			const box = rectOf(element);
			if (!box) return null;
			const value = api.valueBox(element);
			if (value) return value;
			const range = document.createRange();
			range.selectNodeContents(element);
			const parts = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
			if (parts.length === 0) return box;
			const left = Math.max(box.x, Math.min(...parts.map((r) => r.left)));
			const top = Math.max(box.y, Math.min(...parts.map((r) => r.top)));
			const right = Math.min(box.x + box.width, Math.max(...parts.map((r) => r.right)));
			const bottom = Math.min(box.y + box.height, Math.max(...parts.map((r) => r.bottom)));
			return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : box;
		},
		rect(element) {
			return rectOf(element);
		},

		fontPx(element) {
			if (!(element instanceof Element)) return null;
			const size = parseFloat(getComputedStyle(element).fontSize);
			return Number.isFinite(size) ? size : null;
		},

		/** The caret rectangle after the last key: input/textarea by text width, else a collapsed Range. */
		caret(element) {
			if (!(element instanceof Element)) return null;
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			const fontSize = parseFloat(style.fontSize) || 16;
			const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
			const number = (value) => parseFloat(value) || 0;
			if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
				const value = element.value ?? "";
				const end = typeof element.selectionEnd === "number" ? element.selectionEnd : value.length;
				const upTo = value.slice(0, end);
				const lines = upTo.split("\n");
				const lineText = lines[lines.length - 1];
				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");
				context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
				let width = context.measureText(lineText).width;
				if (style.letterSpacing && style.letterSpacing !== "normal") width += number(style.letterSpacing) * lineText.length;
				const borderLeft = number(style.borderLeftWidth);
				const borderTop = number(style.borderTopWidth);
				const paddingLeft = number(style.paddingLeft);
				const paddingTop = number(style.paddingTop);
				const contentLeft = rect.left + borderLeft + paddingLeft - (element.scrollLeft || 0);
				const contentRight = rect.right - number(style.borderRightWidth) - number(style.paddingRight);
				const contentTop = rect.top + borderTop + paddingTop - (element.scrollTop || 0);
				const contentBottom = rect.bottom - number(style.borderBottomWidth) - number(style.paddingBottom);
				const x = Math.min(Math.max(contentLeft + width, contentLeft), contentRight);
				const y = Math.min(Math.max(contentTop + (lines.length - 1) * lineHeight, contentTop), Math.max(contentTop, contentBottom - lineHeight));
				return { x, y, width: 2, height: Math.min(lineHeight, Math.max(2, contentBottom - y)) };
			}
			const selection = document.getSelection();
			if (!selection || selection.rangeCount === 0) return null;
			const range = selection.getRangeAt(0).cloneRange();
			if (!element.contains(range.endContainer)) return null;
			range.collapse(false);
			const box = range.getBoundingClientRect();
			if (box.width === 0 && box.height === 0) return null;
			return { x: box.left, y: box.top, width: Math.max(2, box.width), height: box.height || lineHeight };
		},
	};

	window.__wv = api;
}

export async function installInstrument(page) {
	await page.addInitScript(initInstrument);
}

export function beginAction(page) {
	return page.evaluate(() => window.__wv.begin());
}

/**
 * The page-side cap can stall when the page starves its timers, so Node caps the wait too.
 * Under the virtual clock the page-side cap is in frame time, and a slow host needs longer.
 */
export const SETTLE_CAP_MS = 3300;
export function settleAction(page, capMs = SETTLE_CAP_MS) {
	let timer;
	const cap = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ rects: [], quietMs: 0, capped: true }), capMs);
	});
	return Promise.race([page.evaluate(() => window.__wv.settle()), cap]).finally(() => clearTimeout(timer));
}

// A short timeout: the element can be gone after the action (a navigation, a button that
// removes itself), and Playwright's default 30 s wait would show up as a 30 s settle.
const READ_TIMEOUT_MS = 1500;

export function caretOf(locator) {
	return locator.evaluate((element) => window.__wv.caret(element), undefined, { timeout: READ_TIMEOUT_MS });
}

export function fontPxOf(locator) {
	return locator.evaluate((element) => window.__wv.fontPx(element), undefined, { timeout: READ_TIMEOUT_MS });
}

export function inkOf(locator) {
	return locator.evaluate((element) => window.__wv.ink(element), undefined, { timeout: READ_TIMEOUT_MS });
}

export function rectOf(locator) {
	return locator.evaluate((element) => window.__wv.rect(element), undefined, { timeout: READ_TIMEOUT_MS });
}

/** Text items kept per snapshot; a page with more is a wall of text that no film shows whole. */
export const TEXTS_PER_SNAPSHOT = 300;

/**
 * The visible text of the page: each text node's words, its CSS font size
 * times its transform scale, and its box in viewport CSS px. wv check maps
 * these onto the film to apply the 30 px floor to captured clips.
 */
export function textsOf(page, limit = TEXTS_PER_SNAPSHOT) {
	return page.evaluate((max) => {
		const W = innerWidth;
		const H = innerHeight;
		const out = [];
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node && out.length < max; node = walker.nextNode()) {
			const text = node.textContent.replace(/\s+/g, " ").trim();
			const el = node.parentElement;
			if (!text || !el || el.closest("script,style,noscript")) continue;
			if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			const r = range.getBoundingClientRect();
			if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue;
			const box = el.getBoundingClientRect();
			const scale = el instanceof HTMLElement && el.offsetHeight > 0 ? box.height / el.offsetHeight : 1;
			const round = (n) => Math.round(n * 10) / 10;
			out.push({ text: text.slice(0, 60), selector: el.tagName.toLowerCase(), px: round(parseFloat(getComputedStyle(el).fontSize) * scale), rect: { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) } });
		}
		return out;
	}, limit);
}
