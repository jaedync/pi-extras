// Writes the HyperFrames root composition for a plan. Every visible change is a GSAP tween on one
// paused timeline, so HyperFrames can seek any frame (its render contract).
import { CURSOR_FADE_IN_S, CURSOR_FADE_OUT_S, cursorVisibility } from "./compose-timeline.mjs";
import { planFingerprint } from "./fingerprint.mjs";
import { LOOK_COLOUR, LOOK_FONT } from "./schema.mjs";

const DEFAULT_LOOK = Object.freeze({ ground: "#f4f1ec", ink: "#1d1b19", accent: "#d0552c", font: "Inter", cursor: "dark" });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** A look colour: the schema's rule, and a value outside it is an error, not a silent default. */
const hex = (v, fallback, key) => {
	if (v === undefined || v === null) return fallback;
	if (!LOOK_COLOUR.test(String(v))) throw new Error(`look.${key}: ${JSON.stringify(v)} is not a #hex colour with 3, 6 or 8 digits`);
	return String(v);
};
const fontName = (v) => {
	if (v === undefined || v === null) return DEFAULT_LOOK.font;
	if (!LOOK_FONT.test(String(v))) throw new Error(`look.font: ${JSON.stringify(v)} is not a font family name of up to 60 letters, digits and spaces`);
	return String(v);
};
const n = (v) => Number(v.toFixed(3));

export function lookOf(shots) {
	const l = shots.look ?? {};
	return {
		ground: hex(l.ground, DEFAULT_LOOK.ground, "ground"),
		ink: hex(l.ink, DEFAULT_LOOK.ink, "ink"),
		accent: hex(l.accent, DEFAULT_LOOK.accent, "accent"),
		font: fontName(l.font),
		cursor: l.cursor === "light" ? "light" : "dark",
	};
}

/** GSAP transform that puts source point (cx, cy) at the frame centre at the given zoom. */
export function camTransform(c, source, output) {
	const s0 = output.width / source.width;
	return { x: n(output.width / 2 - c.cx * s0 * c.zoom), y: n(output.height / 2 - c.cy * s0 * c.zoom), scale: c.zoom };
}

// The camera tweens three CSS variables (--cx, --cy, --z) and the transform is computed from them
// in CSS, so the focus point travels in a straight line (tweening x, y and scale makes the frame
// swoop) and a cold seek shows the right frame with no callback (onUpdate is skipped by some seeks).
export function cameraCss(plan) {
	const { width: W, height: H } = plan.output;
	const s0 = n(W / plan.source.width), c0 = plan.camera[0];
	return `--cx: ${c0.cx}; --cy: ${c0.cy}; --z: ${c0.zoom}; transform: translate(calc(${W / 2}px - var(--cx) * var(--z) * ${s0}px), calc(${H / 2}px - var(--cy) * var(--z) * ${s0}px)) scale(var(--z));`;
}

// Every tween states its start values (fromTo): a "to" tween records its start on first render,
// and a review that seeks out of order would record the wrong start.
function cameraTweens(plan) {
	return plan.camera.slice(1).map((c, i) => {
		const p = plan.camera[i], dur = Math.min(0.7, c.t - p.t);
		return `tl.fromTo("#cam", { "--cx": ${p.cx}, "--cy": ${p.cy}, "--z": ${p.zoom} }, { "--cx": ${c.cx}, "--cy": ${c.cy}, "--z": ${c.zoom}, duration: ${n(dur)}, ease: "${c.ease ?? "power3.inOut"}", immediateRender: false }, ${n(c.t - dur)});`;
	});
}

