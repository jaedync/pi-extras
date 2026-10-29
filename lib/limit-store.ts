/**
 * Process-wide store of provider limit snapshots. status-plus owns the
 * pollers and writes here; usage-guard reads, subscribes, marks providers
 * "hot" (near a threshold, poll faster) and asks for forced refreshes.
 *
 * The instance hangs off globalThis under a registered symbol so two
 * extensions loaded through separate module graphs, or across /reload,
 * still see one store. Every method takes any provider id and keys it by
 * its family (lib/provider-family.ts), so a claude-code model reads the
 * anthropic reading and listeners hear the family id.
 */
import type { LimitEntry } from "./status-plus-logic.ts";
import { aheadOfClock } from "./clock-skew.ts";
import { createRejectionTracker } from "./limit-rejection.ts";
import { providerFamily } from "./provider-family.ts";

export interface LimitSnapshot {
	entries: LimitEntry[];
	atMs: number;
	source: "headers" | "poll";
}

/** Called with the provider id as asked, not its family. */
export type LimitRefresher = (provider: string, force: boolean) => Promise<void>;

export interface LimitStore {
	/** Absent from stores made before readings were keyed by family; /reload replaces those. */
	readonly familyKeyed?: true;
	get(provider: string): LimitSnapshot | undefined;
	entries(): Array<[string, LimitSnapshot]>;
	set(provider: string, snapshot: LimitSnapshot): void;
	/** Successful assistant completion is newer evidence than a cached proxy rejection. */
	recordSuccess(provider: string, modelId: string, atMs: number): void;
	/** A structured quota error overrides earlier successful-response evidence. */
	recordRejection(provider: string, modelId: string, atMs: number): void;
	subscribe(listener: (provider: string) => void): () => void;
	/** Installed by the poller owner; absent when no poller extension is loaded. */
	setRefresher(refresher: LimitRefresher | undefined): void;
	/** Resolves false when no refresher is installed. */
	refresh(provider: string, force?: boolean): Promise<boolean>;
	setHot(provider: string, hot: boolean): void;
	isHot(provider: string): boolean;
}

const STORE_KEY = Symbol.for("pi-extras.limit-store");

export function createLimitStore(): LimitStore {
	const snapshots = new Map<string, LimitSnapshot>();
	const hot = new Set<string>();
	const listeners = new Set<(provider: string) => void>();
	let refresher: LimitRefresher | undefined;
	const rejections = createRejectionTracker();
	return {
		familyKeyed: true,
		get: (provider) => snapshots.get(providerFamily(provider)),
		entries: () => [...snapshots.entries()],
		set(id, snapshot) {
			const provider = providerFamily(id);
			const prior = snapshots.get(provider);
			// A prior stamped well ahead came from a clock that was wrong; it must not hold newer snapshots off.
			if (prior && snapshot.atMs < prior.atMs && !aheadOfClock(prior.atMs, Date.now())) return;
			snapshots.set(provider, { ...snapshot, entries: rejections.reconcile(provider, snapshot.entries, snapshot.atMs) });
			for (const listener of listeners) {
				// A listener fault must not break the poller that published the snapshot.
				try { listener(provider); } catch { /* reported by the listener's owner */ }
			}
		},
		recordSuccess(id, modelId, atMs) {
			const provider = providerFamily(id);
			const snapshot = snapshots.get(provider);
			if (!snapshot) return;
			rejections.succeed(provider, modelId, snapshot.entries, atMs);
			// Preserve the quota's sample time. A model response does not refresh its utilization.
			this.set(provider, snapshot);
		},
		recordRejection(id, modelId, atMs) {
			const provider = providerFamily(id);
			const snapshot = snapshots.get(provider);
			if (!snapshot) return;
			rejections.reject(provider, modelId, snapshot.entries, atMs);
			this.set(provider, snapshot);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		setRefresher(next) { refresher = next; },
		async refresh(provider, force = true) {
			if (!refresher) return false;
			// The poller owner maps the id itself: whether an id may start its family's poll is its decision.
			await refresher(provider, force);
			return true;
		},
		setHot(provider, value) { if (value) hot.add(providerFamily(provider)); else hot.delete(providerFamily(provider)); },
		isHot: (provider) => hot.has(providerFamily(provider)),
	};
}

export function sharedLimitStore(): LimitStore {
	const host = globalThis as unknown as Record<symbol, LimitStore | undefined>;
	const existing = host[STORE_KEY];
	if (!existing?.familyKeyed || typeof existing.recordSuccess !== "function" || typeof existing.recordRejection !== "function") {
		// /reload retains globals from the installed version. Upgrade its API before new handlers use it.
		// An older store kept one snapshot per provider id: the newest of a family's wins.
		const next = createLimitStore();
		for (const [provider, snapshot] of existing?.entries() ?? []) {
			next.set(provider, snapshot);
			if (existing!.isHot(provider)) next.setHot(provider, true);
		}
		host[STORE_KEY] = next;
	}
	return host[STORE_KEY]!;
}
