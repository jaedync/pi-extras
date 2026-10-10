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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTool, type ContextEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sharedLimitStore, type LimitStore } from "../lib/limit-store.ts";
import { operationalError } from "../lib/operational-log.ts";
import { markRow } from "../lib/tool-row.ts";
import { parseRateLimit } from "../lib/rate-limit-recovery/core.ts";
import { createDollarsCollector, type DollarsCollector } from "../lib/usage-dollars/collect.ts";
import {
	hotProviders,
	normalizeGuardConfig,
	pendingWarnings,
	usageReport,
	warningApplies,
	warningMessage,
	type ActiveModel,
	type CollectedDollars,
	type GuardConfig,
	type SessionBudget,
} from "../lib/usage-guard-core.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const CONFIG_FILE = join(AGENT_DIR, "pi-extras.json");
const LOG_FILE = join(AGENT_DIR, "usage-guard.log");
const CONFIG_KEY = "usageGuard";
/** Session entries (fired keys, budget) and injected messages share one type. */
export const GUARD_CUSTOM_TYPE = "usage-guard";
const USAGE_HELP = "Usage: /usage | /usage budget <window> <pct> | /usage budget clear | /usage warnings on|off";

interface GuardEntry {
	fired?: string[];
	budget?: SessionBudget | null;
}

type DeliverAs = "steer" | "nextTurn";
type CustomMessage = Extract<ContextEvent["messages"][number], { role: "custom" }>;

