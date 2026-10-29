/**
 * status-plus: a compact usage and provider-limit grid for Pi.
 *
 * Two grid lines (clock of the last completed call, toned by cache
 * warmth; context bar, model and
 * thinking level, session cost and airtime, counters; then cwd, token totals,
 * cache hit rate) followed by one aligned row per provider with spend this
 * session: cost, airtime, total input and output tokens, limits, resets. A row
 * is a provider family (lib/provider-family.ts): `claude-code` spend and
 * limits show on the anthropic row. Limits come from response headers
 * and throttled pollers (lib/status-plus-limits.ts); everything durable is
 * recomputed from the transcript on every update (lib/status-plus-transcript.ts).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, copyToClipboard, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactionPoint, contextShare, type CompactionLimits } from "../lib/compaction-point.ts";
import { fileIdentity } from "../lib/file-identity.ts";
import { isOffline } from "../lib/offline.ts";
import { errorText, operationalError, operationalLine } from "../lib/operational-log.ts";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CHAIN_EVENT } from "../lib/chain/run.ts";
import { footerLayout, STATUS_CLICK_EVENT, statusKeyAt, type FooterModel, type FooterRow, type Span, type StatusRow } from "../lib/status-plus-footer.ts";
import { isRemoteSession, keepLinkCopy, linkCopier, readCopyLinks, type LinkCopier } from "../lib/status-plus-links.ts";
import { readToolCount, splitCount, TOOL_COUNT_EVENT, writeToolCount, type ToolCount } from "../lib/tool-count.ts";
import { disagreementText, disagreements, markUnsampled, mergePolled, windowName } from "../lib/limit-merge.ts";
import { isVirtualModel, routedModel } from "../lib/routed-model.ts";
import { sharedLimitStore, type LimitSnapshot } from "../lib/limit-store.ts";
import { nextPollMs, readShared, writeShared, type SharedPoll } from "../lib/limit-share.ts";
import { FORCED_POLL_FLOOR_MS, LIMIT_POLLERS, POLL_FRESH_MS, PollRefused, REFRESH_INTERVAL_MS, limitFamily, noteAnthropicCredential, parseLimitHeaders, pollGapMs } from "../lib/status-plus-limits.ts";
import { limitKey } from "../lib/plan-billing.ts";
import { STATUS_TIME_ZONE_PROBLEM, estimateUsageCost, freeProviders, toEpochMs, withPolledBalances, type LimitEntry, type PricedModel } from "../lib/status-plus-logic.ts";
import { splitMeshStatuses } from "../lib/status-plus-mesh.ts";
import { TWEEN_FRAME_MS, flashIntensity, incrementAt, isActive, retarget, valueAt, type Tween } from "../lib/status-plus-tween.ts";
import { EMPTY_PROVIDER, cacheState, cacheTtl } from "../lib/status-plus-render.ts";
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
const AGENT_DIR = getAgentDir();
const LOG_FILE = join(AGENT_DIR, "status-plus.log");
/** Pi's global settings, the file SettingsManager.create reads besides the project's. */
const GLOBAL_SETTINGS = join(AGENT_DIR, "settings.json");
/** Limit polls shared by the Pi processes of this agent directory (lib/limit-share.ts). */
const SHARE_DIR = join(AGENT_DIR, "status-plus-limits");
const ZEN_NOTE = "balance not exposed by OpenCode";
/** Pause before reading the child evidence a walk could not afford: input and frames get through between walks. */
const CATCH_UP_MS = 250;
/** session_start waits at most this long to learn whether Pi's anthropic credential is an API key. */
const CREDENTIAL_WAIT_MS = 1_000;
/** Follow-up walks in a row: enough for 320 MB of children; a cache too small for them could otherwise keep going. */
const MAX_CATCH_UPS = 4;
const GO_BILLING_NOTE = "billing Zen";
const FOOTER_FAILED = "status-plus: footer failed, see status-plus.log";
/** Distinct readings remembered for the disagreement log; past this the memory starts again. */
const LOGGED_READINGS_MAX = 200;

