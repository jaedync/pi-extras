/**
 * A recreated product view. Build it from the app's own markup and class
 * names (brand/app.css is the app's stylesheet without transitions), at a
 * scale that a phone can read, and move it with the brand spring.
 *
 * This example is a generic card; replace the markup with the app's.
 */
import { scene } from "../kit/film.ts";
import { esc } from "../kit/escape.ts";
import { drift, pop } from "../kit/motion.ts";

export default scene((ctx) => {
	const rows = (ctx.shot.rows as string[] | undefined) ?? [];
	const first = Number(ctx.shot.first ?? 0.25);
	const step = Number(ctx.shot.step ?? 0.3);
	ctx.root.classList.add("ground-surface");
	const ui = ctx.html(`<div class="ui"><div class="card">
		<div class="card-title">${esc(ctx.shot.title)}</div>
		${rows.map((r) => `<div class="card-row"><span class="pip"></span>${esc(r)}</div>`).join("")}
	</div></div>`);
	// Scale the UI up for phones, centred. It is already rising at the cut, so the cut lands on action.
	gsap.set(ui, { xPercent: -50, yPercent: -50, scale: 2.6 });
	ctx.tl.fromTo(ui, { y: 60, opacity: 0.4 }, { y: 0, opacity: 1, duration: 0.5, ease: ctx.ease.settle }, ctx.t0);
	ctx.$$(".card-row").forEach((row, i) => {
		const t = first + i * step;
		pop(ctx, row, t, { from: 0.7, dur: 0.5 });
		ctx.cue("land", t);
	});
	drift(ctx, { from: { scale: 1.0 }, to: { scale: 1.05 }, ease: ctx.ease.out });
});
