/** Public Pi turn boundaries own one bounded quota recovery loop per run. */
import { dirname, join } from "node:path";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, MessageEndEvent, MessageEndEventResult, SessionBoundaryDraft, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE } from "../extras-config.ts";
import { operationalError } from "../operational-log.ts";
import { loadConfig, saveConfig, type RecoveryConfig } from "./config.ts";
import { captureLimit, failureMessage, parseRateLimit, planWait, resumedMessage, sameScope, type CapturedLimit, type WaitPlan, type WaitRefusal } from "./core.ts";
import { waitForDelay, waitUI, type Wait } from "./wait.ts";
import { createQuotaTransportGuard } from "./transport.ts";
import { ANTHROPIC_HOSTS, type FirstEventPolicy } from "./first-event.ts";
import { TransientBackoff } from "./transient.ts";

export const RECOVERY_TYPE = "rate-limit-recovery";
const HELP = "Usage: /rate-limit-recovery on|off|status|cancel";
const REFUSALS: Record<WaitRefusal, string> = {
	"unknown-reset": "Automatic recovery requires a valid retry_after in seconds.",
	"too-long": "The requested delay exceeds the automatic wait budget; no early retry was scheduled.",
	"attempt-limit": "The automatic recovery limit for this run has been reached.",
	"wait-budget": "The aggregate automatic wait budget for this run has been reached.",
};

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
}
interface Pending { readonly limit: CapturedLimit; readonly eligible: boolean }
interface Active { readonly controller: AbortController; readonly ctx: ExtensionContext; readonly scope: string }