function cursorTweens(plan, s0, shots) {
	const lines = [], k = plan.cursor;
	if (!k.length) return [`tl.set("#cursor", { opacity: 0 }, 0);`];
	lines.push(`tl.set("#cursor", { x: ${n(k[0].x * s0)}, y: ${n(k[0].y * s0)}, opacity: 0 }, 0);`);
	// The cursor is visible around each pointer event only: a parked cursor covers the payoff.
	for (const [from, to] of cursorVisibility(plan, shots)) {
		lines.push(`tl.fromTo("#cursor", { opacity: 0 }, { opacity: 1, duration: ${CURSOR_FADE_IN_S}, immediateRender: false }, ${n(Math.max(0, from - CURSOR_FADE_IN_S))});`);
		lines.push(`tl.fromTo("#cursor", { opacity: 1 }, { opacity: 0, duration: ${CURSOR_FADE_OUT_S}, immediateRender: false }, ${n(Math.max(from, to - CURSOR_FADE_OUT_S))});`);
	}
	k.forEach((p, i) => {
		if (i > 0) {
			const dur = Math.max(0.05, p.t - k[i - 1].t);
			const q = k[i - 1];
			lines.push(`tl.fromTo("#cursor", { x: ${n(q.x * s0)}, y: ${n(q.y * s0)} }, { x: ${n(p.x * s0)}, y: ${n(p.y * s0)}, duration: ${n(dur)}, ease: "power2.inOut", immediateRender: false }, ${n(q.t)});`);
		}
		if (p.click) {
			lines.push(`tl.fromTo("#cursor-arrow", { scale: 1 }, { scale: 0.84, duration: 0.08, ease: "power1.out", immediateRender: false }, ${n(p.t)});`);
			lines.push(`tl.fromTo("#cursor-arrow", { scale: 0.84 }, { scale: 1, duration: 0.14, ease: "power1.out", immediateRender: false }, ${n(p.t + 0.08)});`);
			lines.push(`tl.fromTo("#ripple-${i}", { scale: 0.2, opacity: 0.55 }, { scale: 1, opacity: 0, duration: 0.45, ease: "power2.out" }, ${n(p.t)});`);
		}
	});
	return lines;
}

function captionMarkup(plan) {
	return plan.captions.map((c, i) => `      <div id="cap-${i}" class="clip caption${c.place === "top" ? " top" : ""}" data-start="${c.start}" data-duration="${n(c.end - c.start)}" data-track-index="3"><div class="cap-in">${esc(c.text)}</div></div>`).join("\n");
}

function captionTweens(plan) {
	return plan.captions.flatMap((c, i) => [
		`tl.fromTo("#cap-${i} .cap-in", { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, ${c.start});`,
		`tl.fromTo("#cap-${i} .cap-in", { opacity: 1 }, { opacity: 0, duration: 0.2, ease: "power1.in", immediateRender: false }, ${n(c.end - 0.22)});`,
	]);
}

function cardMarkup(id, card, start, dur) {
	if (!card?.title) return "";
	const sub = card.sub ? `<p class="card-sub">${esc(card.sub)}</p>` : "";
	return `      <div id="${id}" class="clip card" data-start="${n(start)}" data-duration="${n(dur)}" data-track-index="4"><div class="card-in"><h1 class="card-title">${esc(card.title)}</h1>${sub}</div></div>`;
}

function cardTweens(id, card, start, dur, exits) {
	if (!card?.title) return [];
	const lines = [
		`tl.fromTo("#${id} .card-title", { y: 28, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, ${n(start + 0.15)});`,
		`tl.fromTo("#${id} .card-sub", { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" }, ${n(start + 0.32)});`,
	];
	if (exits) lines.push(`tl.fromTo("#${id} .card-in", { opacity: 1 }, { opacity: 0, duration: 0.35, ease: "power1.in", immediateRender: false }, ${n(start + dur - 0.35)});`);
	return lines;
}

function rippleMarkup(plan) {
	return plan.cursor.map((p, i) => (p.click ? `        <div id="ripple-${i}" class="ripple" style="left:${n(p.x * plan.output.width / plan.source.width)}px;top:${n(p.y * plan.output.width / plan.source.width)}px"></div>` : "")).filter(Boolean).join("\n");
}

