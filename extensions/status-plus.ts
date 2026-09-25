/**
 * status-plus: a compact usage and provider-limit grid for Pi.
 *
 * Two grid lines (clock of the last completed call, toned by cache
 * warmth; context bar, model and
 * thinking level, session cost and airtime, counters; then cwd, token totals,
 * cache hit rate) followed by one aligned row per provider with spend this
 * session: cost, airtime, total input and output tokens, limits, resets. Limits come from response headers
 * and throttled pollers (lib/status-plus-limits.ts); everything durable is
 * recomputed from the transcript on every update (lib/status-plus-transcript.ts).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { operationalError } from "../lib/operational-log.ts";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CHAIN_EVENT } from "../lib/chain/run.ts";
import { footerLayout, type FooterModel, type FooterRow, type Span } from "../lib/status-plus-footer.ts";
import { readToolCount, splitCount, TOOL_COUNT_EVENT, writeToolCount, type ToolCount } from "../lib/tool-count.ts";
import { sharedLimitStore } from "../lib/limit-store.ts";
import { FORCED_POLL_FLOOR_MS, LIMIT_POLLERS, POLL_FRESH_MS, REFRESH_INTERVAL_MS, parseLimitHeaders, pollGapMs } from "../lib/status-plus-limits.ts";
import { estimateUsageCost, toEpochMs } from "../lib/status-plus-logic.ts";
import { splitMeshStatuses } from "../lib/status-plus-mesh.ts";
import { TWEEN_FRAME_MS, flashIntensity, incrementAt, isActive, retarget, valueAt, type Tween } from "../lib/status-plus-tween.ts";
import { EMPTY_PROVIDER, cacheState } from "../lib/status-plus-render.ts";
import {
	BILLING_SOURCE_ENTRY,
	collect,
	type AssistantLike,
	type BillingSourceEntry,
	type BranchEntry,
	type SessionStats,
	type TranscriptSource,
} from "../lib/status-plus-transcript.ts";

const LONG_CACHE = process.env.PI_CACHE_RETENTION === "long";
const CACHE = { ttlMs: (LONG_CACHE ? 60 : 5) * 60_000, warnMs: (LONG_CACHE ? 55 : 4) * 60_000 };
const LOG_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "status-plus.log");
const ZEN_NOTE = "balance not exposed by OpenCode";
const GO_BILLING_NOTE = "billing Zen";

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(listener: () => void): () => void;
}

function assistantMessageCost(ctx: ExtensionContext, message: AssistantLike): number {
	const recorded = message.usage.cost.total;
	if (recorded > 0) return recorded;
	const model = ctx.modelRegistry.find(message.provider, message.model);
	return model ? estimateUsageCost(message.usage, model.cost) : recorded;
}

function transcriptSource(ctx: ExtensionContext): TranscriptSource {
	return {
		getBranch: () => ctx.sessionManager.getBranch() as unknown as BranchEntry[],
		getSessionDir: () => ctx.sessionManager.getSessionDir(),
		getSessionFile: () => ctx.sessionManager.getSessionFile(),
		costOf: (message) => assistantMessageCost(ctx, message),
	};
}

function formatCwd(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export default function statusPlus(pi: ExtensionAPI): void {
	/** The one provider request the transcript can't see yet. */
	let inflight: { provider: string; startedMs: number; endedMs?: number } | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let requestFooterRender: (() => void) | undefined;
	/** Counter animation for the spend cell; a frame timer runs only while a tween is live. */
	let costTween: Tween | undefined;
	let frameTimer: ReturnType<typeof setTimeout> | undefined;
	/** Latest limit snapshot per provider, shared with usage-guard through the process-wide store. */
	const providerLimits = sharedLimitStore();
	/** Providers with activity on this branch; gates which pollers may run. */
	const seenProviders = new Set<string>();
	const lastPollMs = new Map<string, number>();
	/** Consecutive failed polls per provider, for backoff. */
	const pollFailures = new Map<string, number>();
	/** Context of the latest event, so forced refreshes from other extensions can poll. */
	let latestCtx: ExtensionContext | undefined;

	/**
	 * Transcript totals, refreshed on events and the 30s timer rather than per
	 * frame: the TUI calls every component's render on each frame, and the
	 * spinner drives frames at up to 14/s while a turn runs, so walking the
	 * transcript and child evidence there would scale with session length.
	 */
	let transcriptStats: SessionStats | undefined;
	/** Chains that finished since the transcript last saved them; Tool Display saves between turns. */
	const liveChains = new Map<string, number>();
	let toolCount: ToolCount = "calls";
	let toolsSpan: Span | undefined;

	function refreshStats(ctx: ExtensionContext): SessionStats {
		transcriptStats = collect(transcriptSource(ctx));
		for (const id of transcriptStats.providers.keys()) seenProviders.add(id);
		return transcriptStats;
	}

	/** A copy of the cached totals with the in-flight request folded in; cheap enough for every frame. */
	function sessionStats(ctx: ExtensionContext): SessionStats {
		const base = transcriptStats ?? refreshStats(ctx);
		const stats: SessionStats = {
			...base,
			providers: new Map([...base.providers].map(([id, value]) => [id, { ...value }])),
		};
		// Fold in the in-flight request, unless the transcript already has it.
		if (inflight) {
			if (stats.lastApiEndMs && stats.lastApiEndMs >= inflight.startedMs) {
				inflight = undefined;
			} else {
				const provider = stats.providers.get(inflight.provider) ?? { ...EMPTY_PROVIDER };
				stats.providers.set(inflight.provider, provider);
				provider.airtimeMs += (inflight.endedMs ?? Date.now()) - inflight.startedMs;
				if (inflight.endedMs && (!stats.lastApiEndMs || inflight.endedMs > stats.lastApiEndMs)) {
					stats.lastApiEndMs = inflight.endedMs;
				}
			}
		}
		return stats;
	}

	function openCodeGoUsesZenBalance(): boolean {
		const snapshot = providerLimits.get("opencode-go");
		if (!snapshot || snapshot.source !== "poll" || Date.now() - snapshot.atMs > 2 * 60_000) return false;
		return snapshot.entries.some((entry) => entry.exhausted && (entry.resetMs === undefined || entry.resetMs > Date.now()));
	}

	function footerRows(stats: SessionStats): FooterRow[] {
		return [...stats.providers.entries()].map(([id, { cost, airtimeMs, inputTokens, outputTokens }]) => ({
			id,
			cost,
			airtimeMs,
			tokens: { input: inputTokens, output: outputTokens },
			entries: providerLimits.get(id)?.entries ?? [],
			...(id === "opencode-go" && openCodeGoUsesZenBalance() ? { billingNote: GO_BILLING_NOTE } : {}),
			...(id === "opencode" ? { note: ZEN_NOTE } : {}),
		}));
	}

	/**
	 * Ease the cost figure toward the transcript total and keep frames coming
	 * while it moves. Airtime is left raw: it already ticks live during a
	 * request, and animating it would keep the frame timer busy for the whole call.
	 */
	function animatedSpend(rows: FooterRow[], now: number): FooterModel["spend"] {
		const cost = rows.reduce((sum, row) => sum + row.cost, 0);
		const airtimeMs = rows.reduce((sum, row) => sum + row.airtimeMs, 0);
		costTween = retarget(costTween, cost, now);
		const live = isActive(costTween, now);
		if (live && !frameTimer) {
			frameTimer = setTimeout(() => {
				frameTimer = undefined;
				requestFooterRender?.();
			}, TWEEN_FRAME_MS);
		}
		return { cost: valueAt(costTween, now), airtimeMs, flash: flashIntensity(costTween, now), delta: incrementAt(costTween, now) };
	}

	function footerModel(ctx: ExtensionContext, footerData: FooterData): FooterModel {
		const stats = sessionStats(ctx);
		const now = Date.now();
		const rows = footerRows(stats);
		const usage = ctx.getContextUsage();
		const windowTokens = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const percent = usage?.percent ?? undefined;
		const usedTokens = usage?.tokens ?? (percent !== undefined ? (percent / 100) * windowTokens : 0);
		return {
			nowMs: now,
			lastApiEndMs: stats.lastApiEndMs,
			cache: cacheState(stats.lastApiEndMs, stats.lastContextResetMs, now, CACHE),
			context: { usedTokens, windowTokens, percent },
			modelName: ctx.model?.id || "no-model",
			providerId: ctx.model?.provider,
			thinkingLevel: ctx.model?.reasoning ? ctx.thinkingLevel || "off" : undefined,
			spend: animatedSpend(rows, now),
			counters: toolCounters(stats),
			cwd: formatCwd(ctx.sessionManager.getCwd()),
			gitBranch: footerData.getGitBranch(),
			sessionName: ctx.sessionManager.getSessionName(),
			tokens: {
				input: stats.tokens.input,
				cacheWrite: stats.tokens.cacheWrite,
				cacheRead: stats.tokens.cacheRead,
				output: stats.tokens.output,
			},
			cacheHitPct: stats.cacheHitPct,
			rows,
			...meshAndStatuses(footerData),
		};
	}

	function toolCounters(stats: SessionStats): FooterModel["counters"] {
		const counters = { prompts: stats.prompts, turns: stats.turns, toolCalls: stats.toolCalls };
		if (toolCount === "calls") return counters;
		return { ...counters, toolCalls: splitCount(stats.toolCalls, new Map([...liveChains, ...stats.chains])), split: true };
	}

	/** A click on the tool figure switches how it counts, and the choice is kept for later sessions. */
	function toggleToolCount(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const span = toolsSpan;
		if (event.type !== "click" || event.button !== "left" || span === undefined) return undefined;
		// One column of slack before the figure: a click on its first digit often lands just left of it.
		if (event.y !== span.y || event.x < span.x0 - 1 || event.x >= span.x1) return undefined;
		setToolCount(toolCount === "calls" ? "steps" : "calls", true);
		return { handled: true };
	}

	function setToolCount(next: ToolCount, save: boolean): void {
		toolCount = next;
		if (save) {
			try {
				writeToolCount(next);
			} catch (error) {
				operationalError(LOG_FILE, "status-plus", `could not save the tool count: ${(error as Error).message}`);
			}
		}
		requestFooterRender?.();
	}

	function meshAndStatuses(footerData: FooterData): Pick<FooterModel, "mesh" | "extensionStatuses"> {
		const { mesh, others } = splitMeshStatuses(footerData.getExtensionStatuses().entries());
		return { mesh, extensionStatuses: others };
	}

	function installFooter(ctx: ExtensionContext): boolean {
		if (ctx.mode !== "tui" || typeof ctx.ui.setFooter !== "function") return false;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => {
				// A branch switch is a context change, not spend: no animation.
				costTween = undefined;
				// Chains announced on the old branch are not on this one; its saved ones are in the transcript.
				liveChains.clear();
				refreshStats(ctx);
				tui.requestRender();
			});
			return {
				render: (width: number) => {
					const layout = footerLayout(footerModel(ctx, footerData as FooterData), width, theme);
					toolsSpan = layout.tools;
					return layout.lines;
				},
				handleMouse: toggleToolCount,
				invalidate() {},
				dispose() {
					unsubscribe();
					requestFooterRender = undefined;
				},
			};
		});
		return true;
	}

	function update(ctx: ExtensionContext): void {
		refreshStats(ctx);
		requestFooterRender?.();
	}

	async function refreshProviderLimits(provider: string, ctx: ExtensionContext, force = false): Promise<void> {
		if (process.env.PI_OFFLINE || process.env.STATUS_PLUS_POLL_LIMITS === "0") return;
		const poller = LIMIT_POLLERS[provider];
		if (!poller) return;
		const last = lastPollMs.get(provider) ?? 0;
		const failures = pollFailures.get(provider) ?? 0;
		const gap = force ? FORCED_POLL_FLOOR_MS : pollGapMs(poller.interval(ctx), failures, providerLimits.isHot(provider));
		if (Date.now() - last < gap) return;
		lastPollMs.set(provider, Date.now());
		try {
			const entries = await poller.poll(ctx);
			if (!entries || entries.length === 0) {
				// No credentials or a non-2xx: back off rather than retry every interval.
				pollFailures.set(provider, failures + 1);
				return;
			}
			pollFailures.set(provider, 0);
			providerLimits.set(provider, { entries, atMs: Date.now(), source: "poll" });
			update(ctx);
		} catch (error) {
			pollFailures.set(provider, failures + 1);
			// Best-effort: a failed poll must never fail Pi, but it should be findable.
			operationalError(LOG_FILE, "status-plus", `${provider} limit poll failed: ${(error as Error)?.name ?? "error"}`);
		}
	}

	function schedulePolls(ctx: ExtensionContext): void {
		for (const provider of Object.keys(LIMIT_POLLERS)) {
			if (!seenProviders.has(provider) && ctx.model?.provider !== provider) continue;
			void refreshProviderLimits(provider, ctx);
		}
	}

	pi.on("after_provider_response", async (event, ctx) => {
		latestCtx = ctx;
		const provider = ctx.model?.provider;
		if (!provider) return;
		const entries = parseLimitHeaders(provider, event.headers);
		if (entries.length === 0) return;
		// Headers must not clobber a fresh, richer poll snapshot between polls.
		const existing = providerLimits.get(provider);
		if (existing?.source === "poll" && Date.now() - existing.atMs < POLL_FRESH_MS) return;
		providerLimits.set(provider, { entries, atMs: Date.now(), source: "headers" });
		update(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		const sourceProvider = ctx.model?.provider ?? "unknown";
		if (sourceProvider === "opencode-go") {
			// The usage endpoint is the only authoritative signal that Go has
			// exhausted a window and a successful request will use Zen balance.
			await refreshProviderLimits(sourceProvider, ctx, true);
		}
		const billingProvider = sourceProvider === "opencode-go" && openCodeGoUsesZenBalance() ? "opencode" : sourceProvider;
		inflight = { provider: billingProvider, startedMs: Date.now() };
		update(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.provider === "opencode-go" && inflight?.provider === "opencode") {
			pi.appendEntry(BILLING_SOURCE_ENTRY, {
				messageTimestampMs: toEpochMs(event.message.timestamp),
				provider: "opencode",
			} satisfies BillingSourceEntry);
		}
		if (inflight && !inflight.endedMs) inflight.endedMs = Date.now();
		update(ctx);
		schedulePolls(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Close a dangling interval (e.g. aborted request with no message_end).
		if (inflight && !inflight.endedMs) inflight.endedMs = Date.now();
		update(ctx);
	});

	// Tool Display announces each chain as it finishes; it reaches the transcript between turns.
	pi.events?.on(CHAIN_EVENT, (data: unknown) => {
		const { toolCallId, ran } = (data ?? {}) as { toolCallId?: unknown; ran?: unknown };
		if (typeof toolCallId !== "string" || typeof ran !== "number") return;
		liveChains.set(toolCallId, ran);
		if (toolCount === "steps") requestFooterRender?.();
	});
	// `/tool-display count` switches the count where the terminal sends no clicks, and saves it itself.
	pi.events?.on(TOOL_COUNT_EVENT, (data: unknown) => {
		if (data === "calls" || data === "steps") setToolCount(data, false);
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		liveChains.clear();
		toolCount = readToolCount();
		providerLimits.setRefresher(async (provider, force) => {
			if (latestCtx) await refreshProviderLimits(provider, latestCtx, force);
		});
		// New or resumed session: its first total is the baseline, not a change to animate.
		costTween = undefined;
		if (frameTimer) clearTimeout(frameTimer);
		frameTimer = undefined;
		// Clear leftovers from previous versions of this extension; the grid
		// footer carries everything the old status segment showed.
		ctx.ui.setWidget("status-plus-limits", undefined);
		ctx.ui.setStatus("status-plus-limits", undefined);
		ctx.ui.setStatus("status-plus", undefined);
		if (!installFooter(ctx) && ctx.mode === "tui") {
			operationalError(LOG_FILE, "status-plus", "footer hook unavailable; grid footer disabled");
		}
		update(ctx);
		schedulePolls(ctx);
		// Keep the clock, cache warmth, and live airtime ticking between events.
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			update(ctx);
			schedulePolls(ctx);
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		providerLimits.setRefresher(undefined);
		latestCtx = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (frameTimer) clearTimeout(frameTimer);
		frameTimer = undefined;
	});
}
