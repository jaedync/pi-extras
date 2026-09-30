/** Abortable timers owned by one active turn. No resources start at factory load. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "../status-plus-logic.ts";
import type { CapturedLimit, WaitPlan } from "./core.ts";

export const WIDGET = "rate-limit-recovery";
export type Wait = (ms: number, signal: AbortSignal, tick: () => void) => Promise<boolean>;

export const waitForDelay: Wait = (ms, signal, tick) => new Promise<boolean>((resolve, reject) => {
	if (signal.aborted) { resolve(false); return; }
	let timeout: ReturnType<typeof setTimeout>;
	let interval: ReturnType<typeof setInterval>;
	const clean = () => {
		clearTimeout(timeout); clearInterval(interval);
		signal.removeEventListener("abort", aborted);
	};
	const aborted = () => { clean(); resolve(false); };
	const update = () => {
		try { tick(); } catch (error) { clean(); reject(error); }
	};
	timeout = setTimeout(() => { clean(); resolve(true); }, ms);
	interval = setInterval(update, 1000);
	signal.addEventListener("abort", aborted, { once: true });
	update();
});

export function isCancelKey(data: string): boolean {
	return !isKeyRelease(data) && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")));
}

export function waitUI(ctx: ExtensionContext, limit: Pick<CapturedLimit, "provider">, plan: Pick<WaitPlan, "resumeAtMs"> & Partial<WaitPlan>, now: () => number, cancel: () => void,
	line: (remaining: string) => string = (remaining) => `Hibernating ${limit.provider} · ${remaining} remaining`): { tick(): void; close(): void } {
	let render = () => {};
	ctx.ui.setWidget(WIDGET, (tui, theme) => {
		render = () => tui.requestRender();
		return {
			render(width: number) {
				const remaining = formatDuration(Math.max(0, plan.resumeAtMs - now()), true);
				const text = `${line(remaining)} · Esc / Ctrl+C cancels`;
				return [truncateToWidth(theme.fg("warning", text), Math.max(1, width), "…")];
			},
			invalidate() {},
		};
	});
	let unsubscribe = () => {};
	try { unsubscribe = ctx.ui.onTerminalInput((data) => {
		if (!isCancelKey(data)) return undefined;
		cancel();
		// Escape still reaches Pi's normal queue/editor/overlay handling. Ctrl+C
		// would clear the editor rather than abort, so consume it during this wait.
		return matchesKey(data, Key.ctrl("c")) ? { consume: true } : undefined;
	}); } catch (error) {
		ctx.ui.setWidget(WIDGET, undefined);
		throw error;
	}
	let closed = false;
	return {
		tick: () => render(),
		close() {
			if (closed) return;
			closed = true; unsubscribe(); render = () => {};
			ctx.ui.setWidget(WIDGET, undefined);
		},
	};
}
