/** Request-local quota classification before SDK transport retries, without changing user settings. */
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseRateLimit } from "./core.ts";
import { guardFirstEvent, type FirstEventPolicy } from "./first-event.ts";

const MAX_BODY_BYTES = 32 * 1024;
const INSPECTION_MS = 500;
const SDK_APIS = new Set(["anthropic-messages", "openai-completions", "openai-responses", "azure-openai-responses"]);
const CODEX_API = "openai-codex-responses";
const SHARED = Symbol.for("pi-extras.quota-transport-leases.v3");
const DELEGATING = Symbol.for("pi-extras.quota-transport-delegating.v1");
const POLICIES = Symbol.for("pi-extras.quota-transport-first-event.v1");
type Provider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;
type StreamOptions = NonNullable<Parameters<Provider["streamSimple"]>[2]>;
type Registry = Pick<ModelRegistry, "getProvider" | "getRegisteredNativeProvider" | "getRegisteredProviderConfig" | "registerProvider" | "unregisterProvider">;
type GuardContext = Pick<ExtensionContext, "modelRegistry" | "model"> & { readonly retarget?: boolean };
type Warning = (code: string) => void;
/** Read per request so config reloads apply without re-registering the provider. */
type FirstEventSource = () => FirstEventPolicy | undefined;
type LegacyConfig = NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
type LegacyStream = NonNullable<LegacyConfig["streamSimple"]>;
interface CommonLease { readonly registry: Registry; readonly id: string; readonly owners: Set<object> }
interface NativeLease extends CommonLease { readonly kind: "native"; readonly wrapper: Provider; readonly native: Provider }
interface LegacyLease extends CommonLease {
	readonly kind: "legacy";
	readonly overlay: LegacyStream;
	readonly original: LegacyConfig | undefined;
	readonly fallback: Provider;
	readonly api: string;
}
type Lease = NativeLease | LegacyLease;
export interface QuotaTransportOptions { readonly onWarning?: Warning; readonly firstEvent?: FirstEventSource }
export interface QuotaTransportGuard { ensure(ctx: GuardContext): void; dispose(): void }

