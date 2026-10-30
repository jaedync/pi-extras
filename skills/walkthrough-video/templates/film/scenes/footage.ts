/**
 * Captured footage of the real app (wv capture, frame-exact). Give the shot
 * a `clip: { src: "assets/<file>.mp4", from: <s> }`. A push in on the action
 * takes the eye where the change happens; `push` is optional.
 */
import { scene } from "../kit/film.ts";
import { drift, move } from "../kit/motion.ts";

interface Push {
	at: number;
	dur?: number;
	scale: number;
	x?: number;
	y?: number;
}

export default scene((ctx) => {
	ctx.root.classList.add("ground-surface");
	if (!ctx.video) throw new Error(`shot ${ctx.shot.id}: the footage scene needs a clip`);
	ctx.video.classList.add("footage");
	const push = ctx.shot.push as Push | undefined;
	if (push) move(ctx, push.at, { scale: push.scale, x: push.x ?? 0, y: push.y ?? 0 }, { dur: push.dur ?? 0.8 });
	else drift(ctx, { to: { scale: 1.035 } });
});
