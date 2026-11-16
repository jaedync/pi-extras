/**
 * usage-guard: a `usage` tool the agent can call, a `/usage` command, and
 * one-shot threshold warnings, all built on the limit snapshots status-plus
 * polls into the shared store (lib/limit-store.ts).
 *
 * Warnings fire on band transitions within a reset cycle, at request-context
 * assembly. Idle polls update proximity without queueing stale instructions
 * for a model the user may switch away from. Fired keys and the session budget persist
 * as custom session entries; a resumed session does not repeat them.
 */
import { dirname, join } from "node:path";
import { defineTool, getAgentDir, type ContextEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readSection, updateSection } from "../lib/extras-config.ts";
import { sharedLimitStore, type LimitSnapshot, type LimitStore } from "../lib/limit-store.ts";
import { limitKey, planMember, storeKey } from "../lib/plan-billing.ts";
import { operationalError } from "../lib/operational-log.ts";
import { markRow } from "../lib/tool-row.ts";
import { parseRateLimit } from "../lib/rate-limit-recovery/core.ts";
import { routedModel } from "../lib/routed-model.ts";
import { createDollarsCollector, type DollarsCollector } from "../lib/usage-dollars/collect.ts";
import {
	FRESH_EVIDENCE_MS,
	entryApplies,
	hotProviders,
	isUnmetered,
	normalizeGuardConfig,
	pendingWarnings,
	pricedProviders,
	rearmableKeys,
	unavailableLimits,
	unmeteredModel,
	usageReport,
	warningApplies,
	warningMessage,
	type ActiveModel,
	type CollectedDollars,
	type GuardConfig,
	type SessionBudget,
	type Warning,
} from "../lib/usage-guard-core.ts";

const AGENT_DIR = getAgentDir();
export const CONFIG_FILE = join(AGENT_DIR, "pi-extras.json");
const DEFAULT_LOG_FILE = join(AGENT_DIR, "usage-guard.log");
const CONFIG_KEY = "usageGuard";
/** Session entries (fired keys, budget) and injected messages share one type. */
export const GUARD_CUSTOM_TYPE = "usage-guard";
const USAGE_HELP = "Usage: /usage | /usage budget <window> <pct> | /usage budget clear | /usage warnings on|off";

interface GuardEntry {
	fired?: string[];
	/** The percent of the reading that fired the keys in `fired`; a granted reset re-arms them. */
	pct?: number;
	/** Keys armed again after a granted reset. */
	rearmed?: string[];
	budget?: SessionBudget | null;
}

type DeliverAs = "steer" | "nextTurn";
type CustomMessage = Extract<ContextEvent["messages"][number], { role: "custom" }>;

/** `PI_EXTRAS_USAGE_GUARD=1` or `0` turns band warnings on or off for one run without touching the file. */
export function loadGuardConfig(file = CONFIG_FILE, env: NodeJS.ProcessEnv = process.env): GuardConfig {
	const config = normalizeGuardConfig(readSection(CONFIG_KEY, file));
	const override = env.PI_EXTRAS_USAGE_GUARD;
	if (override === "0") return { ...config, enabled: false };
	if (override === "1") return { ...config, enabled: true };
	return config;
}

/**
 * Merge a patch into the guard section, preserving any other keys in the file.
 * Throws `UnreadableJsonError`, and keeps the file, when it does not parse.
 */
export function saveGuardConfig(patch: Partial<GuardConfig>, file = CONFIG_FILE): GuardConfig {
	return normalizeGuardConfig(updateSection(CONFIG_KEY, (current) => ({ ...normalizeGuardConfig({ ...current, ...patch }) }), file));
}

/** "7d 60" -> budget; "clear" -> null; anything else -> undefined. */
export function parseBudgetArgs(words: string[]): SessionBudget | null | undefined {
	if (words[0] === "clear" && words.length === 1) return null;
	const pct = Number(words[1]);
	if (words.length !== 2 || !words[0] || !Number.isFinite(pct) || pct <= 0 || pct > 100) return undefined;
	return { window: words[0], pct };
}

