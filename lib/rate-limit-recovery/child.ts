/** A session-scoped, detection-only guard. Child settings can never enable sleep. */
import type { ExtensionContext, InlineExtension, MessageEndEvent, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { captureLimit, failureMessage, parseRateLimit } from "./core.ts";
import { createQuotaTransportGuard, type QuotaTransportOptions } from "./transport.ts";

export const CHILD_GUARD_NAME = "rate-limit-child-warning";
export const CHILD_GUARD_PATH = `<inline:${CHILD_GUARD_NAME}>`;
const SETUP_FAILURE = "Child quota retry protection could not be initialized. Check models.json and custom provider configuration, then reload Pi before retrying.";

function warn(options: QuotaTransportOptions, code: string): void {
	try {
		if (options.onWarning) options.onWarning(code);
		else console.warn(`Rate-limit child guard: ${code}.`);
	} catch { console.warn("Rate-limit child guard: warning-handler-failed."); }
}

function quotaResult(event: MessageEndEvent, ctx: ExtensionContext): MessageEndEventResult | undefined {
	if (event.message.role !== "assistant" || event.message.stopReason !== "error") return undefined;
	const parsed = parseRateLimit(event.message.errorMessage);
	if (!parsed) return undefined;
	const now = Date.now();
	const limit = captureLimit(event.message, parsed, now);
	// Keep the error intact for the parent while preventing native turn retries.
	ctx.abort();
	return { message: { ...event.message, errorMessage: failureMessage(limit, now, "Subagents never automatically wait or resume. Choose another provider or retry after the reset.") } };
}

export function createChildRateLimitGuard(options: QuotaTransportOptions = {}) {
	const transport = createQuotaTransportGuard(options);
	let failure: string | undefined;
	let closed = false;
	// Only request boundaries may move a guard to another API (see controller).
	const protect = (ctx: ExtensionContext, model = ctx.model, retarget = false) => {
		if (closed) return;
		if (failure) { ctx.abort(); return; }
		try { transport.ensure({ modelRegistry: ctx.modelRegistry, model, retarget }); }
		catch {
			failure = SETUP_FAILURE;
			ctx.abort();
			warn(options, "installation-failed");
			ctx.ui.notify(failure, "error");
		}
	};
	const release = () => { try { transport.dispose(); } catch { warn(options, "dispose-failed"); } };
	const dispose = () => { closed = true; release(); };
	const extension: InlineExtension = {
		name: CHILD_GUARD_NAME,
		factory(pi) {
			pi.on("session_start", (_event, ctx) => { closed = false; failure = undefined; release(); protect(ctx); });
			pi.on("before_agent_start", (_event, ctx) => protect(ctx, ctx.model, true));
			pi.on("context", (_event, ctx) => protect(ctx, ctx.model, true));
			pi.on("model_select", (event, ctx) => protect(ctx, event.model));
			pi.on("session_shutdown", dispose);
			pi.on("message_end", (event, ctx) => closed ? undefined : quotaResult(event, ctx));
		},
	};
	return { extension, dispose, failure: () => failure };
}

export const childRateLimitGuard: InlineExtension = {
	name: CHILD_GUARD_NAME,
	factory: (pi) => createChildRateLimitGuard().extension.factory(pi),
};
