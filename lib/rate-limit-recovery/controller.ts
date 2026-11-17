/** Public Pi turn boundaries own one bounded quota recovery loop per run. */
import { dirname, join } from "node:path";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, MessageEndEvent, MessageEndEventResult, SessionBoundaryDraft, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE } from "../extras-config.ts";
import { RECOVERY_TYPE } from "./entry-type.ts";
import { operationalError } from "../operational-log.ts";
import { loadConfig, saveConfig, type RecoveryConfig } from "./config.ts";
import { captureLimit, capturePlanLimit, failureMessage, parseRateLimit, planWait, resumedMessage, sameScope, type CapturedLimit, type WaitPlan, type WaitRefusal } from "./core.ts";
import { isPlanLimitText, parsePlanHint, planLimited, resetFromReadings, takePlanHint, windowName, type ReadingRefusal } from "./plan-limit.ts";
import { sharedLimitStore, type LimitStore } from "../limit-store.ts";
import { limitKey } from "../plan-billing.ts";
import { isVirtualModel, routedModel } from "../routed-model.ts";
import { waitForDelay, waitUI, type Wait } from "./wait.ts";
import { createQuotaTransportGuard } from "./transport.ts";
import { ANTHROPIC_HOSTS, type FirstEventPolicy } from "./first-event.ts";
import { proxyRetryLimit, TransientBackoff, type TransientKind } from "./transient.ts";
import { formatDuration } from "../status-plus-logic.ts";
import { probeServer, type Probe } from "./local.ts";
import { dropOldResumes, LOCAL_RESUME_TYPE, LocalIdleWait, openWait, RESTART_RESTORE_MAX_AGE_MS, RESTORE_MAX_AGE_MS } from "./idle-wait.ts";

export { RECOVERY_TYPE };
const WAIT_LABELS: Readonly<Record<TransientKind, string>> = { "rate-limit": "Rate limited on", proxy: "Claude Code proxy failed on", connection: "Connection failed on" };
const HELP = "Usage: /rate-limit-recovery on|off|status|cancel";
const REFUSALS: Record<WaitRefusal, string> = {
	"unknown-reset": "Automatic recovery requires a valid retry_after in seconds.",
	"too-long": "The requested delay exceeds the automatic wait budget; no early retry was scheduled.",
	"attempt-limit": "The automatic recovery limit for this run has been reached.",
	"wait-budget": "The aggregate automatic wait budget for this run has been reached.",
};
// A plan rejection names no reset time when the provider sends none: the readings decide, or nothing does.
const READING_REFUSALS: Record<ReadingRefusal, string> = {
	"no-reading": "No usage reading of the ChatGPT plan from the last minute is available, so the reset time is unknown. Check the plan's windows with the usage tool.",
	"not-blocked": "The plan's usage readings show no full window, so the reset time is unknown.",
	"no-reset": "The full plan window's reading has no reset time.",
};
const PLAN_TOO_LONG = "The plan window resets after the automatic wait budget (maxWaitSeconds), so no wait was scheduled. Continue after the reset, or switch to a model of another provider.";
/** The forced plan poll may hold the failed turn this long; status-plus's own poll timeout is 3 s. */
const PLAN_POLL_MS = 5_000;

export interface RecoveryOptions {
	readonly configFile?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
	readonly wait?: Wait;
	readonly role?: "main" | "subagent";
	/** Overrides the configured stall watchdog; tests use fixture hosts and short timeouts. */
	readonly firstEvent?: Partial<FirstEventPolicy>;
	/** Jitter source for transient backoff; tests fix it. */
	readonly random?: () => number;
	/** The local-server check; tests stub it so no request leaves the process. */
	readonly probe?: Probe;
	/** Plan limit readings; tests pass their own store. */
	readonly limits?: LimitStore;
}
interface Pending { readonly limit: CapturedLimit; readonly eligible: boolean }
type AssistantFailure = Extract<MessageEndEvent["message"], { role: "assistant" }>;
interface Active { readonly controller: AbortController; readonly ctx: ExtensionContext; readonly scope: string }

