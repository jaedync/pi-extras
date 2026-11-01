/**
 * The models children may use, read when a call needs them. Pi's
 * `ctx.scopedModels` is live: /scoped-models sets a new list on the session at
 * once. A /reload reads settings.json again but, in Pi 1.4.0, does not resolve
 * `enabledModels` again, so the session keeps its old list. A reload here
 * resolves `enabledModels` when they changed since the last start of the
 * session in this process, and uses that list until the session's list changes.
 */
import type { ModelScope } from "./contract.ts";
import { allowedModels, type ModelLike, refOf, resolveModel } from "./models.ts";

export interface ScopedLike {
	readonly model: ModelLike;
	readonly thinkingLevel?: string;
}

/** A list resolved from settings, used while the session's own list is still `base` (the list Pi did not rebuild). */
export interface ScopeOverride {
	readonly base: unknown;
	readonly scoped: readonly ScopedLike[];
}

export interface LiveScopeInputs {
	/** Pi's `ctx.scopedModels` and `ctx.model` now; throws once Pi replaced that `ctx`. */
	read(): { scoped: readonly ScopedLike[]; parent: ModelLike | undefined };
	/** `subagents.defaultModel`; out of scope, the parent's model is the default, else the first one. */
	defaultModel: string | null;
	/** Read at each call: a start sets it once it has resolved the settings. */
	override?: () => ScopeOverride | undefined;
}

/** The scope now, built again only when the session's list, the override or the model changed; a `ctx` Pi replaced gives the last scope read. */
export function liveModelScope(inputs: LiveScopeInputs): () => ModelScope {
	let last: { live: unknown; override: unknown; parent: string | null; scope: ModelScope } | undefined;
	return () => {
		let now: ReturnType<LiveScopeInputs["read"]>;
		try { now = inputs.read(); }
		catch (error) {
			if (last) return last.scope;
			throw error;
		}
		const override = inputs.override?.();
		const parent = now.parent ? refOf(now.parent) : null;
		if (last && last.live === now.scoped && last.override === override && last.parent === parent) return last.scope;
		last = { live: now.scoped, override, parent, scope: scopeOf(effectiveScoped(now.scoped, override), now.parent, inputs.defaultModel) };
		return last.scope;
	};
}

/**
 * The list subagents use: the override while the session's list is the one it
 * replaced, or that list with entries appended after it. Pi appends a model
 * that `/model` saves as the default (`_addPersistedDefaultToNonEmptyScope`
 * keeps the old entries); `/scoped-models` builds new entries, so its lists win.
 */
export function effectiveScoped(live: readonly ScopedLike[], override: ScopeOverride | undefined): readonly ScopedLike[] {
	if (!override) return live;
	if (live === override.base) return override.scoped;
	const base = override.base as readonly ScopedLike[];
	const appended = Array.isArray(base) && live.length > base.length && base.every((entry, index) => live[index] === entry);
	if (!appended) return live;
	const have = new Set(override.scoped.map((entry) => refOf(entry.model)));
	return [...override.scoped, ...live.slice(base.length).filter((entry) => !have.has(refOf(entry.model)))];
}

function scopeOf(scoped: readonly ScopedLike[], parent: ModelLike | undefined, defaultModel: string | null): ModelScope {
	const allowed = allowedModels(scoped, parent);
	const configured = defaultModel ? resolveModel(defaultModel, allowed) : null;
	const parentRef = parent ? refOf(parent) : null;
	const fallbackModel = configured?.ok ? configured.choice.ref
		: parentRef && allowed.some((choice) => choice.ref === parentRef) ? parentRef : allowed[0]?.ref ?? null;
	return { allowed, fallbackModel };
}

/** What the last start of a session read; on globalThis, since each /reload evaluates this module again. */
interface ScopeRecord {
	readonly patterns: string;
	readonly override?: ScopeOverride;
}

const RECORDS = Symbol.for("pi-extras.subagents.scope-records");

function records(): Map<string, ScopeRecord> {
	const holder = globalThis as { [RECORDS]?: Map<string, ScopeRecord> };
	return holder[RECORDS] ??= new Map();
}

/** Tests start each case with nothing recorded. */
export function forgetScopeRecords(): void {
	records().clear();
}

