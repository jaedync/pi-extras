/** Session ids keep in-process children and replacement sessions out of the parent's tab. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function announceBackground(pi: ExtensionAPI, ctx: ExtensionContext, source: BackgroundWork["source"], count: number): void {
	pi.events?.emit(BACKGROUND_EVENT, { sessionId: ctx.sessionManager.getSessionId(), source, count });
}
export function announceRateWait(pi: ExtensionAPI, ctx: ExtensionContext, active: boolean): void {
	pi.events?.emit(RATE_WAIT_EVENT, { sessionId: ctx.sessionManager.getSessionId(), active });
}
export const BACKGROUND_EVENT = "pi-extras:background-work";
export const BACKGROUND_REQUEST_EVENT = "pi-extras:background-work-request";
export const RATE_WAIT_EVENT = "pi-extras:rate-limit-wait";
export interface BackgroundWork { sessionId: string; source: "subagents" | "shell-jobs"; count: number }
export interface RateWait { sessionId: string; active: boolean }

export function backgroundWork(value: unknown): BackgroundWork | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Partial<BackgroundWork>;
	return typeof v.sessionId === "string" && (v.source === "subagents" || v.source === "shell-jobs") && Number.isSafeInteger(v.count) && v.count! >= 0
		? { sessionId: v.sessionId, source: v.source, count: v.count! } : undefined;
}
export function rateWait(value: unknown): RateWait | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Partial<RateWait>;
	return typeof v.sessionId === "string" && typeof v.active === "boolean" ? { sessionId: v.sessionId, active: v.active } : undefined;
}
