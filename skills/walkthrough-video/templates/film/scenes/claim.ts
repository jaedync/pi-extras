/**
 * A kinetic claim on the brand ground: the words rise out of masks, the
 * accent dot lands as the full stop, and the frame breathes with a slow
 * drift. Claims are silent; the picture carries them.
 */
import { scene } from "../kit/film.ts";
import { LEAD, drift, pop, riseWords, splitWords } from "../kit/motion.ts";

export default scene((ctx) => {
	const text = String(ctx.shot.text ?? "");
	ctx.root.classList.add("ground-brand");
	const line = ctx.html(`<h1 class="claim"><span class="claim-words"></span><span class="dot"></span></h1>`);
	const wordsHost = line.querySelector<HTMLElement>(".claim-words")!;
	wordsHost.textContent = text;
	const words = splitWords(wordsHost);
	// The first words are already moving at the cut, so the cut lands on action.
	const done = riseWords(ctx, words, LEAD);
	pop(ctx, line.querySelector(".dot")!, Math.min(done - 0.2, ctx.d - 0.5));
	drift(ctx);
});
