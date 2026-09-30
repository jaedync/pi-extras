/** A session-scoped, detection-only guard. Child settings can never enable sleep. */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { captureLimit, failureMessage, parseRateLimit } from "./core.ts";

export const CHILD_GUARD_NAME = "rate-limit-child-warning";
export const CHILD_GUARD_PATH = `<inline:${CHILD_GUARD_NAME}>`;

export const childRateLimitGuard: InlineExtension = {
	name: CHILD_GUARD_NAME,
	factory(pi) {
		pi.on("message_end", (event, ctx) => {
			if (event.message.role !== "assistant" || event.message.stopReason !== "error") return undefined;
			const parsed = parseRateLimit(event.message.errorMessage);
			if (!parsed) return undefined;
			const now = Date.now();
			const limit = captureLimit(event.message, parsed, now);
			// Abort prevents native retries too, even if Pi's quota classification
			// changes. The error role/reason stay intact for the parent report.
			ctx.abort();
			return { message: { ...event.message, errorMessage: failureMessage(limit, now, "Subagents never automatically wait or resume. Choose another provider or retry after the reset.") } };
		});
	},
};