export interface ReloadInputs {
	readonly sessionId: string;
	readonly reload: boolean;
	/** The session's list now, as `ctx.scopedModels` returns it. */
	readonly live: readonly ScopedLike[];
	/** `enabledModels` in settings now; undefined when unset. */
	readonly patterns: readonly string[] | undefined;
	/** Pi started with `--models`, which replaces `enabledModels` for the whole process. */
	readonly cliModels: boolean;
	resolve(patterns: readonly string[]): Promise<readonly ScopedLike[]>;
}

/**
 * The list a start uses in place of the session's, if any. A start that is not
 * a reload only records the patterns. A reload resolves them when they changed
 * since that record (or when there is none), so a change made only in
 * /scoped-models and not saved stays in force across a reload with unchanged
 * settings. Unset patterns resolve to no list, as Pi's start does.
 */
export async function reloadOverride(inputs: ReloadInputs): Promise<{ override?: ScopeOverride; warning?: string }> {
	const all = records();
	if (inputs.cliModels) {
		all.delete(inputs.sessionId);
		return {};
	}
	const patterns = JSON.stringify(inputs.patterns ?? []);
	const previous = all.get(inputs.sessionId);
	if (!inputs.reload) {
		all.set(inputs.sessionId, { patterns });
		return {};
	}
	if (previous?.patterns === patterns) {
		const kept = previous.override?.base === inputs.live ? previous.override : undefined;
		all.set(inputs.sessionId, { patterns, ...(kept ? { override: kept } : {}) });
		return kept ? { override: kept } : {};
	}
	let scoped: readonly ScopedLike[];
	try {
		scoped = inputs.patterns?.length ? await inputs.resolve(inputs.patterns) : [];
		// No match at all is far more likely a catalog not ready than settings that name no model.
		if (inputs.patterns?.length && scoped.length === 0) throw new Error("they match no model with credentials");
	} catch (error) {
		// Not recorded, so the next reload tries again.
		return { warning: `subagents: could not resolve enabledModels after /reload (${(error as Error).message}). Subagents use the session's model scope.` };
	}
	if (sameModels(scoped, inputs.live)) {
		all.set(inputs.sessionId, { patterns });
		return {};
	}
	const override = { base: inputs.live, scoped };
	all.set(inputs.sessionId, { patterns, override });
	return { override };
}

function sameModels(left: readonly ScopedLike[], right: readonly ScopedLike[]): boolean {
	const key = (list: readonly ScopedLike[]) => list.map((entry) => `${refOf(entry.model)}:${entry.thinkingLevel ?? ""}`).join("\n");
	return key(left) === key(right);
}

export interface HintInputs {
	/** Every model Pi knows (`ctx.modelRegistry.getAll()`). */
	readonly known: readonly ModelLike[];
	/** References that `enabledModels` in settings resolve to now. */
	readonly settingsRefs: ReadonlySet<string>;
	readonly cliModels: boolean;
	/** The session's list is empty: Pi's "all models", which gives subagents only main's model (models.ts `allowedModels`). */
	readonly scopeEmpty?: boolean;
}

/** Why a model Pi knows is out of scope, and the fix; undefined for a name Pi does not know. */
export function scopeHint(query: string, inputs: HintInputs): string | undefined {
	const found = resolveModel(query, allowedModels(inputs.known.map((model) => ({ model })), undefined));
	if (!found.ok) return undefined;
	const ref = found.choice.ref;
	if (inputs.scopeEmpty) return "The session's model scope is empty (all models), so subagents may use only main's model. Pick the models in /scoped-models, or set enabledModels in settings.json and run /reload.";
	if (inputs.cliModels) return `${ref} is not in this session's model scope. Enable it with /scoped-models. This Pi started with --models, so enabledModels does not apply.`;
	if (inputs.settingsRefs.has(ref)) return `${ref} is in enabledModels but not in this session's model scope. Run /reload, or enable it with /scoped-models.`;
	return `${ref} is not in this session's model scope. Enable it with /scoped-models, or add it to enabledModels in settings.json and run /reload.`;
}

/** Whether this Pi started with `--models` and a value, the only form Pi's args.js reads. */
export function startedWithModels(argv: readonly string[] = process.argv): boolean {
	const args = argv.slice(2);
	return args.some((arg, index) => arg === "--models" && index + 1 < args.length);
}
