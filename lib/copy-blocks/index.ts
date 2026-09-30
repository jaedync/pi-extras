/**
 * Copy Blocks: code blocks and quotes in replies drawn as cards with a
 * background of their own and a `copy` label; a click copies the block's
 * exact text. Clicks need Pi's fullscreen mode; /copy-block copies from the
 * keyboard in either mode. PI_COPY_BLOCKS=off leaves replies to Pi.
 */
import { copyToClipboard, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaintTheme } from "./draw.ts";
import { sourceBlocks, type SourceBlock } from "./source.ts";
import { forgetLate, redrawLateMessages } from "../late-rows.ts";
import { installCopyBlocks, prepareCopyBlocks, type CopyHost } from "./view.ts";

const DISABLED = new Set(["0", "off", "false", "no"]);
const REDRAW_KEY = "pi-extras.copy-blocks";

export function copyBlocksEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	return !DISABLED.has((env.PI_COPY_BLOCKS ?? "").trim().toLowerCase());
}

export interface CopyBlocksDeps {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly copy: (text: string) => Promise<void>;
	readonly fullscreen: (ctx: ExtensionContext) => boolean;
}

function fullscreenOf(ctx: ExtensionContext): boolean {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getTuiMode() === "fullscreen";
	} catch {
		return false;
	}
}

export const productionDeps = (): CopyBlocksDeps => ({ env: process.env, copy: copyToClipboard, fullscreen: fullscreenOf });

type Entry = { type?: string; message?: { role?: string; content?: unknown } };

/** The text of the newest assistant reply on the current branch that has any. */
export function latestReply(entries: readonly Entry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const message = entries[index]!.type === "message" ? entries[index]!.message : undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = (message.content as Array<{ type?: string; text?: unknown }>)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => (part.text as string).trim())
			.join("\n\n");
		if (text.trim()) return text;
	}
	return undefined;
}

/** The block `/copy-block` picks: the last by default, else the nth counted from 1. */
export function pickBlock(blocks: readonly SourceBlock[], args: string): { block: SourceBlock; number: number } | string {
	if (blocks.length === 0) return "The latest reply has no code blocks or quotes.";
	const wanted = args.trim();
	const number = wanted === "" ? blocks.length : Number(wanted);
	if (!Number.isInteger(number) || number < 1 || number > blocks.length) return `Usage: /copy-block [1-${blocks.length}]`;
	return { block: blocks[number - 1]!, number };
}

export default function copyBlocks(pi: ExtensionAPI, deps: CopyBlocksDeps = productionDeps()): void {
	if (!copyBlocksEnabled(deps.env)) return;
	let undo: (() => void) | undefined;
	// In place before a reload rebuilds the transcript, so the replies it builds are noted (see late-rows.ts).
	prepareCopyBlocks();

	pi.on("session_start", async (_event, ctx) => {
		undo?.();
		undo = undefined;
		if (ctx.mode !== "tui") return;
		const ui = ctx.ui as unknown as {
			theme?: PaintTheme;
			notify(message: string, level?: "info" | "warning" | "error"): void;
			setStatus(key: string, text: string | undefined): void;
		};
		const clickable = deps.fullscreen(ctx);
		const host: CopyHost = {
			enabled: () => true,
			clickable: () => clickable,
			theme: () => ui.theme,
			copy: deps.copy,
			failed: (error) => ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
			// Extensions get no handle on the TUI here; clearing a status key that is never set is Pi's cheapest redraw.
			redraw: () => {
				try { ui.setStatus(REDRAW_KEY, undefined); } catch { /* stale context after a session switch */ }
			},
		};
		undo = installCopyBlocks(host);
		// Replies a reload built before now are drawn again, with their cards.
		redrawLateMessages();
	});

	pi.on("session_shutdown", () => {
		undo?.();
		undo = undefined;
		forgetLate();
	});

	pi.registerCommand("copy-block", {
		description: "Copy a code block or quote from the latest reply (the last one, or the nth)",
		handler: async (args, ctx) => {
			const text = latestReply((ctx.sessionManager?.getBranch?.() ?? []) as Entry[]);
			const picked = pickBlock(text ? sourceBlocks(text) : [], args);
			if (typeof picked === "string") {
				ctx.ui.notify(picked, "warning");
				return;
			}
			try {
				await deps.copy(picked.block.text);
				ctx.ui.notify(`Copied ${picked.block.kind === "code" ? "code block" : "quote"} ${picked.number}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
