/**
 * Herdr Hold: inside Herdr, keeps the pane `working` while Subagents, Shell Jobs
 * or a Rate-limit Recovery wait still run after main's turn ends, so Herdr's
 * "done" sound plays once, when everything is done. Herdr's own Pi integration
 * keeps doing all the reporting; only its idle report is held and replayed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Gate } from "../lib/herdr-hold/gate.ts";
import { adoptGate, herdrEnv, leaveGate } from "../lib/herdr-hold/socket.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT, RATE_WAIT_EVENT, backgroundWork, rateWait } from "../lib/tab-status/events.ts";

export interface HerdrHoldOptions {
	readonly env?: NodeJS.ProcessEnv;
}

export default function herdrHold(pi: ExtensionAPI, options: HerdrHoldOptions = {}): void {
	const env = options.env ?? process.env;
	const herdr = herdrEnv(env);
	if (!herdr || env.PI_HERDR_HOLD === "off") return;
	const owner = {};
	let gate: Gate | undefined;

	pi.events?.on(BACKGROUND_EVENT, (payload) => {
		const work = backgroundWork(payload);
		if (work) gate?.background(work);
	});
	pi.events?.on(RATE_WAIT_EVENT, (payload) => {
		const wait = rateWait(payload);
		if (wait) gate?.rateLimitWait(wait.sessionId, wait.active);
	});
	pi.on("session_start", (_event, ctx) => {
		// Herdr's integration reports only for the interactive session; children and headless runs stay out.
		if (ctx.mode !== "tui") return;
		gate = adoptGate(owner, herdr);
		const sessionId = ctx.sessionManager.getSessionId();
		gate.setSession(sessionId);
		pi.events?.emit(BACKGROUND_REQUEST_EVENT, { sessionId });
	});
	pi.on("agent_start", () => gate?.turnStarted());
	pi.on("session_shutdown", (event) => {
		if (!gate) return;
		gate = undefined;
		leaveGate(owner, event.reason);
	});
}