/** Esc and Ctrl+C cancel an idle wait only with no draft: with a draft they belong to the editor. */
function editorEmpty(ctx: ExtensionContext): boolean {
	try { return (ctx.ui.getEditorText?.() ?? "").trim() === ""; } catch { return true; }
}

export class Recovery {
	private readonly pi: ExtensionAPI;
	private readonly file: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly role: string;
	private readonly now: () => number;
	private readonly wait: Wait;
	private readonly firstEvent: Partial<FirstEventPolicy>;
	private readonly limits: LimitStore;
	private config: RecoveryConfig;
	private pending: Pending | undefined;
	private active: Active | undefined;
	private ready = false;
	private attempts = 0;
	private spentMs = 0;
	private generation = 0;
	private limited: CapturedLimit | undefined;
	private readonly transport: ReturnType<typeof createQuotaTransportGuard>;
	private readonly transient: TransientBackoff;
	private readonly idleWait: LocalIdleWait;
	private stopped = false;
	private unsupportedTransport = false;

	constructor(pi: ExtensionAPI, options: RecoveryOptions) {
		this.pi = pi;
		this.file = options.configFile ?? CONFIG_FILE;
		this.env = options.env ?? process.env;
		this.role = options.role ?? (this.env.PI_RATE_LIMIT_RECOVERY_ROLE === "subagent" ? "subagent" : "main");
		this.now = options.now ?? Date.now;
		this.wait = options.wait ?? waitForDelay;
		this.firstEvent = options.firstEvent ?? {};
		this.limits = options.limits ?? sharedLimitStore();
		this.config = loadConfig(this.file, this.env);
		this.transport = createQuotaTransportGuard({ firstEvent: () => this.firstEventPolicy(), onWarning: (code) => {
			if (code === "unsupported-mixed-api" || code === "unsupported-default-model-api") this.unsupportedTransport = true;
			operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `transport protection: ${code}`);
		} });
		this.transient = new TransientBackoff({
			budgetMs: () => this.config.transientMaxWaitSeconds * 1000,
			wait: this.wait,
			...(options.random ? { random: options.random } : {}),
			...(options.probe ? { probe: options.probe } : {}),
			now: () => this.now(),
			ui: (ctx, who, resumeAtMs, cancel, kind, downSinceMs) => this.role === "main" && ctx.mode === "tui" && ctx.hasUI
				? waitUI(ctx, { provider: who }, { resumeAtMs }, Date.now, cancel, downSinceMs === undefined
					? (remaining) => `${WAIT_LABELS[kind]} ${who} \u00b7 retrying in ${remaining}`
					: () => `${who} not answering for ${formatDuration(Math.max(0, Date.now() - downSinceMs), true)} \u00b7 local server, checked every 10 s`, pi) : undefined,
			// Only a person can end a wait with no limit: print, JSON and RPC runs keep the budget.
			local: (ctx) => ({ enabled: this.config.localRetry && this.role === "main" && ctx.mode === "tui" && ctx.hasUI === true, providers: this.config.localProviders }),
			onFailure: (error) => operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `transient wait failed (${error instanceof Error ? error.name : "unknown error"})`),
			record: (entry) => pi.appendEntry(RECOVERY_TYPE, entry),
			// The local wait leaves the run, so updates, shell job reports and typing go on during it.
			idle: (wait, ctx) => {
				if (!this.interactiveMain(ctx)) return false;
				this.idleWait.start(ctx, wait);
				return true;
			},
		});
		this.idleWait = new LocalIdleWait({
			resume: (content, details) => pi.sendMessage({ customType: LOCAL_RESUME_TYPE, content, display: true, details }, { triggerTurn: true }),
			record: (entry) => pi.appendEntry(RECOVERY_TYPE, entry),
			probe: options.probe ?? probeServer,
			wait: this.wait,
			now: () => this.now(),
			ui: (ctx, who, sinceMs, cancel) => waitUI(ctx, { provider: who }, { resumeAtMs: sinceMs }, Date.now, cancel,
				() => `${who} not answering for ${formatDuration(Math.max(0, Date.now() - sinceMs), true)} \u00b7 local server, checked every 10 s`, pi, false,
				() => editorEmpty(ctx)),
			ended: (who, end, ranMs) => this.transient.localWaitEnded(who, end, ranMs),
			onFailure: (error) => operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `local idle wait failed (${error instanceof Error ? error.name : "unknown error"})`),
		});
	}

	private interactiveMain(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
		return this.role === "main" && ctx.mode === "tui" && ctx.hasUI === true;
	}

	register(): void {
		const pi = this.pi;
		pi.on("message_end", (event, ctx) => this.messageEnd(event, ctx));
		pi.on("turn_end", (event, ctx) => this.turnEnd(event, ctx));
		pi.on("agent_before_settle", (event) => this.beforeSettle(event));
		// Queued work or another extension can already have continued the run.
		pi.on("context", (event, ctx) => {
			this.ready = false; this.transient.consumeReady(); this.protectTransport(ctx, ctx.model, true);
			const messages = Array.isArray(event.messages) ? dropOldResumes(event.messages) : undefined;
			return messages ? { messages } : undefined;
		});
		pi.on("model_select", (event, ctx) => {
			this.protectTransport(ctx, event.model);
			if (this.active && !sameScope(this.active.scope, event.model)) this.cancel();
			// Switching away from a limited model is a request to go on with the new one now.
			this.transient.skip();
			this.idleWait.skip(`${event.model.provider}/${event.model.id}`);
		});
		pi.on("cache_warming_decision", (_event, ctx) => this.limited?.resetAtMs !== undefined && this.limited.resetAtMs > this.now() && this.inScope(this.limited.scope, ctx) ? { action: "stop" } : undefined);
		pi.on("before_agent_start", (event, ctx) => {
			this.attempts = 0; this.spentMs = 0; this.pending = undefined; this.ready = false;
			// The idle wait's own run keeps the outage; any other run ends the wait and starts afresh.
			const resumed = event.messageType === "custom" && event.message?.customType === LOCAL_RESUME_TYPE;
			// A shell job or subagent report during the wait also carries the task on: keep the outage
			// (its clock and counts), and a new failure starts a new idle wait.
			const carried = !resumed && event.messageType !== "user" && this.idleWait.waiting;
			if (resumed) this.transient.resume();
			else if (carried) { this.idleWait.yieldToRun(); this.transient.resume(); }
			else { this.idleWait.cancel(); this.transient.reset(); }
			this.protectTransport(ctx, ctx.model, true);
		});
		pi.on("session_start", (event, ctx) => {
			this.stopped = false; this.cancel(); this.idleWait.stop(); this.transient.reset(); this.releaseTransport();
			this.config = loadConfig(this.file, this.env); this.generation++; this.limited = undefined; this.protectTransport(ctx);
			// A fork or a new session copies entries but not the wait: only the same session goes on.
			if (event.reason !== "fork" && event.reason !== "new") this.restoreIdleWait(ctx, event.reason === "reload" ? RESTORE_MAX_AGE_MS : RESTART_RESTORE_MAX_AGE_MS);
		});
		pi.on("session_shutdown", () => { this.stopped = true; this.cancel(); this.idleWait.stop(true); this.generation++; this.limited = undefined; this.releaseTransport(); });
		if (this.role !== "subagent") pi.registerCommand("rate-limit-recovery", {
			description: "Opt in to quota hibernation; on|off|status|cancel",
			handler: (args, ctx) => this.command(args, ctx),
		});
	}

	/** A reload or an update restart during a local wait: the wait goes on from its entry. */
	private restoreIdleWait(ctx: ExtensionContext, maxAgeMs: number): void {
		if (!this.config.localRetry || !this.interactiveMain(ctx)) return;
		try {
			const open = openWait(ctx.sessionManager.getBranch() as never, RECOVERY_TYPE, this.now(), maxAgeMs);
			if (!open) return;
			this.transient.seedOutage(open.who, open.sinceMs);
			this.idleWait.restore(ctx, open);
		} catch (error) {
			operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `local idle wait restore failed (${error instanceof Error ? error.name : "unknown error"})`);
		}
	}

	private firstEventPolicy(): FirstEventPolicy | undefined {
		const timeoutMs = this.firstEvent.timeoutMs ?? this.config.anthropicFirstEventSeconds * 1000;
		return timeoutMs > 0 ? { timeoutMs, hosts: this.firstEvent.hosts ?? ANTHROPIC_HOSTS } : undefined;
	}

	/**
	 * Whether a limit's scope covers the model requests now go to. Under a
	 * virtual selection that is the routed model of the latest request. With no
	 * request on the branch yet, the limit came from the one now failing.
	 */
	private inScope(scope: string, ctx: ExtensionContext): boolean {
		const routed = routedModel(ctx, true);
		return (isVirtualModel(routed) && routed === ctx.model) || sameScope(scope, routed);
	}

	private releaseTransport(): void {
		try { this.transport.dispose(); }
		catch { operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, "quota transport disposal failed"); }
	}

	// Only request boundaries may move a guard to another API: a model_select can land
	// between an in-flight request's context hook and its stream dispatch.
	private protectTransport(ctx: ExtensionContext, model = ctx.model, retarget = false): void {
		if (this.stopped) return;
		this.unsupportedTransport = false;
		try {
			this.transport.ensure({ modelRegistry: ctx.modelRegistry, model, retarget });
			if (this.unsupportedTransport && ctx.hasUI && !ctx.signal?.aborted) ctx.ui.notify("Hidden-retry protection is unavailable for this provider and API. Routing and retries are unchanged; quota errors are still reported when Pi surfaces them.", "warning");
		}
		catch {
			this.cancel();
			ctx.abort();
			operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, "quota transport registration failed");
			ctx.ui.notify("Quota retry protection could not be initialized. Check models.json and custom provider configuration, then reload Pi before retrying.", "error");
		}
	}

	private refusal(limit: CapturedLimit, plan: WaitRefusal): string {
		if (limit.kind !== "plan") return REFUSALS[plan];
		if (plan === "unknown-reset") return READING_REFUSALS[limit.readingRefusal ?? "no-reading"];
		return plan === "too-long" ? PLAN_TOO_LONG : REFUSALS[plan];
	}

	private reasonFor(ctx: ExtensionContext, limit: CapturedLimit, plan: WaitPlan | WaitRefusal): string {
		if (this.role === "subagent" || ctx.mode !== "tui") return "Subagents and noninteractive sessions never automatically wait or resume.";
		if (!this.config.autoWait) return "Automatic waiting is off. Enable it with /rate-limit-recovery on.";
		if (!ctx.hasUI || !ctx.signal || ctx.signal.aborted) return "The active operation cannot wait or was cancelled.";
		if (typeof plan === "string") return this.refusal(limit, plan);
		return "Automatic recovery will wait for the cooldown plus its safety margin.";
	}

	/**
	 * A ChatGPT plan usage limit. The reset comes from the provider when it sends
	 * one (Codex), else from a fresh reading of the plan's windows, after one
	 * forced poll. With neither, the limit has no reset and no wait follows.
	 */
	private async planLimit(message: AssistantFailure, ctx: ExtensionContext): Promise<CapturedLimit | undefined> {
		const hint = takePlanHint(ctx.signal);
		if (!planLimited(message.provider)) return undefined;
		const observedAtMs = this.now();
		const found = hint ?? parsePlanHint(message.errorMessage, observedAtMs);
		if (!found && !isPlanLimitText(message.errorMessage)) return undefined;
		const window = found?.windowMinutes !== undefined ? windowName(found.windowMinutes) : undefined;
		if (found?.resetAtMs !== undefined) return capturePlanLimit(message, observedAtMs, { resetAtMs: found.resetAtMs, ...(window ? { window } : {}) });
		await this.pollPlan(message.provider);
		const reset = resetFromReadings(this.limits.get(limitKey(message.provider)), observedAtMs);
		return capturePlanLimit(message, observedAtMs, typeof reset === "string" ? { readingRefusal: reset, ...(window ? { window } : {}) } : reset);
	}

	private async pollPlan(provider: string): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.limits.refresh(provider, true), new Promise<void>((resolve) => { timer = setTimeout(resolve, PLAN_POLL_MS); })]);
		} catch (error) {
			// A failed poll leaves the last reading; resetFromReadings then decides from it or refuses.
			operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `plan limit poll failed (${error instanceof Error ? error.name : "unknown error"})`);
		} finally { clearTimeout(timer); }
	}

	private async messageEnd(event: MessageEndEvent, ctx: ExtensionContext): Promise<MessageEndEventResult | undefined> {
		if (this.stopped || event.message.role !== "assistant") return undefined;
		this.pending = undefined; this.ready = false;
		const transient = this.transient.messageEnd(event.message, ctx);
		if (transient) { takePlanHint(ctx.signal); return { message: transient }; }
		if (event.message.stopReason !== "error") { takePlanHint(ctx.signal); return undefined; }
		const parsed = parseRateLimit(event.message.errorMessage);
		const limit = parsed ? captureLimit(event.message, parsed, this.now()) : await this.planLimit(event.message, ctx);
		if (parsed) takePlanHint(ctx.signal);
		if (!limit || this.stopped) return undefined;
		this.limited = limit;
		const plan = planWait(limit, this.config, this.spentMs, this.attempts, this.now());
		const reason = this.reasonFor(ctx, limit, plan);
		const eligible = this.role === "main" && ctx.mode === "tui" && ctx.hasUI && this.config.autoWait && !!ctx.signal && !ctx.signal.aborted && typeof plan !== "string" && this.inScope(limit.scope, ctx);
		this.pending = { limit, eligible };
		if (this.role === "subagent" || ctx.mode !== "tui") ctx.abort();
		return { message: { ...event.message, errorMessage: failureMessage(limit, this.now(), reason) } };
	}

	private cancel(): void {
		this.ready = false; this.pending = undefined;
		this.transient.cancel();
		this.active?.controller.abort();
		this.active?.ctx.abort();
	}

	private fail(ctx: ExtensionContext, error: unknown): void {
		this.cancel();
		operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `wait failed (${error instanceof Error ? error.name : "unknown error"})`);
		ctx.ui.notify("Automatic wait failed and was cancelled without retrying.", "error");
	}

	private async hibernate(ctx: ExtensionContext, limit: CapturedLimit, plan: WaitPlan): Promise<SessionBoundaryDraft[] | undefined> {
		const nativeSignal = ctx.signal;
		if (!nativeSignal || nativeSignal.aborted || !this.inScope(limit.scope, ctx)) return undefined;
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, nativeSignal]);
		const epoch = this.generation;
		this.active = { controller, ctx, scope: limit.scope };
		this.attempts++;
		let ui: ReturnType<typeof waitUI> | undefined;
		let finished = false;
		try {
			this.pi.appendEntry(RECOVERY_TYPE, { kind: "paused", provider: limit.provider, model: limit.model, pausedAt: new Date(plan.pausedAtMs).toISOString(), expectedResumeAt: new Date(plan.resumeAtMs).toISOString(), attempt: this.attempts });
			ui = waitUI(ctx, limit, plan, this.now, () => this.cancel(), undefined, this.pi);
			finished = await this.wait(plan.delayMs, signal, ui.tick);
		} catch (error) { this.fail(ctx, error); }
		finally {
			try { ui?.close(); } catch (error) { finished = false; this.fail(ctx, error); }
			this.active = undefined;
		}
		if (!finished || signal.aborted || this.generation !== epoch || !this.inScope(limit.scope, ctx)) return undefined;
		const resumedAtMs = this.now();
		// A backwards wall-clock adjustment cannot refund a completed relative timer.
		const elapsedMs = Math.max(plan.delayMs, resumedAtMs - plan.pausedAtMs, 0);
		this.spentMs += elapsedMs;
		this.ready = true;
		return [{ type: "custom_message", customType: RECOVERY_TYPE, content: resumedMessage(limit, plan.pausedAtMs, resumedAtMs, ctx.model, plan.delayMs), display: true,
			details: { kind: "resumed", provider: limit.provider, pausedAt: new Date(plan.pausedAtMs).toISOString(), resumedAt: new Date(resumedAtMs).toISOString(), elapsedSeconds: elapsedMs / 1000, elapsedIsLowerBound: resumedAtMs - plan.pausedAtMs < plan.delayMs } }];
	}

	private async turnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<TurnEndEventResult | undefined> {
		const candidate = this.pending;
		this.pending = undefined;
		if (!this.stopped) {
			const resumed = await this.transient.turnEnd(event, ctx);
			if (resumed) return resumed;
		}
		if (this.stopped || !candidate?.eligible || event.message.role !== "assistant" || event.message.stopReason !== "error") return undefined;
		const plan = planWait(candidate.limit, this.config, this.spentMs, this.attempts, this.now());
		if (typeof plan === "string") return undefined;
		const drafts = await this.hibernate(ctx, candidate.limit, plan);
		if (!drafts) return undefined;
		// Preserve raw failure evidence but omit incomplete assistant/tool calls
		// from projection. The canonical note precedes the retried request.
		return { entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: null }, ...drafts] };
	}

	private beforeSettle(event: AgentBeforeSettleEvent): { continue: true } | undefined {
		const transientReady = this.transient.consumeReady();
		const shouldResume = this.ready || transientReady;
		// Consume before preparation: auth/routing can fail before context fires.
		this.ready = false;
		return shouldResume && event.context.canContinue ? { continue: true } : undefined;
	}

	private async command(args: string, ctx: ExtensionContext): Promise<void> {
		const command = args.trim() || "status";
		if (command === "cancel") { this.cancel(); this.idleWait.cancel(); ctx.ui.notify("Automatic wait cancelled.", "info"); return; }
		if (command === "on" || command === "off") {
			this.config = { ...this.config, autoWait: command === "on" };
			if (!this.config.autoWait) this.cancel();
			try { this.config = saveConfig({ autoWait: this.config.autoWait }, this.file); }
			catch (error) { ctx.ui.notify(`Automatic quota waiting ${command} for this session only. ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
		} else if (command !== "status") { ctx.ui.notify(HELP, "warning"); return; }
		ctx.ui.notify(`Automatic quota waiting ${this.config.autoWait ? "on" : "off"} (interactive main sessions only). Budget ${this.config.maxWaitSeconds}s, at most ${this.config.maxRecoveries} recoveries per run. Anthropic subscription stall retry ${this.config.anthropicFirstEventSeconds ? `after ${this.config.anthropicFirstEventSeconds}s of pings` : "off"}. Temporary rate limits and connection failures ${this.config.transientMaxWaitSeconds ? `retried for up to ${this.config.transientMaxWaitSeconds}s` : "left to Pi"}. Claude Code proxy turn failures retried up to ${proxyRetryLimit(this.config.transientMaxWaitSeconds * 1000)} times.${this.active ? " Currently hibernating." : ""}${this.transient.waiting ? " Currently waiting to send a failed request again." : ""}${this.idleWait.waiting ? " Currently waiting for a local server to answer." : ""}`, "info");
	}
}
