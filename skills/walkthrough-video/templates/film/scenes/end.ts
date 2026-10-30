/**
 * The end card: the wordmark, its dot, one line and the address. It holds
 * long enough to read the address twice, then fades to the ground.
 */
import { scene } from "../kit/film.ts";
import { LEAD, pop, riseWords, splitWords } from "../kit/motion.ts";

export default scene((ctx) => {
	ctx.root.classList.add("ground-brand");
	const card = ctx.html(`<div class="endcard">
		<div class="wordmark"><span class="wm-words"></span><span class="dot"></span></div>
		<div class="tagline"></div>
		<div class="url"></div>
	</div>`);
	const mark = card.querySelector<HTMLElement>(".wm-words")!;
	mark.textContent = String(ctx.shot.wordmark ?? "");
	const tagline = card.querySelector<HTMLElement>(".tagline")!;
	tagline.textContent = String(ctx.shot.tagline ?? "");
	card.querySelector<HTMLElement>(".url")!.textContent = String(ctx.shot.url ?? "");
	riseWords(ctx, splitWords(mark), LEAD, { dur: 0.6 });
	pop(ctx, card.querySelector(".dot")!, 0.35);
	riseWords(ctx, splitWords(tagline), 0.45, { each: 0.08, dur: 0.5 });
	ctx.tl.fromTo(card.querySelector(".url"), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: ctx.ease.out }, ctx.at(0.95));
	ctx.tl.fromTo(ctx.cam, { scale: 1.05 }, { scale: 1, duration: ctx.d, ease: ctx.ease.out, immediateRender: false }, ctx.t0);
	const fade = Number(ctx.shot.fade ?? 0.4);
	ctx.tl.fromTo(ctx.html(`<div class="fade"></div>`, ctx.root), { opacity: 0 }, { opacity: 1, duration: fade, ease: "none" }, ctx.t1 - fade);
});