/** An unknown STATUSLINE_TZ is logged with the first session, not with each one. */
let zoneLogged = false;

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
		getEntries: () => ctx.sessionManager.getEntries() as unknown as BranchEntry[],
		getSessionDir: () => ctx.sessionManager.getSessionDir(),
		getSessionFile: () => ctx.sessionManager.getSessionFile(),
		// Where the subagents extension keeps this session's team (lib/subagents/host-state.ts).
		getChildIndex: () => join(AGENT_DIR, "sessions", "subagents", ctx.sessionManager.getSessionId(), "index.json"),
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
	/**
	 * Between a turn's start and its reply. Pi also sends requests of its own
	 * outside turns (cache refreshes during a long tool call) that end in no
	 * reply, so they would tick airtime until the next one.
	 */
	let awaitingReply = false;
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
	/** Consecutive failed polls per provider, for backoff when the shared poll file is out of reach. */
	const pollFailures = new Map<string, number>();
	/** A provider's Retry-After, kept here too: the shared poll file can be out of reach. */
	const retryAtMs = new Map<string, number>();
	/** When the newest poll result this process applied ended, its own or another process's. */
	const polledAtMs = new Map<string, number>();
	/** Approximate readings already in the disagreement log. */
	const loggedReadings = new Set<string>();
	let shareFailed = false;
	/** Context of the latest event, so forced refreshes from other extensions can poll. */
	let latestCtx: ExtensionContext | undefined;

	/**
	 * Transcript totals, refreshed when the branch gains an entry and on the 30s
	 * timer rather than per frame: the TUI calls every component's render on each
	 * frame, and the spinner drives frames at up to 14/s while a turn runs, so
	 * walking the transcript and child evidence there would scale with session
	 * length. Limits and the in-flight request only need a repaint.
	 */
	let transcriptStats: SessionStats | undefined;
	/** The leaf the last walk saw; an event that left it unchanged has nothing new to count. */
	let walkedLeaf: string | undefined;
	let pendingRefresh: ReturnType<typeof setImmediate> | undefined;
	let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
	let catchUps = 0;
	/** Providers whose models all cost nothing, read from the registry with each walk. */
	let free = new Set<string>();
	/** Chains that finished since the transcript last saved them; Tool Display saves between turns. */
	const liveChains = new Map<string, number>();
	let toolCount: ToolCount = "steps";
	let toolsSpan: Span | undefined;
	let statusRows: StatusRow[] = [];
	/** Over SSH, the handler that copies a clicked link (lib/status-plus-links.ts); undefined in a local session. */
	let linkCopy: LinkCopier | undefined;
	/** Set after the renderer refused the handler, so the log gets one line, not one per frame. */
	let linkCopyFailed = false;

	function leafOf(ctx: ExtensionContext): string | undefined {
		return typeof ctx.sessionManager.getLeafId === "function" ? ctx.sessionManager.getLeafId() ?? undefined : undefined;
	}

	function refreshStats(ctx: ExtensionContext): SessionStats {
		walkedLeaf = leafOf(ctx);
		const loading = transcriptStats?.partial === true;
		transcriptStats = collect(transcriptSource(ctx));
		// What the last walk could not read yet is loading, not spend: no animation for it.
		if (loading) costTween = undefined;
		catchUp(ctx, transcriptStats.partial === true);
		for (const id of transcriptStats.providers.keys()) seenProviders.add(id);
		const registry = ctx.modelRegistry as { getAll?: () => PricedModel[] } | undefined;
		free = typeof registry?.getAll === "function" ? freeProviders(registry.getAll()) : new Set();
		return transcriptStats;
	}

	/** After a walk that ran out of reads, read the rest soon rather than on the 30 s timer. */
	function catchUp(ctx: ExtensionContext, partial: boolean): void {
		if (!partial) {
			catchUps = 0;
			return;
		}
		if (catchUpTimer || catchUps >= MAX_CATCH_UPS) return;
		catchUps++;
		catchUpTimer = setTimeout(() => {
			catchUpTimer = undefined;
			update(ctx);
		}, CATCH_UP_MS);
	}

	function stopCatchUp(): void {
		if (catchUpTimer) clearTimeout(catchUpTimer);
		catchUpTimer = undefined;
		catchUps = 0;
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

	/** One row per provider family, with its members' spend summed. */
	function footerRows(stats: SessionStats, selected: string | undefined): FooterRow[] {
		const families = new Map<string, { members: string[]; cost: number; airtimeMs: number; inputTokens: number; outputTokens: number }>();
		const add = (id: string, usage: { cost: number; airtimeMs: number; inputTokens: number; outputTokens: number }) => {
			const family = limitKey(id);
			const row = families.get(family) ?? { members: [], cost: 0, airtimeMs: 0, inputTokens: 0, outputTokens: 0 };
			row.members.push(id);
			row.cost += usage.cost;
			row.airtimeMs += usage.airtimeMs;
			row.inputTokens += usage.inputTokens;
			row.outputTokens += usage.outputTokens;
			families.set(family, row);
		};
		for (const [id, usage] of stats.providers) add(id, usage);
		const selectedFamily = selected === undefined ? undefined : limitKey(selected);
		// The transcript knows only providers that did work; the selected one shows its limits before its first request.
		if (selected && selectedFamily && !families.has(selectedFamily)) add(selected, EMPTY_PROVIDER);
		return [...families].map(([id, { members, cost, airtimeMs, inputTokens, outputTokens }]) => ({
			id,
			cost,
			airtimeMs,
			tokens: { input: inputTokens, output: outputTokens },
			entries: providerLimits.get(id)?.entries ?? [],
			...(id === "opencode-go" && openCodeGoUsesZenBalance() ? { billingNote: GO_BILLING_NOTE } : {}),
			...(id === "opencode" ? { note: ZEN_NOTE } : {}),
			...(members.every((member) => free.has(member)) ? { free: true } : {}),
			...(id === selectedFamily ? { selected: true } : {}),
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

	/**
	 * Context usage and the session name, read again only when the session
	 * gains an entry (which moves its leaf) or the model changes. Pi works both
	 * out by walking the whole session, too slow for every frame of a long one.
	 */
	let sessionFacts: {
		key: string; model: unknown; usage: ReturnType<ExtensionContext["getContextUsage"]>; name: string | undefined;
		/** Under a virtual selection, the model it routed to (lib/routed-model.ts); the selection otherwise. */
		routed: ExtensionContext["model"];
		compaction: CompactionLimits | undefined;
	} | undefined;

	function readSessionFacts(ctx: ExtensionContext): NonNullable<typeof sessionFacts> {
		const leaf = typeof ctx.sessionManager.getLeafId === "function" ? ctx.sessionManager.getLeafId() : undefined;
		const key = `${leaf ?? ""}|${ctx.model?.contextWindow ?? ""}`;
		if (leaf !== undefined && sessionFacts?.key === key && sessionFacts.model === ctx.model) return sessionFacts;
		sessionFacts = {
			key, model: ctx.model, usage: ctx.getContextUsage(), name: ctx.sessionManager.getSessionName(), routed: routedModel(ctx),
			compaction: compactionLimits(ctx),
		};
		return sessionFacts;
	}

	/** The last settings read, and the files, directory and trust they were read for. */
	let settingsRead: { key: string; settings: SettingsManager | undefined } | undefined;
	let compactionProblem: string | undefined;

	/**
	 * Pi's compaction settings for the selected model, whose reserve Pi uses
	 * (lib/compaction-point.ts). The extension context has no settings, so this
	 * reads the files as Pi does. Pi takes a lock on settings.json even to read
	 * it, and other Pi processes share that file, so a read happens only when a
	 * file's identity (a stat), the directory or the trust changes; the model's
	 * override comes from the settings already read.
	 */
	function compactionLimits(ctx: ExtensionContext): CompactionLimits | undefined {
		const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
		// Pi does not read an untrusted project's file, so its changes don't count.
		const project = trusted && typeof ctx.cwd === "string" ? fileIdentity(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : "";
		const key = `${ctx.cwd}|${trusted}|${fileIdentity(GLOBAL_SETTINGS)}|${project}`;
		if (settingsRead?.key !== key) settingsRead = { key, settings: readSettings(ctx, trusted) ?? settingsRead?.settings };
		try {
			return settingsRead.settings?.getCompactionSettings(ctx.model);
		} catch (error) {
			// An override Pi rejects for this model: Pi fails its own check too, so the figure takes the window.
			problem("uses the whole window", error);
			return undefined;
		}
	}

	/**
	 * The settings as Pi reads them now, or none when a file does not load:
	 * Pi keeps the values it loaded, so the figure keeps its last reading (the
	 * window before one). A file that does not load reads as empty, and an empty
	 * file would show Pi's defaults.
	 */
	function readSettings(ctx: ExtensionContext, trusted: boolean): SettingsManager | undefined {
		try {
			const settings = SettingsManager.create(ctx.cwd, AGENT_DIR, { projectTrusted: trusted });
			const [failed] = typeof settings.drainErrors === "function" ? settings.drainErrors() : [];
			if (failed) throw new Error(`${failed.path ?? `${failed.scope} settings`}: ${failed.error.message}`);
			// A value Pi rejects for the selected model counts as a file that does not load.
			settings.getCompactionSettings(ctx.model);
			compactionProblem = undefined;
			return settings;
		} catch (error) {
			problem("keeps its last reading", error);
			return undefined;
		}
	}

	/** One log line for each new problem, not one for each entry. */
	function problem(outcome: string, error: unknown): void {
		const text = `context share ${outcome}: ${errorText(error)}`;
		if (text !== compactionProblem) operationalError(LOG_FILE, "status-plus", text);
		compactionProblem = text;
	}

	function footerModel(ctx: ExtensionContext, footerData: FooterData): FooterModel {
		const stats = sessionStats(ctx);
		const now = Date.now();
		const facts = readSessionFacts(ctx);
		const rows = footerRows(stats, facts.routed?.provider);
		const usage = facts.usage;
		const windowTokens = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		// The share of where Pi compacts, so 100 percent means it compacts now; the window when it never does.
		const limitTokens = compactionPoint(windowTokens, facts.compaction) ?? windowTokens;
		const windowPercent = usage?.percent ?? undefined;
		// Pi reports null tokens after a compaction until a reply sizes the new context; that is unknown, not empty.
		const usedTokens = usage?.tokens ?? (windowPercent !== undefined ? (windowPercent / 100) * windowTokens : undefined);
		const percent = usedTokens === undefined ? undefined : contextShare(usedTokens, limitTokens);
		return {
			nowMs: now,
			lastApiEndMs: stats.lastApiEndMs,
			cache: cacheState(stats.lastCacheMs, stats.lastContextResetMs, now, cacheTtl(stats.cacheLongRetention, LONG_CACHE)),
			context: { usedTokens, limitTokens, percent },
			// As Pi's own footer: the selection, then where its requests go.
			modelName: facts.routed && facts.routed !== ctx.model ? `${ctx.model?.id} → ${facts.routed.id}` : ctx.model?.id || "no-model",
			providerId: facts.routed?.provider,
			thinkingLevel: ctx.model?.reasoning ? ctx.thinkingLevel || "off" : undefined,
			spend: animatedSpend(rows, now),
			counters: toolCounters(stats),
			cwd: formatCwd(ctx.sessionManager.getCwd()),
			gitBranch: footerData.getGitBranch(),
			sessionName: facts.name,
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
		const toolCalls = toolCount === "calls" ? stats.toolCalls : splitCount(stats.toolCalls, stats.plans, new Map([...liveChains, ...stats.chains]));
		return { prompts: stats.prompts, turns: stats.turns, toolCalls };
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

	/** A click on another extension's status line tells that extension (STATUS_CLICK_EVENT); it decides what the click does. */
	function clickStatus(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const key = statusKeyAt(statusRows, event.y);
		if (key === undefined) return undefined;
		pi.events?.emit(STATUS_CLICK_EVENT, { key });
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
				walk(ctx);
				tui.requestRender();
			});
			return {
				render: (width: number) => {
					keepLinks(tui, linkCopy);
					return renderFooter(ctx, footerData as FooterData, width, theme);
				},
				handleMouse: (event: TuiMouseEvent) => toggleToolCount(event) ?? clickStatus(event),
				invalidate() {},
				dispose() {
					unsubscribe();
					requestFooterRender = undefined;
					// Without the footer nothing keeps the copier current, so Pi's handler goes back.
					keepLinks(tui, undefined);
				},
			};
		});
		return true;
	}

	/**
	 * Give the renderer in use the link copier, or give back Pi's handler. Each
	 * frame checks, because a switch of the TUI mode builds a new renderer and
	 * the footer factory does not run again. A throw here would end Pi.
	 */
	function keepLinks(tui: object, copier: LinkCopier | undefined): void {
		if (linkCopyFailed) return;
		try {
			keepLinkCopy(tui, copier);
		} catch (error) {
			linkCopyFailed = true;
			operationalError(LOG_FILE, "status-plus", `link copy unavailable: ${errorText(error)}`);
		}
	}

	/**
	 * Pi's TUI does not catch a footer's render, and a throw there ends Pi. A
	 * figure the footer cannot draw costs the grid for that frame, not the session.
	 */
	function renderFooter(ctx: ExtensionContext, footerData: FooterData, width: number, theme: Parameters<typeof footerLayout>[2]): string[] {
		try {
			const layout = footerLayout(footerModel(ctx, footerData), width, theme);
			toolsSpan = layout.tools;
			statusRows = layout.statusRows;
			return layout.lines;
		} catch (error) {
			toolsSpan = undefined;
			statusRows = [];
			operationalError(LOG_FILE, "status-plus", `footer render failed: ${errorText(error)}`);
			return [truncateToWidth(FOOTER_FAILED, width, "")];
		}
	}

	/** Walk the transcript again and repaint. The timer always walks: subagents add spend in files of their own. */
	function update(ctx: ExtensionContext): void {
		sessionFacts = undefined;
		walk(ctx);
		requestFooterRender?.();
	}

	/** Timers and Pi's branch listener call this, and a throw from them ends Pi; the last totals stay on screen. */
	function walk(ctx: ExtensionContext): void {
		try {
			refreshStats(ctx);
		} catch (error) {
			operationalError(LOG_FILE, "status-plus", `transcript walk failed: ${errorText(error)}`);
		}
	}

	/**
	 * After an event that may add an entry. Pi tells extensions about a reply
	 * before it saves it, so the walk waits for that, and several events in one
	 * tick share it. If the branch gained nothing, a repaint is enough.
	 */
	function scheduleRefresh(ctx: ExtensionContext): void {
		if (pendingRefresh) return;
		pendingRefresh = setImmediate(() => {
			pendingRefresh = undefined;
			const leaf = leafOf(ctx);
			if (leaf !== undefined && leaf === walkedLeaf) requestFooterRender?.();
			else update(ctx);
		});
	}

	/** Best effort: an agent directory that cannot be written polls on its own, as before. */
	function share(provider: string, poll: SharedPoll): void {
		try {
			writeShared(SHARE_DIR, provider, poll);
		} catch (error) {
			if (!shareFailed) operationalError(LOG_FILE, "status-plus", `could not share the ${provider} limit poll: ${(error as Error).message}`);
			shareFailed = true;
		}
	}

	/**
	 * A fresh poll by another Pi process stands in for one of our own. Otherwise it
	 * lends only its balances: windows move by the minute and headers carry them,
	 * while a monthly budget moves slowly and only a poll reports it.
	 */
	function adoptShared(provider: string, shared: SharedPoll | undefined): void {
		if (!shared?.atMs || !shared.entries?.length || shared.atMs <= (polledAtMs.get(provider) ?? 0)) return;
		polledAtMs.set(provider, shared.atMs);
		const now = Date.now();
		const existing = providerLimits.get(provider);
		const fresh = now - shared.atMs < POLL_FRESH_MS;
		providerLimits.set(provider, fresh && (!existing || shared.atMs > existing.atMs)
			? { entries: markUnsampled(shared.entries), atMs: shared.atMs, source: "poll" }
			: { atMs: shared.atMs, source: "poll", ...existing, entries: withPolledBalances(existing?.entries ?? [], shared.entries, now) });
		requestFooterRender?.();
	}

	/**
	 * Log an approximate reading far from the last usage-endpoint reading, with
	 * both, so a wrong proxy reading can be traced. Claude Code's reading stays
	 * the same between its events, so this process logs each one one time. A
	 * failure here must not fail the poll.
	 */
	function logDisagreements(provider: string, stored: Pick<LimitSnapshot, "entries" | "atMs"> | undefined, polled: LimitEntry[], now: number): void {
		try {
			for (const found of disagreements(stored, polled, now)) {
				const reading = `${provider}|${windowName(found.fresh)}|${found.fresh.usedPct}|${found.fresh.sampledMs}`;
				if (loggedReadings.has(reading)) continue;
				if (loggedReadings.size >= LOGGED_READINGS_MAX) loggedReadings.clear();
				loggedReadings.add(reading);
				operationalLine(LOG_FILE, `[status-plus] ${new Date(now).toISOString()} ${disagreementText(provider, found, now)}`);
			}
		} catch (error) {
			operationalError(LOG_FILE, "status-plus", `disagreement log failed: ${errorText(error)}`);
		}
	}

	/** The newest poll result, this process's or another's, for a partial poll to merge over. */
	function latestPoll(provider: string): Pick<LimitSnapshot, "entries" | "atMs"> | undefined {
		const local = providerLimits.get(provider);
		const shared = readShared(SHARE_DIR, provider);
		const fromFile = shared?.atMs !== undefined && shared.entries ? { entries: shared.entries, atMs: shared.atMs } : undefined;
		const fromStore = local?.source === "poll" ? local : undefined;
		if (!fromFile || !fromStore) return fromFile ?? fromStore;
		return fromFile.atMs > fromStore.atMs ? fromFile : fromStore;
	}

	/**
	 * Poll a provider family's limits at most once a gap across every Pi process
	 * of this agent directory: Anthropic rate-limits its usage endpoint per
	 * account, and processes that each polled on their own clock got 429s and no
	 * budget. Every member's call polls, shares and reads under the family id.
	 */
	async function refreshProviderLimits(member: string, ctx: ExtensionContext, force = false): Promise<void> {
		if (isOffline() || process.env.STATUS_PLUS_POLL_LIMITS === "0") return;
		const provider = limitFamily(member);
		if (!provider) return;
		const poller = LIMIT_POLLERS[provider]!;
		const shared = readShared(SHARE_DIR, provider);
		adoptShared(provider, shared);
		const failures = shared?.failures ?? pollFailures.get(provider) ?? 0;
		const gap = force ? FORCED_POLL_FLOOR_MS : pollGapMs(poller.interval(ctx), failures, providerLimits.isHot(provider));
		const triedAtMs = Date.now();
		if (triedAtMs < Math.max(nextPollMs(lastPollMs.get(provider) ?? 0, shared, gap), retryAtMs.get(provider) ?? 0)) return;
		lastPollMs.set(provider, triedAtMs);
		// Claim the try first, so the other processes wait for its result instead of asking too.
		const claimed: SharedPoll = { ...(readShared(SHARE_DIR, provider) ?? shared), triedAtMs, failures };
		share(provider, claimed);
		try {
			const polled = await poller.poll(ctx);
			// No credentials or no data: back off rather than retry every interval.
			if (!polled || polled.length === 0) return pollFailed(provider, claimed);
			const atMs = Date.now();
			// Each entry carries its sample time, so a later partial poll can tell a recent reading from one an older copy wrote.
			const stored = latestPoll(provider);
			logDisagreements(provider, stored, polled, atMs);
			const entries = mergePolled(stored, polled, atMs).map((entry) => entry.sampledMs !== undefined ? entry : { ...entry, sampledMs: atMs });
			pollFailures.set(provider, 0);
			polledAtMs.set(provider, atMs);
			providerLimits.set(provider, { entries, atMs, source: "poll" });
			share(provider, { atMs, entries, triedAtMs, failures: 0 });
			requestFooterRender?.();
		} catch (error) {
			const refusal = error instanceof PollRefused ? error : undefined;
			if (refusal?.retryAfterMs) retryAtMs.set(provider, triedAtMs + refusal.retryAfterMs);
			pollFailed(provider, refusal?.retryAfterMs ? { ...claimed, retryAtMs: triedAtMs + refusal.retryAfterMs } : claimed);
			// Best-effort: a failed poll must never fail Pi, but it should be findable.
			operationalError(LOG_FILE, "status-plus", `${provider} limit poll failed: ${refusal?.message ?? (error as Error)?.name ?? "error"}`);
		}
	}

	function pollFailed(provider: string, claimed: SharedPoll): void {
		pollFailures.set(provider, claimed.failures + 1);
		share(provider, { ...claimed, failures: claimed.failures + 1 });
	}

	/** One poll for each family this branch used or the selection routes to. */
	function schedulePolls(ctx: ExtensionContext): void {
		const routed = routedModel(ctx)?.provider;
		// One plan member asks for each family's poll; a per-token API key asks for none.
		const members = new Map<string, string>();
		for (const provider of [...seenProviders, ...(routed ? [routed] : [])]) {
			const family = limitFamily(provider);
			if (family && !members.has(family)) members.set(family, provider);
		}
		for (const member of members.values()) void refreshProviderLimits(member, ctx);
	}

	/**
	 * Under a virtual selection, response headers wait for the reply: only it
	 * names the provider the request went to, and the router can switch providers.
	 */
	let virtualHeaders: Record<string, string> | undefined;

	pi.on("after_provider_response", async (event, ctx) => {
		latestCtx = ctx;
		if (isVirtualModel(ctx.model)) {
			virtualHeaders = event.headers;
			return;
		}
		applyHeaders(ctx.model?.provider, event.headers);
	});

	function applyHeaders(member: string | undefined, headers: Record<string, string>): void {
		if (!member) return;
		const entries = parseLimitHeaders(member, headers);
		// The plan's reading for a plan login, the key's own for an API key (lib/plan-billing.ts).
		const provider = limitKey(member);
		if (entries.length === 0) return;
		// Headers must not clobber a fresh, richer poll snapshot between polls.
		const existing = providerLimits.get(provider);
		if (existing?.source === "poll" && Date.now() - existing.atMs < POLL_FRESH_MS) return;
		// Headers carry windows but never money: keep the balance the last poll found.
		providerLimits.set(provider, { entries: withPolledBalances(entries, existing?.entries, Date.now()), atMs: Date.now(), source: "headers" });
		requestFooterRender?.();
	}

	pi.on("turn_start", async () => {
		awaitingReply = true;
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (!awaitingReply) return;
		const sourceProvider = routedModel(ctx)?.provider ?? "unknown";
		if (sourceProvider === "opencode-go") {
			// The usage endpoint is the only authoritative signal that Go has
			// exhausted a window and a successful request will use Zen balance.
			await refreshProviderLimits(sourceProvider, ctx, true);
		}
		const billingProvider = sourceProvider === "opencode-go" && openCodeGoUsesZenBalance() ? "opencode" : sourceProvider;
		inflight = { provider: billingProvider, startedMs: Date.now() };
		requestFooterRender?.();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		awaitingReply = false;
		if (virtualHeaders) applyHeaders(event.message.provider, virtualHeaders);
		virtualHeaders = undefined;
		if (event.message.provider === "opencode-go" && inflight?.provider === "opencode") {
			pi.appendEntry(BILLING_SOURCE_ENTRY, {
				messageTimestampMs: toEpochMs(event.message.timestamp),
				provider: "opencode",
			} satisfies BillingSourceEntry);
		}
		if (inflight && !inflight.endedMs) inflight.endedMs = Date.now();
		scheduleRefresh(ctx);
		schedulePolls(ctx);
	});

	// The new selection's limits, now rather than on the next timer tick: a fresh shared poll is read
	// at once, and an own poll keeps the usual gap.
	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		const provider = routedModel(ctx)?.provider;
		requestFooterRender?.();
		// Not awaited: a slow usage endpoint must not hold up the switch. The poll repaints when it lands.
		if (provider) void refreshProviderLimits(provider, ctx);
	});

	// A compaction is billed but ends no turn; show its charge now rather than on the next timer tick.
	pi.on("session_compact", async (_event, ctx) => scheduleRefresh(ctx));

	pi.on("turn_end", async (_event, ctx) => {
		// Close a dangling interval (e.g. aborted request with no message_end).
		awaitingReply = false;
		if (inflight && !inflight.endedMs) inflight.endedMs = Date.now();
		scheduleRefresh(ctx);
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
		if (STATUS_TIME_ZONE_PROBLEM && !zoneLogged) operationalLine(LOG_FILE, `[status-plus] ${new Date().toISOString()} ${STATUS_TIME_ZONE_PROBLEM}`);
		zoneLogged = true;
		latestCtx = ctx;
		liveChains.clear();
		toolCount = readToolCount();
		linkCopy = isRemoteSession(process.env) && readCopyLinks() ? linkCopier({
			copy: copyToClipboard,
			notify: (message, type) => ctx.ui.notify(message, type),
			report: (error) => operationalError(LOG_FILE, "status-plus", `link notice failed: ${errorText(error)}`),
		}) : undefined;
		providerLimits.setRefresher(async (provider, force) => {
			if (latestCtx) await refreshProviderLimits(provider, latestCtx, force);
		});
		// New or resumed session: its first total is the baseline, not a change to animate.
		costTween = undefined;
		stopCatchUp();
		if (frameTimer) clearTimeout(frameTimer);
		frameTimer = undefined;
		// Clear leftovers from previous versions of this extension; the grid
		// footer carries everything the old status segment showed.
		ctx.ui.setWidget("status-plus-limits", undefined);
		ctx.ui.setStatus("status-plus-limits", undefined);
		ctx.ui.setStatus("status-plus", undefined);
		// An anthropic API key reads no plan windows and starts no plan poll, even when another process's
		// poll stands in for ours: learn it before the first frame, waiting a second at most.
		if (!isOffline() && process.env.STATUS_PLUS_POLL_LIMITS !== "0") {
			await Promise.race([noteAnthropicCredential(ctx).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, CREDENTIAL_WAIT_MS).unref())]);
			if (latestCtx !== ctx) return;
		}
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
		if (pendingRefresh) clearImmediate(pendingRefresh);
		pendingRefresh = undefined;
		stopCatchUp();
		providerLimits.setRefresher(undefined);
		latestCtx = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (frameTimer) clearTimeout(frameTimer);
		frameTimer = undefined;
	});
}