interface InScopeModel { provider: string; id: string; cost?: Parameters<typeof isUnmetered>[0] }

/** Providers with a priced model in the catalog; a registry that fails to list gives none. */
function catalogPriced(ctx: Pick<ExtensionContext, "modelRegistry">): Set<string> {
	try {
		const registry = ctx.modelRegistry as { getAll?: () => InScopeModel[] } | undefined;
		return pricedProviders(typeof registry?.getAll === "function" ? registry.getAll() : []);
	} catch {
		return new Set();
	}
}

/** The model whose limits apply: under a virtual selection, the one it routed to. */
function activeModel(ctx: Pick<ExtensionContext, "model" | "sessionManager" | "modelRegistry">, priced?: ReadonlySet<string>): ActiveModel {
	const model = routedModel(ctx);
	// Listing the catalog builds every model; a usage call lists it once and passes it in.
	const unmetered = model ? unmeteredModel(model, priced ?? catalogPriced(ctx)) : false;
	return { provider: model?.provider, id: model?.id, ...(unmetered ? { unmetered: true } : {}) };
}

/**
 * The models this session or its subagents may use: the scoped models, or,
 * when none are scoped, every model with credentials. A registry that fails
 * to list leaves the scoped list, which may be empty.
 */
function modelsInScope(ctx: Pick<ExtensionContext, "scopedModels" | "modelRegistry">, logFile: string): InScopeModel[] {
	const scoped = (ctx.scopedModels ?? []).map((entry) => entry.model);
	if (scoped.length) return scoped;
	try {
		const registry = ctx.modelRegistry as { getAvailable?: () => InScopeModel[] } | undefined;
		return typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
	} catch (error) {
		operationalError(logFile, "usage-guard", `model list failed: ${(error as Error)?.message ?? "error"}`);
		return [];
	}
}

/** Models in scope a subagent can use without touching any limit. */
function unmeteredScoped(models: readonly InScopeModel[], priced: ReadonlySet<string>): string[] {
	return models.filter((model) => unmeteredModel(model, priced)).map((model) => `${model.provider}/${model.id}`);
}

function slowPollNote(providers: readonly string[], budgetMs: number): string {
	const names = [...new Set(providers)].join(", ");
	return `The limit poll for ${names} did not answer within ${budgetMs / 1000} s, so this report uses the last reading (none for a provider not read yet). The poll goes on; the next usage call sees its result.`;
}

function idle(ctx: ExtensionContext): boolean {
	return typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
}

export interface UsageGuardOptions {
	store?: LimitStore;
	configFile?: string;
	now?: () => number;
	/** Defaults to one that reads the agent directory holding configFile. */
	dollars?: DollarsCollector;
	/** Where operational errors go; defaults to usage-guard.log in the agent directory. */
	logFile?: string;
	/** How long the usage tool waits for limit polls before it reports the last readings. */
	pollBudgetMs?: number;
}

/**
 * A limit poll answers in well under a second, but an endpoint can hang until
 * its 10 s timeout. Past this, the report uses the last reading; the poll goes
 * on and lands in the store for the next call.
 */
const POLL_BUDGET_MS = 2_000;

/** A notice in a request, with the sample time of its reading. */
interface Queued {
	notice: CustomMessage;
	sampledMs: number;
}

/**
 * A 429 with a retry time shorter than this is a burst limit (requests or
 * tokens per minute), not a quota window: it is no evidence of a block.
 */
const BURST_RETRY_SECONDS = 15 * 60;

/**
 * A block warning needs an exact reading at or above this percent, or none.
 * Below it a "rejected" status can be one that a proxy kept after a granted
 * reset (Meridian), and a quota rejection names no window, so a low-percent
 * block is left to the provider's own error: a false block stops the agent.
 */