const CURSOR_SVG = (fill, stroke) => `<svg id="cursor-arrow" width="34" height="50" viewBox="0 0 17 25"><path d="M1 1v19.5l4.6-4.4 3.2 7.4 3.3-1.4-3.2-7.3h6.3z" fill="${fill}" stroke="${stroke}" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

/**
 * The whole index.html. `edit` is { src, start, duration }; intro and outro come from shots.json.
 * Every size is written for a 1080 high frame and multiplied by the plan's own height, so the same
 * composition renders at 640x360 for `wv preview` with the same layout, text and camera.
 */
export function renderHtml(plan, shots, edit, gsapSrc, fontCss = "") {
	const look = lookOf(shots), s0 = plan.output.width / plan.source.width;
	const { width: W, height: H } = plan.output;
	const k = H / 1080;
	const px = (value) => `${Number((value * k).toFixed(2))}px`;
	const total = n(edit.start + edit.duration + (shots.outro?.title ? plan.outroS : 0));
	const [fill, stroke] = look.cursor === "light" ? ["#ffffff", "#111111"] : ["#141414", "#ffffff"];
	const voice = plan.voice.map((v, i) => `      <audio id="voice-${i}" class="clip" src="${esc(v.file)}" data-start="${v.start}" data-duration="${n(v.seconds)}" data-track-index="5"></audio>`).join("\n");
	const beats = plan.beats.map((b, i) => `      <div id="beat-${i}" class="clip beat" data-beat="${esc(b.name)}" data-start="${b.t}" data-duration="0.5" data-track-index="6"></div>`).join("\n");
	const tl = [
		...cardTweens("intro", shots.intro, 0, plan.introS, true),
		...cameraTweens(plan),
		...cursorTweens(plan, s0, shots),
		...captionTweens(plan),
		...cardTweens("outro", shots.outro, edit.start + edit.duration, plan.outroS, false),
	];
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="${esc(gsapSrc)}"></script>
    <style>
${fontCss}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${look.ground}; }
      body { font-family: "${look.font}", sans-serif; color: ${look.ink}; }
      #cam { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; ${cameraCss(plan)} }
      #edit { position: absolute; inset: 0; width: ${W}px; height: ${H}px; object-fit: fill; }
      #cursor { position: absolute; left: 0; top: 0; width: ${px(34)}; height: ${px(50)}; z-index: 5; }
      #cursor-arrow { transform-origin: ${px(2)} ${px(2)}; filter: drop-shadow(0 ${px(3)} ${px(5)} rgba(0,0,0,0.28)); }
      .ripple { position: absolute; width: ${px(96)}; height: ${px(96)}; margin: -${px(48)} 0 0 -${px(48)}; border-radius: 50%; border: ${px(5)} solid ${look.accent}; opacity: 0; z-index: 4; }
      .caption { position: absolute; left: ${px(96)}; bottom: ${px(84)}; z-index: 8; }
      .caption.top { top: ${px(84)}; bottom: auto; }
      .cap-in { max-width: ${px(1400)}; padding: ${px(24)} ${px(38)}; border-radius: ${px(20)}; background: ${look.ink}; color: ${look.ground}; font-size: ${px(56)}; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; opacity: 0; }
      .card { position: absolute; inset: 0; z-index: 10; background: ${look.ground}; }
      .card-in { position: absolute; left: ${px(160)}; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
      .card-title { font-size: ${px(104)}; font-weight: 700; letter-spacing: -0.025em; line-height: 1.02; max-width: ${px(1500)}; opacity: 0; }
      .card-sub { margin-top: ${px(28)}; font-size: ${px(54)}; font-weight: 500; color: ${look.accent}; max-width: ${px(1400)}; opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-fps="${plan.fps}" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}" data-plan-hash="${planFingerprint(plan)}">
      <div id="cam">
        <video id="edit" class="clip" src="${esc(edit.src)}" muted playsinline data-start="${n(edit.start)}" data-duration="${n(edit.duration)}" data-track-index="0"></video>
${rippleMarkup(plan)}
        <div id="cursor">${CURSOR_SVG(fill, stroke)}</div>
      </div>
${captionMarkup(plan)}
${cardMarkup("intro", shots.intro, 0, plan.introS)}
${cardMarkup("outro", shots.outro, edit.start + edit.duration, plan.outroS)}
${voice}
${beats}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tl.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}
