/**
 * A VM's console as recovery and the console methods see it, through Hyper-V
 * rather than Windows-MCP: frames, input that survives the VM resetting, what
 * the screen shows, and waking a display that went to sleep.
 */
import { hasTaskbar, isDark, readFrame, type Frame } from "./frame.ts";
import type { HostCalls } from "./guest.ts";
import { readOcr } from "./ocr.ts";

/**
 * Console errors while a VM changes state: devices and screen vanish for a
 * moment mid-restart, and input is refused as "invalid state" (32775) or
 * "system not available" (32777), and Hyper-V may show the VM shutting down
 * or starting. If the VM was saved or turned off instead, the next status
 * check says so.
 */
export const RESETTING = /not found on '|GetVirtualSystemThumbnailImage failed|failed with code 3277[57]\b|is (?:shutting down|starting|stopping|resuming|state \d+), not running/;
/** A thumbnail this wide is plenty to find the taskbar or a dark screen, and quick to fetch. */
const SMALL_FRAME_WIDTH = 320;
/** The host loads Windows OCR on first use, which takes about ten seconds; a read then takes one or two. */
export const OCR_TIMEOUT_MS = 60_000;

/** Busy: Windows is starting, restarting or installing updates. Other: neither a desktop nor busy, such as the lock or sign-in screen. */
export type Look = "desktop" | "busy" | "other";

export interface ScreenOptions {
	readonly host: HostCalls;
	readonly vm: string;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Pause after a key for the screen to change: Start to open, a display to wake. */
	readonly settleMs: number;
}

export class Screen {
	private readonly host: HostCalls;
	private readonly vm: string;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly settleMs: number;

	constructor(options: ScreenOptions) {
		this.host = options.host;
		this.vm = options.vm;
		this.sleep = options.sleep;
		this.settleMs = options.settleMs;
	}

	/** A small console frame, or undefined while the VM resets. */
	async frame(signal?: AbortSignal): Promise<Frame | undefined> {
		try {
			return readFrame(await this.host.call("frame", { vm: this.vm, width: SMALL_FRAME_WIDTH }, { signal }));
		} catch (error) {
			if (error instanceof Error && RESETTING.test(error.message)) return undefined;
			throw error;
		}
	}

	/** The console's text by Windows OCR, a line per recognized line. */
	async text(signal?: AbortSignal): Promise<string> {
		const result = readOcr(await this.host.call("ocr", { vm: this.vm }, { signal, timeoutMs: OCR_TIMEOUT_MS }));
		return result.lines.map((line) => line.words.map((word) => word.text).join(" ")).join("\n");
	}

	/** Console input that a VM resetting mid-restart can't take; returns whether it went in. */
	async input(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
		try {
			await this.host.call(method, { vm: this.vm, ...params }, { signal });
			return true;
		} catch (error) {
			if (error instanceof Error && RESETTING.test(error.message)) return false;
			throw error;
		}
	}

	/**
	 * Wakes a display that went to sleep with Shift, which does nothing by
	 * itself, and returns whether the screen came back. A sleeping display
	 * leaves Windows-MCP an old picture and no windows, and the console black.
	 * `seen` is a frame the caller already has.
	 */
	async wake(signal?: AbortSignal, seen?: Frame): Promise<boolean> {
		const frame = seen ?? await this.frame(signal);
		if (!frame || !isDark(frame)) return false;
		if (!(await this.input("key", { keys: "shift" }, signal))) return false;
		await this.sleep(this.settleMs, signal);
		const after = await this.frame(signal);
		return after !== undefined && !isDark(after);
	}

	/**
	 * What the console shows. Busy: no heartbeat, a nearly black screen even
	 * after a key (which also wakes a sleeping display), or devices missing
	 * mid-reset. A desktop shows its taskbar, if need be after the Windows key,
	 * which brings it up over full-screen apps and does nothing on lock and
	 * sign-in screens.
	 */
	async look(heartbeat: boolean | null | undefined, signal?: AbortSignal): Promise<Look> {
		if (heartbeat === false) return "busy";
		let first = await this.frame(signal);
		if (first && hasTaskbar(first)) return "desktop";
		if (!first || isDark(first)) {
			// Shift first, so the Esc below only ever follows a Start menu it opened.
			if (!(await this.input("key", { keys: "shift" }, signal))) return "busy";
			await this.sleep(this.settleMs, signal);
			first = await this.frame(signal);
			if (first && hasTaskbar(first)) return "desktop";
		}
		if (!(await this.input("key", { keys: "win" }, signal))) return "busy";
		await this.sleep(this.settleMs, signal);
		const second = await this.frame(signal);
		if (!second) return "busy";
		if (hasTaskbar(second)) {
			// Start opened over whatever was in front; close it so it is as the user left it.
			await this.input("key", { keys: "esc" }, signal);
			return "desktop";
		}
		return isDark(second) ? "busy" : "other";
	}
}