const NEAR_FULL_PCT = 95;

/** The percent a fired key stands for when its entry has none (older versions): a block is 100, a band its threshold. */
function keyPct(key: string): number | undefined {
	const parts = key.split("|");
	const threshold = parts.at(-2) ?? "";
	if (threshold === "x") return 100;
	const pct = Number(threshold.replace(/^b/, ""));
	return threshold !== "" && Number.isFinite(pct) ? pct : undefined;
}

export default function usageGuard(pi: ExtensionAPI, options: UsageGuardOptions = {}): void {
	const store = options.store ?? sharedLimitStore();
	const configFile = options.configFile ?? CONFIG_FILE;
	const now = options.now ?? Date.now;
	const logFile = options.logFile ?? DEFAULT_LOG_FILE;
	const pollBudgetMs = options.pollBudgetMs ?? POLL_BUDGET_MS;
	let config = loadGuardConfig(configFile);
	// pi-extras.json sits in the agent directory, next to the sessions the ledger reads.
	const dollars = options.dollars ?? createDollarsCollector({ agentDir: dirname(configFile), configFile });
	let fired = new Set<string>();
	/** By fired key: the percent of the reading that fired it, when known. */
	let firedPct = new Map<string, number | undefined>();
	/**
	 * Notices already in a request but not yet shown or recorded. The turn end
	 * shows each one that the newest reading still supports and drops the rest.
	 */
	let queued: Queued[] = [];
	/** By limit family, then model id: when a response last succeeded, which disproves an older block. */
	const succeededAt = new Map<string, Map<string, number>>();
	/** Limit families with a quota rejection that no turn end has handled yet. */
	const rejectedInRun = new Set<string>();
	/** By limit family: when a stale final warning last asked for a forced poll. */
	const confirmAskedAt = new Map<string, number>();
	let budget: SessionBudget | undefined;
	let latestCtx: ExtensionContext | undefined;
	/**
	 * Set at session_shutdown. Pi stops this instance's ctx right after it, yet
	 * events can still come: a quit in mid-turn aborts the turn after shutdown,
	 * and its turn_end carries the stopped ctx. Every read of that ctx throws.
	 */
	let closed = false;

	function restore(ctx: ExtensionContext): void {
		fired = new Set();
		firedPct = new Map();
		queued = [];
		budget = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== GUARD_CUSTOM_TYPE) continue;
			const data = (entry as { data?: GuardEntry }).data;
			for (const key of data?.fired ?? []) {
				fired.add(key);
				firedPct.set(key, typeof data?.pct === "number" ? data.pct : keyPct(key));
			}
			for (const key of data?.rearmed ?? []) {
				fired.delete(key);
				firedPct.delete(key);
			}
			if (data && "budget" in data) budget = data.budget ?? undefined;
		}
	}

	function sampledAt(warning: Warning): number {
		return warning.entry.sampledMs ?? store.get(warning.provider)?.atMs ?? -Infinity;
	}

	/** True when a model that the window governs got a response after `since`. */
	function succeededAfter(provider: string, modelFamily: string | undefined, since: number): boolean {
		for (const [id, at] of succeededAt.get(provider) ?? []) {
			if (at > since && entryApplies({ label: "", modelFamily }, { provider, id })) return true;
		}
		return false;
	}

	/**
	 * Only a reading names a blocked window: a quota rejection starts a poll
	 * (showRejected) but is no evidence alone. The reading must be fresh, no
	 * success of a governed model may come after it, and an exact percent must
	 * be near full (NEAR_FULL_PCT).
	 */
	function blockEvidenced(provider: string, entry: Warning["entry"], sampled: number): boolean {
		if (now() - sampled > FRESH_EVIDENCE_MS || succeededAfter(provider, entry.modelFamily, sampled)) return false;
		const pct = entry.approximate ? undefined : entry.usedPct;
		return pct === undefined || pct >= NEAR_FULL_PCT;
	}

	function supported(warning: Warning): boolean {
		return warning.reason !== "exhausted" || blockEvidenced(warning.provider, warning.entry, sampledAt(warning));
	}

	/**
	 * A block notice in history stays in requests only on fresh evidence that a
	 * success has not disproved: a granted reset keeps the reset time, so the
	 * proxy's old sample alone does not show that it is gone.
	 */
	function staleBlock(details: unknown): boolean {
		const record = details as { reason?: unknown; provider?: unknown; key?: unknown; modelFamily?: unknown; sampledMs?: unknown } | undefined;
		if (record?.reason !== "exhausted" || typeof record.provider !== "string" || typeof record.key !== "string") return false;
		const modelFamily = typeof record.modelFamily === "string" ? record.modelFamily : undefined;
		if (typeof record.sampledMs === "number" && succeededAfter(record.provider, modelFamily, record.sampledMs)) return true;
		const snapshot = store.get(record.provider);
		const window = record.key.split("|").slice(1, -2).join("|");
		const entry = snapshot?.entries.find((candidate) => (candidate.key ?? candidate.label) === window);
		if (!entry) return false;
		return !blockEvidenced(record.provider, entry, entry.sampledMs ?? snapshot?.atMs ?? -Infinity);
	}

	function fresh(warning: Warning): boolean {
		return now() - sampledAt(warning) <= FRESH_EVIDENCE_MS;
	}

	/** A granted reset arms the window's warnings again. */
	function rearm(snapshots: Array<[string, LimitSnapshot]>, model: ActiveModel): void {
		const keys = rearmableKeys(snapshots, model, firedPct, now());
		if (!keys.length) return;
		for (const key of keys) {
			fired.delete(key);
			firedPct.delete(key);
		}
		pi.appendEntry(GUARD_CUSTOM_TYPE, { rearmed: keys } satisfies GuardEntry);
	}

	/**
	 * At a turn end, show and record each queued notice the newest reading
	 * still supports. A dropped one leaves its key unfired, so it can fire
	 * again when it is true.
	 */
	function flush(ctx: ExtensionContext): void {
		if (!queued.length) return;
		const items = queued;
		queued = [];
		const model = activeModel(ctx);
		const snapshot = model.provider ? store.get(limitKey(model.provider)) : undefined;
		for (const { notice, sampledMs } of items) {
			const details = notice.details as { key: string; pct?: number; provider: string; modelFamily?: string; reason: string };
			// Only a reading at least as new as the one that fired the notice, and not approximate, can disprove it.
			const newer = snapshot && { ...snapshot, entries: snapshot.entries.filter((entry) => !entry.approximate && (entry.sampledMs ?? snapshot.atMs) >= sampledMs) };
			const disproved = details.reason === "exhausted" && succeededAfter(details.provider, details.modelFamily, sampledMs);
			if (disproved || !warningApplies(notice.details, model, now(), newer, budget ?? null)) {
				fired.delete(details.key);
				firedPct.delete(details.key);
				continue;
			}
			pi.appendEntry(GUARD_CUSTOM_TYPE, { fired: [details.key], ...(details.pct !== undefined ? { pct: details.pct } : {}) } satisfies GuardEntry);
			pi.sendMessage(notice, { triggerTurn: false });
		}
	}

	/**
	 * Before a final warning from old evidence enters a request, ask once a
	 * minute per family for a forced poll, within the poll budget: a granted
	 * reset since that reading shows only in a newer one.
	 */
	async function confirmStale(ctx: ExtensionContext): Promise<void> {
		const model = activeModel(ctx);
		const providers = new Set(pendingWarnings(store.entries(), model, config, budget, fired, now())
			.filter((warning) => warning.final && !fresh(warning)).map((warning) => warning.provider));
		const polls: Array<[string, Promise<boolean>]> = [];
		for (const provider of providers) {
			if (now() - (confirmAskedAt.get(provider) ?? -Infinity) < FRESH_EVIDENCE_MS) continue;
			confirmAskedAt.set(provider, now());
			polls.push([provider, store.refresh(planMember(provider), true)]);
		}
		if (polls.length) await withinBudget(polls);
	}

	function setBudget(next: SessionBudget | undefined): void {
		budget = next;
		pi.appendEntry(GUARD_CUSTOM_TYPE, { budget: next ?? null } satisfies GuardEntry);
	}

	/**
	 * Explicit snapshots use the requested queue. Automatic notices instead
	 * enter the current request in the context hook, without starting another run.
	 */
	function deliver(content: string, deliverAs: DeliverAs, details?: unknown): void {
		pi.sendMessage(
			{ customType: GUARD_CUSTOM_TYPE, content, display: true, ...(details !== undefined ? { details } : {}) },
			{ deliverAs },
		);
	}

	/** Dollar figures fail open: the percent report still goes out without them. */
	async function collectDollars(ctx: ExtensionContext, force: boolean, model: ActiveModel): Promise<CollectedDollars | undefined> {
		try {
			return await dollars.collect({
				snapshots: store.entries(),
				model,
				scopedModels: (ctx.scopedModels ?? []).map((scoped) => ({ provider: scoped.model.provider, id: scoped.model.id })),
				getApiKey: async (provider) => ctx.modelRegistry?.getApiKeyForProvider(provider),
				now: now(),
				force,
			});
		} catch (error) {
			operationalError(logFile, "usage-guard", `dollars failed: ${(error as Error)?.message ?? "error"}`);
			return undefined;
		}
	}

	/**
	 * Wait for the polls up to the budget. Returns the providers whose poll
	 * still runs. A poll that fails is logged; the report uses the last reading.
	 */
	async function withinBudget(polls: ReadonlyArray<readonly [string, Promise<unknown>]>, waitMs = pollBudgetMs): Promise<string[]> {
		const running = new Set(polls.map(([provider]) => provider));
		const settled = Promise.all(polls.map(([provider, poll]) => poll.then(
			() => { running.delete(provider); },
			(error: unknown) => {
				running.delete(provider);
				operationalError(logFile, "usage-guard", `${provider} limit refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			},
		)));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
		try {
			await Promise.race([settled, budget]);
		} finally {
			clearTimeout(timer);
		}
		return [...running];
	}

	/** A first, unforced read for each plan or key the store has no snapshot of, asked once by one of its providers. */
	function readUnknown(providers: ReadonlyArray<string | undefined>): Array<[string, Promise<boolean>]> {
		const known = new Set(store.entries().map(([provider]) => storeKey(provider)));
		const unknown = new Map<string, string>();
		for (const provider of providers) {
			if (!provider) continue;
			const key = limitKey(provider);
			if (!known.has(key) && !unknown.has(key)) unknown.set(key, provider);
		}
		return [...unknown].map(([key, provider]) => [key, store.refresh(provider, false)]);
	}

	/**
	 * After a quota rejection, poll once and show the block warnings that the
	 * new reading supports: a proxy samples the window that rejected the
	 * request, and the request may have been built on an older reading.
	 */
	async function showRejected(ctx: ExtensionContext): Promise<void> {
		const provider = activeModel(ctx).provider;
		// Another family's rejection waits for a turn end on that family: evaluate sees only the active one.
		if (!provider || !rejectedInRun.delete(limitKey(provider))) return;
		const family = limitKey(provider);
		confirmAskedAt.set(family, now());
		await withinBudget([[family, store.refresh(planMember(family), true)]]);
		if (closed) return;
		evaluate(ctx, true, (warning) => warning.reason === "exhausted");
		flush(ctx);
	}

	function evaluate(ctx: ExtensionContext, deliverWarnings = false, only: (warning: Warning) => boolean = () => true): CustomMessage[] {
		try {
			const snapshots = store.entries();
			const model = activeModel(ctx);
			rearm(snapshots, model);
			const hot = hotProviders(snapshots, model, config, budget, now());
			for (const [provider] of snapshots) store.setHot(provider, hot.has(provider));
			if (!deliverWarnings) return [];
			return pendingWarnings(snapshots, model, config, budget, fired, now()).filter((warning) => only(warning) && supported(warning)).map((warning) => {
				// A block counts as 100% when its reading has no exact percent, so a granted reset can re-arm it.
				const pct = warning.entry.approximate ? (warning.reason === "exhausted" ? warning.entry.usedPct ?? 100 : undefined) : warning.entry.usedPct;
				const sampledMs = sampledAt(warning);
				const notice: CustomMessage = {
					role: "custom", customType: GUARD_CUSTOM_TYPE, display: true, timestamp: now(),
					content: warningMessage(warning, config, now()),
					details: {
						key: warning.key, provider: warning.provider, modelFamily: warning.entry.modelFamily,
						threshold: warning.threshold, reason: warning.reason, final: warning.final,
						...(pct !== undefined ? { pct } : {}),
						...(Number.isFinite(sampledMs) ? { sampledMs } : {}),
					},
				};
				fired.add(warning.key);
				firedPct.set(warning.key, pct);
				// The returned projection reaches this request now. The turn end shows and
				// records it, if a newer reading has not disproved it by then (flush).
				queued.push({ notice, sampledMs });
				return notice;
			});
		} catch (error) {
			operationalError(logFile, "usage-guard", `evaluate failed: ${(error as Error)?.message ?? "error"}`);
			return [];
		}
	}

	// Tool Display draws these rows with its band.
	pi.registerTool(markRow(defineTool({
		name: "usage",
		label: "Usage limits",
		description:
			"Report subscription usage limits for the active model: rolling windows (5h, 7d, model-specific weekly), " +
			"percent used, thresholds, reset time, seconds until reset, a resume delay, and usage pace. " +
			"Pace estimates usage at reset from the average rate since the window began; early windows omit the projection. " +
			"Balances (budget, credits) are reported but never warned on, except a proxy's monthly extra-usage cap, " +
			"which warns at the same bands as a window. " +
			"Dollar figures: each limit's `dollars` gives spend, size and remaining USD (implied for subscription windows, " +
			"plan caps per model for OpenCode Go, the provider's own meter or balance otherwise); a monthly meter adds " +
			"business days left and a per-business-day share. The top-level `dollars` gives spend today in the local time zone " +
			"and the tightest remaining USD per provider. " +
			"Providers of one plan report as one family, under its id: claude-code as anthropic, openai as openai-codex. " +
			"setBudget records a session budget: a warning point (not a stop) that fires once when that window reaches pct.",
		promptSnippet: "Check subscription usage limits, resets, and the session usage budget",
		promptGuidelines: [
			"Use usage before long autonomous work and whenever the user names a usage point (for example: tell me at 60% of the weekly limit); pass setBudget so a warning fires at that point. A budget warns; it does not stop work unless the user said to stop there.",
			"Usage warnings are not a reason to cut work short: finish tasks that fit in the remaining headroom.",
			"Before starting subagents, call usage with all: true and size each run's maxCost from dollars.providers.<provider family>.remainingUsd (remainingUsdByModel for OpenCode Go) and, for a monthly meter, leftTodayUsd. maxCost is list price: when the meter's dollars give meterPerListDollar, set maxCost to the meter dollars divided by it. Report the meter figures (meterSpentTodayUsd, leftTodayUsd), not the list* figures, as the spend against a meter budget. Treat implied figures as estimates and leave margin.",
			"When a window near its limit is waitable (resets within a few hours) and work remains, keep going past it: at a clean checkpoint start a background shell job running `sleep <resumeAfterSeconds>` titled \"Wait for usage reset\", end the turn, and continue the task when it completes. Stop and report only when the reset is too far away to wait for, or at a point where the user said to stop.",
		],
		parameters: Type.Object({
			refresh: Type.Optional(Type.Boolean({ description: "Poll the provider now instead of reading the cached snapshot." })),
			all: Type.Optional(Type.Boolean({ description: "Include other providers and windows that do not govern the active model." })),
			setBudget: Type.Optional(Type.Object({
				window: Type.String({ minLength: 1, maxLength: 32, description: "Window label or key, e.g. \"7d\", \"5h\", \"7d-fable\"." }),
				pct: Type.Number({ minimum: 1, maximum: 100, description: "Warn once when the window reaches this percent." }),
			}, { description: "Record a session usage warning point for one window; it does not stop work." })),
			clearBudget: Type.Optional(Type.Boolean({ description: "Remove the session budget." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (params.clearBudget) setBudget(undefined);
			if (params.setBudget) setBudget({ window: params.setBudget.window.trim(), pct: params.setBudget.pct });
			const priced = catalogPriced(ctx);
			const model = activeModel(ctx, priced);
			const inScope = params.all ? modelsInScope(ctx, logFile) : [];
			const started = Date.now();
			const forced: Array<[string, Promise<boolean>]> = [];
			if (params.refresh) {
				const providers = params.all ? store.entries().map(([provider]) => provider) : [];
				if (model.provider && !providers.includes(limitKey(model.provider))) providers.push(model.provider);
				// A plan's reading is asked for through a member that bills it (claude-code when Pi's anthropic credential is an API key).
				for (const provider of providers) forced.push([limitKey(provider), store.refresh(planMember(provider), true)]);
			}
			const slowForced = await withinBudget(forced);
			// Status Plus polls only providers this session has used or selected; the active one may not
			// be read yet, and a subagent may run on any model in scope, so its limits must be known before
			// it starts. Not forced: the shared poll gap still holds, and a provider with no poller is skipped.
			// One budget for both waits: first reads get what the forced polls left.
			const left = Math.max(0, pollBudgetMs - (Date.now() - started));
			const slow = [...slowForced, ...await withinBudget(readUnknown([model.provider, ...inScope.filter((entry) => !unmeteredModel(entry, priced)).map((entry) => entry.provider)]), left)];
			const collected = await collectDollars(ctx, params.refresh === true, model);
			const snapshots = store.entries();
			const full = usageReport(snapshots, model, config, budget, now(), params.all === true, undefined, collected,
				unmeteredScoped(inScope, priced), unavailableLimits(inScope.map((entry) => ({ provider: entry.provider, ...(unmeteredModel(entry, priced) ? { unmetered: true } : {}) })), snapshots));
			const report = slow.length ? { ...full, notes: [...full.notes, slowPollNote(slow, pollBudgetMs)] } : full;
			return { content: [{ type: "text", text: JSON.stringify(report, null, 1) }], details: report };
		},
	}), "usage"));

	pi.registerCommand("usage", {
		description: "Inject usage limits into context; `budget <window> <pct>|clear`; `warnings on|off`",
		getArgumentCompletions: (prefix: string) => {
			const items = ["budget ", "budget clear", "warnings on", "warnings off"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value.trim() }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words[0] === "warnings") {
				if (words[1] !== "on" && words[1] !== "off") return ctx.ui.notify(USAGE_HELP, "warning");
				config = { ...config, enabled: words[1] === "on" };
				try {
					config = saveGuardConfig({ enabled: config.enabled }, configFile);
				} catch (error) {
					return ctx.ui.notify(`Usage warnings ${config.enabled ? "on" : "off"} for this session only. ${(error as Error).message}`, "error");
				}
				return ctx.ui.notify(`Usage warnings ${config.enabled ? "on" : "off"}`, "info");
			}
			if (words[0] === "budget") {
				const parsed = parseBudgetArgs(words.slice(1));
				if (parsed === undefined) return ctx.ui.notify(USAGE_HELP, "warning");
				setBudget(parsed ?? undefined);
				return ctx.ui.notify(parsed ? `Session budget: ${parsed.window} at ${parsed.pct}%` : "Session budget cleared", "info");
			}
			if (words.length) return ctx.ui.notify(USAGE_HELP, "warning");
			const model = activeModel(ctx);
			const slow = await withinBudget(readUnknown([model.provider]));
			const collected = await collectDollars(ctx, false, model);
			const full = usageReport(store.entries(), model, config, budget, now(), false, undefined, collected);
			const report = slow.length ? { ...full, notes: [...full.notes, slowPollNote(slow, pollBudgetMs)] } : full;
			deliver(`Current usage limits:\n${JSON.stringify(report, null, 1)}`, idle(ctx) ? "nextTurn" : "steer", report);
			ctx.ui.notify(idle(ctx) ? "Usage snapshot queued for the next turn" : "Usage snapshot queued for the agent", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		closed = false;
		succeededAt.clear();
		rejectedInRun.clear();
		confirmAskedAt.clear();
		latestCtx = ctx;
		config = loadGuardConfig(configFile);
		restore(ctx);
		evaluate(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (closed) return;
		latestCtx = ctx;
		evaluate(ctx);
	});

	// No ctx here: a rejection in the last message of a quit still counts for the next session.
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const family = limitKey(message.provider);
		if (["stop", "toolUse"].includes(message.stopReason)) {
			store.recordSuccess(family, message.model, now());
			succeededAt.set(family, new Map(succeededAt.get(family)).set(message.model, now()));
			return;
		}
		const limit = message.stopReason === "error" ? parseRateLimit(message.errorMessage) : undefined;
		// A burst limit does not name a quota window, so it is no evidence that one is blocked.
		if (!limit || (limit.retryAfterSeconds !== undefined && limit.retryAfterSeconds < BURST_RETRY_SECONDS)) return;
		rejectedInRun.add(family);
		store.recordRejection(family, message.model, now());
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (closed) return;
		latestCtx = ctx;
		flush(ctx);
		await showRejected(ctx);
		if (closed) return;
		evaluate(ctx);
	});

	// A run that ends without a turn end (an aborted request) still shows what its request carried.
	pi.on("agent_end", async (_event, ctx) => {
		if (closed) return;
		latestCtx = ctx;
		flush(ctx);
		await showRejected(ctx);
	});

	// Prompts, automatic job wakes and queued follow-ups all share this request
	// boundary. before_agent_start alone misses the latter two.
	pi.on("context", async (event, ctx) => {
		if (closed) return undefined;
		latestCtx = ctx;
		await confirmStale(ctx);
		if (closed) return undefined;
		const notices = evaluate(ctx, true);
		const model = activeModel(ctx);
		return {
			messages: [...event.messages.filter((message) => message.role !== "custom" ||
				message.customType !== GUARD_CUSTOM_TYPE || !staleBlock(message.details) && warningApplies(message.details, model, now(), (model.provider ? store.get(limitKey(model.provider)) : undefined), budget ?? null)), ...notices],
		};
	});

	// Idle polls still select faster polling near a threshold, but never persist
	// a fired key or queue model-facing text before the next prompt chooses its model.
	const unsubscribe = store.subscribe(() => {
		// The first meter reading of the day anchors "spent today", and each window reading can show a
		// granted reset, for every process. Only polls see every reading; usage calls come too late.
		// observe() isolates its two steps and keeps their failures for the report's notes; this guard
		// only keeps an unexpected error out of the poll loop.
		try {
			dollars.observe(store.entries(), now());
		} catch (error) {
			operationalError(logFile, "usage-guard", `dollars observe failed: ${(error as Error)?.message ?? "error"}`);
		}
		const ctx = latestCtx;
		if (ctx && idle(ctx)) evaluate(ctx);
	});

	pi.on("session_shutdown", async () => {
		closed = true;
		unsubscribe();
		latestCtx = undefined;
	});
}