const supported = (api: string) => SDK_APIS.has(api) || api === CODEX_API;
function sharedLeases(): WeakMap<object, Lease> {
	const global = globalThis as typeof globalThis & { [SHARED]?: WeakMap<object, Lease> };
	return global[SHARED] ??= new WeakMap<object, Lease>();
}
function ownerPolicies(): WeakMap<object, FirstEventSource> {
	const global = globalThis as typeof globalThis & { [POLICIES]?: WeakMap<object, FirstEventSource> };
	return global[POLICIES] ??= new WeakMap<object, FirstEventSource>();
}
/** A lease outlives the guard that created it, so follow its live owners, newest first. */
function livePolicy(owners: () => ReadonlySet<object> | undefined): FirstEventSource {
	return () => {
		for (const owner of [...(owners() ?? [])].reverse()) {
			const source = ownerPolicies().get(owner);
			if (source) return source();
		}
		return undefined;
	};
}
function reporter(options: QuotaTransportOptions): Warning {
	return (code) => {
		try {
			if (options.onWarning) options.onWarning(code);
			else console.warn(`Rate-limit transport guard: ${code}.`);
		} catch { console.warn("Rate-limit transport guard: warning-handler-failed."); }
	};
}
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, warn: Warning): void {
	// A cloned stream's cancellation can wait for its unread original branch. Never await it.
	void reader.cancel().catch(() => warn("clone-cancel-failed"));
}
async function readBounded(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | undefined> {
	const decoder = new TextDecoder(); let bytes = 0; let text = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return text + decoder.decode();
			bytes += chunk.value.byteLength;
			if (bytes > MAX_BODY_BYTES) return undefined;
			text += decoder.decode(chunk.value, { stream: true });
		}
	} catch {
		// Failed inspection does not replace the provider's own response/error handling.
		return undefined;
	}
}
async function inspect(response: Response, signal: AbortSignal | null | undefined, warn: Warning): Promise<string | undefined> {
	if (signal?.aborted || !response.body) return undefined;
	const length = response.headers.get("content-length");
	if (length !== null && Number(length) > MAX_BODY_BYTES) return undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try { reader = response.clone().body!.getReader(); } catch { return undefined; }
	let timer: ReturnType<typeof setTimeout> | undefined; let onAbort = () => {};
	try {
		const deadline = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), INSPECTION_MS); onAbort = () => resolve(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		return await Promise.race([readBounded(reader), deadline]);
	} finally {
		clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
		cancelReader(reader, warn); reader.releaseLock();
	}
}
function jsonQuota(text: string | undefined): ReturnType<typeof parseRateLimit> {
	if (text === undefined) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return undefined; }
	// The history parser intentionally accepts prose-wrapped JSON. HTTP bodies must be JSON objects.
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	return parseRateLimit(text);
}
function guardedOptions<T extends Pick<StreamOptions, "fetch" | "signal">>(api: string, options: T | undefined, warn: Warning, firstEvent: FirstEventSource): T | undefined {
	if (!supported(api)) return options;
	return { ...options, fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const response = await (options?.fetch ?? globalThis.fetch)(input, init);
		if (response.status !== 429) return guardFirstEvent(api, input, init, response, firstEvent(), init?.signal ?? undefined);
		const signals = [init?.signal, options?.signal, input instanceof Request ? input.signal : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
		const signal = signals.length ? AbortSignal.any(signals) : undefined;
		const limit = jsonQuota(await inspect(response, signal, warn));
		if (!limit || signal?.aborted) return response;
		if (api === CODEX_API) {
			// Codex's raw retry catch recognizes this phrase, not x-should-retry. Retain only
			// validated structure so message_end can classify it without exposing provider prose.
			void response.body?.cancel().catch(() => warn("quota-body-cancel-failed"));
			throw new Error(`Provider usage limit: ${JSON.stringify({ type: "rate_limit_error", ...(limit.retryAfterSeconds === undefined ? {} : { retry_after: limit.retryAfterSeconds }) })}`);
		}
		const headers = new Headers(response.headers); headers.set("x-should-retry", "false");
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	} } as T;
}
function providerCopy(original: Provider): Provider {
	const copy = {}; const bound = new WeakMap<Function, Function>();
	for (let source: object | null = original; source && source !== Object.prototype; source = Object.getPrototypeOf(source)) {
		for (const key of Reflect.ownKeys(source)) {
			if (key === "constructor" || Object.hasOwn(copy, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
			Object.defineProperty(copy, key, { enumerable: descriptor.enumerable, configurable: true, get: () => {
				const value = Reflect.get(original, key, original);
				if (typeof value !== "function") return value;
				const cached = bound.get(value); if (cached) return cached;
				const current = value.bind(original); bound.set(value, current); return current;
			} });
		}
	}
	return copy as Provider;
}
function wrapProvider(original: Provider, warn: Warning, firstEvent: FirstEventSource): Provider {
	const copy = providerCopy(original);
	Object.defineProperties(copy, {
		stream: { configurable: true, enumerable: true, value: (model: Parameters<Provider["stream"]>[0], context: Parameters<Provider["stream"]>[1], options: Parameters<Provider["stream"]>[2]) => original.stream(model, context, guardedOptions(model.api, options, warn, firstEvent)) },
		streamSimple: { configurable: true, enumerable: true, value: (model: Parameters<Provider["streamSimple"]>[0], context: Parameters<Provider["streamSimple"]>[1], options: Parameters<Provider["streamSimple"]>[2]) => original.streamSimple(model, context, guardedOptions(model.api, options, warn, firstEvent)) },
	});
	return copy;
}
function installed(lease: Lease): boolean {
	const native = lease.registry.getRegisteredNativeProvider(lease.id);
	return lease.kind === "native" ? native === lease.wrapper
		: !native && lease.registry.getRegisteredProviderConfig(lease.id)?.streamSimple === lease.overlay;
}
function legacyDispatch(lease: LegacyLease, model: Parameters<LegacyStream>[0], context: Parameters<LegacyStream>[1], options: Parameters<LegacyStream>[2], warn: Warning, firstEvent: FirstEventSource): ReturnType<LegacyStream> {
	const active = installed(lease);
	const delegated = (options as StreamOptions & { [DELEGATING]?: ReadonlySet<string> } | undefined)?.[DELEGATING];
	const guarded = guardedOptions(model.api, options, warn, firstEvent);
	const next = supported(model.api) ? { ...guarded, [DELEGATING]: new Set([...(delegated ?? []), lease.id]) } : options;
	if (!active && !delegated?.has(lease.id)) {
		const fresh = lease.registry.getProvider(lease.id);
		if (fresh) return fresh.streamSimple(model, context, next);
	}
	const original = lease.original?.streamSimple;
	if (original) {
		const current = lease.registry.getRegisteredProviderConfig(lease.id) ?? lease.original;
		return original.call({ ...current, streamSimple: original }, model, context, next);
	}
	// SDK stream composition consumes the current prepared model/options, not captured defaults.
	// Radius gateway replacement can rebuild its base instance; that case needs an upstream hook.
	// No provider re-registration on each request.
	return lease.fallback.streamSimple(model, context, next);
}
function newLegacyLease(registry: Registry, id: string, api: string, warn: Warning, firstEvent: FirstEventSource): LegacyLease | undefined {
	const fallback = registry.getProvider(id); if (!fallback) return undefined;
	const original = registry.getRegisteredProviderConfig(id); let lease: LegacyLease;
	const overlay: LegacyStream = (model, context, options) => legacyDispatch(lease, model, context, options, warn, firstEvent);
	lease = { kind: "legacy", registry, id, overlay, fallback, original, api: original?.api ?? api, owners: new Set<object>() };
	return lease;
}
function withoutOverlay(lease: LegacyLease, current: LegacyConfig): LegacyConfig | undefined {
	const { streamSimple: _overlay, api, ...fields } = current;
	const keepApi = lease.original?.api !== undefined || api !== lease.api;
	const config = { ...fields, ...(keepApi ? { api } : {}) };
	return Object.keys(config).length || lease.original !== undefined ? config : undefined;
}
function restoreLegacy(lease: LegacyLease, warn: Warning): boolean {
	const { registry, id } = lease; const current = registry.getRegisteredProviderConfig(id)!;
	const original = lease.original?.streamSimple;
	if (original) {
		try { registry.registerProvider(id, { ...current, streamSimple: original }); return true; }
		catch { warn("legacy-restore-validation-failed"); return !installed(lease); }
	}
	const plain = withoutOverlay(lease, current);
	try {
		// SDK validates incoming config before its defined-only merge. Our overlay survives
		// these validation passes; an invalid models.json cannot cause destructive unregister.
		registry.registerProvider(id, current); registry.registerProvider(id, plain ?? {});
	} catch { warn("legacy-restore-validation-failed"); return false; }
	if (!installed(lease)) return true;
	const validated = registry.getRegisteredProviderConfig(id)!; let removed = false;
	try {
		registry.unregisterProvider(id); removed = true;
		if (plain !== undefined) registry.registerProvider(id, plain);
		return true;
	} catch {
		warn("legacy-restore-failed");
		if (removed && !registry.getRegisteredNativeProvider(id) && !registry.getRegisteredProviderConfig(id)) {
			try { registry.registerProvider(id, validated); } catch { warn("legacy-restore-rollback-failed"); }
		}
		return !installed(lease);
	}
}
function release(lease: Lease, owner: object, warn: Warning): boolean {
	lease.owners.delete(owner);
	if (lease.owners.size || !installed(lease)) return true;
	if (lease.kind === "legacy") return restoreLegacy(lease, warn);
	try { lease.registry.registerProvider(lease.native); return true; }
	catch { warn("native-restore-failed"); return !installed(lease); }
}
function refreshLease(lease: Lease, api: string, owner: object, retarget: boolean, warn: Warning): "keep" | "retry" | "skip" {
	if (lease.kind === "native") return "keep";
	const config = lease.registry.getRegisteredProviderConfig(lease.id)!;
	if (lease.original === undefined && config.models?.some((model) => model.api === undefined)) {
		warn("unsupported-default-model-api");
		// Retire globally: new dispatches are unguarded at this unsupported boundary. Prepared
		// callbacks still guard their fetch; other owners drop stale records at their next ensure.
		if (!restoreLegacy(lease, warn)) return "skip";
		lease.owners.delete(owner); return "retry";
	}
	if (config.api === api) return "keep";
	const sole = lease.original === undefined && lease.owners.size === 1 && lease.owners.has(owner);
	if (!sole) { warn("unsupported-mixed-api"); return "skip"; }
	// Only a request boundary may retarget. An earlier async context extension can still let
	// live ctx.model diverge from the prepared request, which then uses its base API unguarded.
	if (!retarget) return "skip";
	if (release(lease, owner, warn)) return "retry";
	lease.owners.add(owner); return "skip";
}
export function createQuotaTransportGuard(options: QuotaTransportOptions = {}): QuotaTransportGuard {
	const owner = {}; const owned = new Map<string, Lease>(); const shared = sharedLeases();
	const warn = reporter(options); const warned = new Set<string>();
	const firstEvent: FirstEventSource = () => {
		// A broken policy source must never break the request it would protect.
		try { return options.firstEvent?.(); } catch { warn("first-event-policy-failed"); return undefined; }
	};
	ownerPolicies().set(owner, firstEvent);
	const once = (code: string, id: string, api = "") => {
		const key = JSON.stringify([code, id, api]); if (warned.has(key)) return;
		warned.add(key); warn(code);
	};
	return {
		ensure(ctx) {
			const model = ctx.model; if (!model || !supported(model.api)) return;
			const id = model.provider; const registry = ctx.modelRegistry;
			if (registry.getError?.()?.includes(`Provider "${id}":`)) {
				once("invalid-provider-config", id);
				throw new Error("Rate-limit recovery cannot safely prepare this provider. Fix models.json or its custom provider configuration, then reload.");
			}
			const previous = owned.get(id);
			if (previous && installed(previous)) {
				const action = refreshLease(previous, model.api, owner, ctx.retarget === true, (code) => once(code, id, model.api));
				if (action === "keep") { previous.owners.add(owner); return; }
				if (action === "skip") return;
				owned.delete(id);
			}
			else if (previous && release(previous, owner, (code) => once(code, id))) owned.delete(id);
			const native = registry.getRegisteredNativeProvider(id); const config = registry.getRegisteredProviderConfig(id);
			if (!native && config?.api && config.api !== model.api) { once("unsupported-mixed-api", id, model.api); return; }
			if (!native && !config?.api && config?.models?.some((entry) => entry.api === undefined)) { once("unsupported-default-model-api", id, model.api); return; }
			const key = native ?? config?.streamSimple; let lease = key && shared.get(key);
			const fresh = !lease;
			if (!lease) {
				let created: Lease | undefined;
				const policy = livePolicy(() => created?.owners);
				created = native ? { kind: "native", registry, id, native, wrapper: wrapProvider(native, warn, policy), owners: new Set<object>() } : newLegacyLease(registry, id, model.api, warn, policy);
				lease = created;
			}
			if (!lease) return;
			shared.set(lease.kind === "native" ? lease.wrapper : lease.overlay, lease); lease.owners.add(owner); owned.set(id, lease);
			if (!fresh) return;
			try {
				if (lease.kind === "native") registry.registerProvider(lease.wrapper);
				else registry.registerProvider(id, { api: lease.api, streamSimple: lease.overlay });
			} catch (error) {
				if (release(lease, owner, (code) => once(code, id))) owned.delete(id);
				throw error;
			}
		},
		dispose() {
			for (const [id, lease] of owned) {
				try { if (release(lease, owner, (code) => once(code, id))) owned.delete(id); }
				catch { once("guard-disposal-failed", id); }
			}
			warned.clear();
		},
	};
}