function readConfigFile(file: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** `PI_EXTRAS_USAGE_GUARD=1` or `0` turns band warnings on or off for one run without touching the file. */
export function loadGuardConfig(file = CONFIG_FILE, env: NodeJS.ProcessEnv = process.env): GuardConfig {
	const config = normalizeGuardConfig(readConfigFile(file)[CONFIG_KEY]);
	const override = env.PI_EXTRAS_USAGE_GUARD;
	if (override === "0") return { ...config, enabled: false };
	if (override === "1") return { ...config, enabled: true };
	return config;
}

/** Merge a patch into the guard section, preserving any other keys in the file. */
export function saveGuardConfig(patch: Partial<GuardConfig>, file = CONFIG_FILE): GuardConfig {
	const existing = readConfigFile(file);
	const current = existing[CONFIG_KEY];
	const merged = normalizeGuardConfig({ ...(current && typeof current === "object" ? current : {}), ...patch });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ ...existing, [CONFIG_KEY]: merged }, null, 2)}\n`);
	return merged;
}

/** "7d 60" -> budget; "clear" -> null; anything else -> undefined. */
export function parseBudgetArgs(words: string[]): SessionBudget | null | undefined {
	if (words[0] === "clear" && words.length === 1) return null;
	const pct = Number(words[1]);
	if (words.length !== 2 || !words[0] || !Number.isFinite(pct) || pct <= 0 || pct > 100) return undefined;
	return { window: words[0], pct };
}

function activeModel(ctx: Pick<ExtensionContext, "model">): ActiveModel {
	return { provider: ctx.model?.provider, id: ctx.model?.id };
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
}

export default function usageGuard(pi: ExtensionAPI, options: UsageGuardOptions = {}): void {
	const store = options.store ?? sharedLimitStore();
	const configFile = options.configFile ?? CONFIG_FILE;
	const now = options.now ?? Date.now;
	let config = loadGuardConfig(configFile);
	// pi-extras.json sits in the agent directory, next to the sessions the ledger reads.
	const dollars = options.dollars ?? createDollarsCollector({ agentDir: dirname(configFile), configFile });
	let fired = new Set<string>();
	let budget: SessionBudget | undefined;
	let latestCtx: ExtensionContext | undefined;

	function restore(ctx: ExtensionContext): void {
		fired = new Set();
		budget = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== GUARD_CUSTOM_TYPE) continue;
			const data = (entry as { data?: GuardEntry }).data;
			for (const key of data?.fired ?? []) fired.add(key);
			if (data && "budget" in data) budget = data.budget ?? undefined;
		}
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
	async function collectDollars(ctx: ExtensionContext, force: boolean): Promise<CollectedDollars | undefined> {
		try {
			return await dollars.collect({
				snapshots: store.entries(),
				model: activeModel(ctx),
				scopedModels: (ctx.scopedModels ?? []).map((scoped) => ({ provider: scoped.model.provider, id: scoped.model.id })),
				getApiKey: async (provider) => ctx.modelRegistry?.getApiKeyForProvider(provider),
				now: now(),
				force,
			});
		} catch (error) {
			operationalError(LOG_FILE, "usage-guard", `dollars failed: ${(error as Error)?.message ?? "error"}`);
			return undefined;
		}
	}

	function evaluate(ctx: ExtensionContext, deliverWarnings = false): CustomMessage[] {
		try {
			const snapshots = store.entries();
			const model = activeModel(ctx);
			const hot = hotProviders(snapshots, model, config, budget, now());
			for (const [provider] of snapshots) store.setHot(provider, hot.has(provider));
			if (!deliverWarnings) return [];
			return pendingWarnings(snapshots, model, config, budget, fired, now()).map((warning) => {
				const notice: CustomMessage = {
					role: "custom", customType: GUARD_CUSTOM_TYPE, display: true, timestamp: now(),
					content: warningMessage(warning, config, now()),
					details: {
						key: warning.key, provider: warning.provider, modelFamily: warning.entry.modelFamily,
						threshold: warning.threshold, reason: warning.reason, final: warning.final,
					},
				};
				fired.add(warning.key);
				pi.appendEntry(GUARD_CUSTOM_TYPE, { fired: [warning.key] } satisfies GuardEntry);
				// The returned projection reaches this request immediately. Persist/display
				// at the safe turn boundary, never steer or create a follow-up request.
				pi.sendMessage(notice, { triggerTurn: false });
				return notice;
			});
		} catch (error) {
			operationalError(LOG_FILE, "usage-guard", `evaluate failed: ${(error as Error)?.message ?? "error"}`);
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
			"Balances (budget, credits) are reported but never warned on. " +
			"Dollar figures: each limit's `dollars` gives spend, size and remaining USD (implied for subscription windows, " +
			"plan caps per model for OpenCode Go, the provider's own meter or balance otherwise); a monthly meter adds " +
			"business days left and a per-business-day share. The top-level `dollars` gives spend today in the local time zone " +
			"and the tightest remaining USD per provider. " +
			"setBudget records a session budget so a wrap-up warning fires once when that window reaches pct.",
		promptSnippet: "Check subscription usage limits, resets, and the session usage budget",
		promptGuidelines: [
			"Use usage before long autonomous work and whenever the user sets a usage budget (for example: work until 60% of the weekly limit); pass setBudget so a warning fires at that point.",
			"Usage warnings are not a reason to cut work short: finish tasks that fit in the remaining headroom.",
			"Before starting subagents, call usage with all: true and size each run's maxCost from dollars.providers.<provider>.remainingUsd (remainingUsdByModel for OpenCode Go) and, for a monthly meter, leftTodayUsd. Treat implied figures as estimates and leave margin.",
			"When a window near its limit is waitable (resets within a few hours) and work remains, keep going past it: at a clean checkpoint start a background shell job running `sleep <resumeAfterSeconds>` titled \"Wait for usage reset\", end the turn, and continue the task when it completes. Stop and report only at a user-set budget or when the reset is too far away to wait for.",
		],
		parameters: Type.Object({
			refresh: Type.Optional(Type.Boolean({ description: "Poll the provider now instead of reading the cached snapshot." })),
			all: Type.Optional(Type.Boolean({ description: "Include other providers and windows that do not govern the active model." })),
			setBudget: Type.Optional(Type.Object({
				window: Type.String({ minLength: 1, maxLength: 32, description: "Window label or key, e.g. \"7d\", \"5h\", \"7d-fable\"." }),
				pct: Type.Number({ minimum: 1, maximum: 100, description: "Warn once when the window reaches this percent." }),
			}, { description: "Record a session usage budget for one window." })),
			clearBudget: Type.Optional(Type.Boolean({ description: "Remove the session budget." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (params.clearBudget) setBudget(undefined);
			if (params.setBudget) setBudget({ window: params.setBudget.window.trim(), pct: params.setBudget.pct });
			const model = activeModel(ctx);
			if (params.refresh) {
				const providers = params.all ? store.entries().map(([provider]) => provider) : [];
				if (model.provider && !providers.includes(model.provider)) providers.push(model.provider);
				await Promise.all(providers.map((provider) => store.refresh(provider, true)));
			}
			if (params.all) {
				// Status Plus polls only providers this session has used; a subagent may run on
				// any scoped model, so its limits must be known before it starts. Not forced:
				// the shared poll gap still holds, and a provider with no poller is skipped.
				const known = new Set(store.entries().map(([provider]) => provider));
				const scoped = new Set((ctx.scopedModels ?? []).map((entry) => entry.model.provider));
				await Promise.all([...scoped].filter((provider) => !known.has(provider)).map((provider) => store.refresh(provider, false)));
			}
			const collected = await collectDollars(ctx, params.refresh === true);
			const report = usageReport(store.entries(), model, config, budget, now(), params.all === true, undefined, collected);
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
				config = saveGuardConfig({ enabled: words[1] === "on" }, configFile);
				return ctx.ui.notify(`Usage warnings ${config.enabled ? "on" : "off"}`, "info");
			}
			if (words[0] === "budget") {
				const parsed = parseBudgetArgs(words.slice(1));
				if (parsed === undefined) return ctx.ui.notify(USAGE_HELP, "warning");
				setBudget(parsed ?? undefined);
				return ctx.ui.notify(parsed ? `Session budget: ${parsed.window} at ${parsed.pct}%` : "Session budget cleared", "info");
			}
			if (words.length) return ctx.ui.notify(USAGE_HELP, "warning");
			const collected = await collectDollars(ctx, false);
			const report = usageReport(store.entries(), activeModel(ctx), config, budget, now(), false, undefined, collected);
			deliver(`Current usage limits:\n${JSON.stringify(report, null, 1)}`, idle(ctx) ? "nextTurn" : "steer", report);
			ctx.ui.notify(idle(ctx) ? "Usage snapshot queued for the next turn" : "Usage snapshot queued for the agent", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		config = loadGuardConfig(configFile);
		restore(ctx);
		evaluate(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		evaluate(ctx);
	});

	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (["stop", "toolUse"].includes(message.stopReason)) store.recordSuccess(message.provider, message.model, now());
		else if (message.stopReason === "error" && parseRateLimit(message.errorMessage)) {
			store.recordRejection(message.provider, message.model, now());
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		evaluate(ctx);
	});

	// Prompts, automatic job wakes and queued follow-ups all share this request
	// boundary. before_agent_start alone misses the latter two.
	pi.on("context", async (event, ctx) => {
		latestCtx = ctx;
		const notices = evaluate(ctx, true);
		return {
			messages: [...event.messages.filter((message) => message.role !== "custom" ||
				message.customType !== GUARD_CUSTOM_TYPE || warningApplies(message.details, activeModel(ctx), now(), store.get(ctx.model?.provider ?? ""))), ...notices],
		};
	});

	// Idle polls still select faster polling near a threshold, but never persist
	// a fired key or queue model-facing text before the next prompt chooses its model.
	const unsubscribe = store.subscribe(() => {
		// The first meter reading of the day anchors "spent today" for every process.
		try { dollars.observe(store.entries(), now()); } catch { /* the report recomputes it */ }
		const ctx = latestCtx;
		if (ctx && idle(ctx)) evaluate(ctx);
	});

	pi.on("session_shutdown", async () => {
		unsubscribe();
		latestCtx = undefined;
	});
}