export class Recovery {
	private readonly pi: ExtensionAPI;
	private readonly file: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly role: string;
	private readonly now: () => number;
	private readonly wait: Wait;
	private readonly firstEvent: Partial<FirstEventPolicy>;
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
		this.config = loadConfig(this.file, this.env);
		this.transport = createQuotaTransportGuard({ firstEvent: () => this.firstEventPolicy(), onWarning: (code) => {
			if (code === "unsupported-mixed-api" || code === "unsupported-default-model-api") this.unsupportedTransport = true;
			operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `transport protection: ${code}`);
		} });
		this.transient = new TransientBackoff({
			budgetMs: () => this.config.transientMaxWaitSeconds * 1000,
			wait: this.wait,
			...(options.random ? { random: options.random } : {}),
			ui: (ctx, who, resumeAtMs, cancel) => this.role === "main" && ctx.mode === "tui" && ctx.hasUI
				? waitUI(ctx, { provider: who }, { resumeAtMs }, Date.now, cancel, (remaining) => `Rate limited on ${who} \u00b7 retrying in ${remaining}`) : undefined,
			onFailure: (error) => operationalError(join(dirname(this.file), "rate-limit-recovery.log"), RECOVERY_TYPE, `transient wait failed (${error instanceof Error ? error.name : "unknown error"})`),
		});
	}

	register(): void {
		const pi = this.pi;
		pi.on("message_end", (event, ctx) => this.messageEnd(event, ctx));
		pi.on("turn_end", (event, ctx) => this.turnEnd(event, ctx));
		pi.on("agent_before_settle", (event) => this.beforeSettle(event));
		// Queued work or another extension can already have continued the run.
		pi.on("context", (_event, ctx) => { this.ready = false; this.transient.consumeReady(); this.protectTransport(ctx, ctx.model, true); });
		pi.on("model_select", (event, ctx) => {
			this.protectTransport(ctx, event.model);
			if (this.active && !sameScope(this.active.scope, event.model)) this.cancel();
			// Switching away from a limited model is a request to go on with the new one now.
			this.transient.skip();
		});
		pi.on("cache_warming_decision", (_event, ctx) => this.limited?.resetAtMs !== undefined && this.limited.resetAtMs > this.now() && sameScope(this.limited.scope, ctx.model) ? { action: "stop" } : undefined);
		pi.on("before_agent_start", (_event, ctx) => { this.attempts = 0; this.spentMs = 0; this.pending = undefined; this.ready = false; this.transient.reset(); this.protectTransport(ctx, ctx.model, true); });
		pi.on("session_start", (_event, ctx) => { this.stopped = false; this.cancel(); this.transient.reset(); this.releaseTransport(); this.config = loadConfig(this.file, this.env); this.generation++; this.limited = undefined; this.protectTransport(ctx); });
		pi.on("session_shutdown", () => { this.stopped = true; this.cancel(); this.generation++; this.limited = undefined; this.releaseTransport(); });
		if (this.role !== "subagent") pi.registerCommand("rate-limit-recovery", {
			description: "Opt in to quota hibernation; on|off|status|cancel",
			handler: (args, ctx) => this.command(args, ctx),
		});
	}

	private firstEventPolicy(): FirstEventPolicy | undefined {
		const timeoutMs = this.firstEvent.timeoutMs ?? this.config.anthropicFirstEventSeconds * 1000;
		return timeoutMs > 0 ? { timeoutMs, hosts: this.firstEvent.hosts ?? ANTHROPIC_HOSTS } : undefined;
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

	private reasonFor(ctx: ExtensionContext, plan: WaitPlan | WaitRefusal): string {
		if (this.role === "subagent" || ctx.mode !== "tui") return "Subagents and noninteractive sessions never automatically wait or resume.";
		if (!this.config.autoWait) return "Automatic waiting is off. Enable it with /rate-limit-recovery on.";
		if (!ctx.hasUI || !ctx.signal || ctx.signal.aborted) return "The active operation cannot wait or was cancelled.";
		if (typeof plan === "string") return REFUSALS[plan];
		return "Automatic recovery will wait for the cooldown plus its safety margin.";
	}

	private messageEnd(event: MessageEndEvent, ctx: ExtensionContext): MessageEndEventResult | undefined {
		if (this.stopped || event.message.role !== "assistant") return undefined;
		this.pending = undefined; this.ready = false;
		const transient = this.transient.messageEnd(event.message, ctx);
		if (transient) return { message: transient };
		if (event.message.stopReason !== "error") return undefined;
		const parsed = parseRateLimit(event.message.errorMessage);
		if (!parsed) return undefined;
		const limit = captureLimit(event.message, parsed, this.now());
		this.limited = limit;
		const plan = planWait(limit, this.config, this.spentMs, this.attempts, this.now());
		const reason = this.reasonFor(ctx, plan);
		const eligible = this.role === "main" && ctx.mode === "tui" && ctx.hasUI && this.config.autoWait && !!ctx.signal && !ctx.signal.aborted && typeof plan !== "string" && sameScope(limit.scope, ctx.model);
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
		if (!nativeSignal || nativeSignal.aborted || !sameScope(limit.scope, ctx.model)) return undefined;
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, nativeSignal]);
		const epoch = this.generation;
		this.active = { controller, ctx, scope: limit.scope };
		this.attempts++;
		let ui: ReturnType<typeof waitUI> | undefined;
		let finished = false;
		try {
			this.pi.appendEntry(RECOVERY_TYPE, { kind: "paused", provider: limit.provider, model: limit.model, pausedAt: new Date(plan.pausedAtMs).toISOString(), expectedResumeAt: new Date(plan.resumeAtMs).toISOString(), attempt: this.attempts });
			ui = waitUI(ctx, limit, plan, this.now, () => this.cancel());
			finished = await this.wait(plan.delayMs, signal, ui.tick);
		} catch (error) { this.fail(ctx, error); }
		finally {
			try { ui?.close(); } catch (error) { finished = false; this.fail(ctx, error); }
			this.active = undefined;
		}
		if (!finished || signal.aborted || this.generation !== epoch || !sameScope(limit.scope, ctx.model)) return undefined;
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
		if (command === "cancel") { this.cancel(); ctx.ui.notify("Automatic wait cancelled.", "info"); return; }
		if (command === "on" || command === "off") {
			this.config = { ...this.config, autoWait: command === "on" };
			if (!this.config.autoWait) this.cancel();
			try { this.config = saveConfig({ autoWait: this.config.autoWait }, this.file); }
			catch { ctx.ui.notify("Could not save quota recovery settings. Check permissions on pi-extras.json. The choice applies to this session only.", "error"); return; }
		} else if (command !== "status") { ctx.ui.notify(HELP, "warning"); return; }
		ctx.ui.notify(`Automatic quota waiting ${this.config.autoWait ? "on" : "off"} (interactive main sessions only). Budget ${this.config.maxWaitSeconds}s, at most ${this.config.maxRecoveries} recoveries per run. Anthropic subscription stall retry ${this.config.anthropicFirstEventSeconds ? `after ${this.config.anthropicFirstEventSeconds}s of pings` : "off"}. Temporary rate limits ${this.config.transientMaxWaitSeconds ? `retried for up to ${this.config.transientMaxWaitSeconds}s` : "left to Pi"}.${this.active ? " Currently hibernating." : ""}${this.transient.waiting ? " Currently waiting out a rate limit." : ""}`, "info");
	}
}
