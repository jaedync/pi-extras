/**
 * Main's model runtime reads models.json only when Pi starts and when /model
 * opens, and children share it for their credentials. A launch refreshes it
 * first when models.json changed since the last refresh, as Pi does when an
 * extension registers a provider: from disk only, one refresh at a time per
 * runtime, and never from a file Pi's own loader refuses. Pi loads a refused
 * file as no custom models at all, so a half-saved file would take main's
 * custom providers away with no warning.
 */
import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { fileIdentity } from "./stamp.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

interface Refreshable {
	refresh(options: { allowNetwork: boolean }): Promise<unknown>;
}

/** What is wrong with models.json at `path` as Pi would load it, or undefined when Pi would load it whole. */
export type ModelsCheck = (path: string) => Promise<string | undefined>;

/** What one runtime last read of models.json, and the refresh under way. */
export interface ModelsRead {
	readonly identity?: string;
	/** A file version that was refused or failed to load; it is not tried or told again. */
	readonly warned?: string;
	readonly pending?: Promise<void>;
}

const READS = Symbol.for("pi-extras.subagents.models-read");

/** On globalThis, since a /reload's copy of this module shares main's runtime. */
function reads(): WeakMap<object, ModelsRead> {
	const holder = globalThis as unknown as Record<symbol, WeakMap<object, ModelsRead> | undefined>;
	return holder[READS] ??= new WeakMap();
}

/** A check needs no credentials and keeps no catalog, so it reads no file but models.json. */
const NO_CREDENTIALS: NonNullable<CreateModelRuntimeOptions["credentials"]> = {
	read: async () => undefined,
	list: async () => [],
	modify: async () => { throw new Error("A models.json check stores no credentials."); },
	delete: async () => undefined,
};
const NO_CATALOG: NonNullable<CreateModelRuntimeOptions["modelsStore"]> = {
	read: async () => undefined,
	write: async () => undefined,
	delete: async () => undefined,
};

/** What main's runtime says about the providers extensions registered with it. */
interface Registered {
	getRegisteredProviderIds(): readonly string[];
	getRegisteredProviderConfig(id: string): object | undefined;
}

/**
 * Pi's own loader, in a runtime of its own that main never sees: its parse,
 * its schema and how it composes each provider. A provider an extension
 * registered from config is registered there too, since an overlay that
 * breaks it would take it away from main. One an extension built itself
 * (native) is not, and its complaints are ignored: main keeps that one's own
 * base whatever the overlay does.
 */
export function piModelsCheck(sdk: Sdk, runtime: object): ModelsCheck {
	return async (path) => {
		const probe = await sdk.ModelRuntime.create({ modelsPath: path, credentials: NO_CREDENTIALS, modelsStore: NO_CATALOG, refreshOnCreate: false });
		const main = runtime as Partial<Registered>;
		const native = new Set<string>();
		const problems: string[] = [];
		for (const id of main.getRegisteredProviderIds?.() ?? []) {
			const config = main.getRegisteredProviderConfig?.(id);
			if (!config) { native.add(id); continue; }
			try { probe.registerProvider(id, config as Parameters<typeof probe.registerProvider>[1]); }
			catch (error) { problems.push(`Provider "${id}": ${(error as Error).message}`); }
		}
		// Pi joins its problems with blank lines, and names a provider's own as `Provider "<id>": ...`.
		problems.push(...(probe.getError() ?? "").split("\n\n").filter((part) => {
			const provider = /^Provider "([^"]+)": /.exec(part)?.[1];
			return part.trim() !== "" && !(provider && native.has(provider));
		}));
		return problems.length > 0 ? problems.join("\n\n") : undefined;
	};
}

/** Brings the shared runtime up to models.json before a launch picks its model; a problem is told and the launch goes on. */
export async function freshModels(runtime: object, modelsPath: string, check: ModelsCheck, warn: (message: string) => void): Promise<void> {
	if (typeof (runtime as Partial<Refreshable>).refresh !== "function") return;
	const seen = reads();
	// Another launch's check or refresh may have read the same file; look again once it is done.
	for (let read = seen.get(runtime); read?.pending; read = seen.get(runtime)) await read.pending;
	const before = seen.get(runtime) ?? {};
	const identity = fileIdentity(modelsPath);
	if (identity === before.identity || identity === before.warned) return;
	const pending = readInto(runtime as Refreshable, modelsPath, identity, check, warn);
	seen.set(runtime, { ...before, pending });
	await pending;
}

async function readInto(runtime: Refreshable, modelsPath: string, identity: string, check: ModelsCheck, warn: (message: string) => void): Promise<void> {
	const seen = reads();
	const before = seen.get(runtime) ?? {};
	let problem: string | undefined;
	try { problem = await check(modelsPath); }
	catch (error) { problem = `Pi could not check it: ${(error as Error).message}`; }
	if (problem) {
		seen.set(runtime, { ...(before.identity ? { identity: before.identity } : {}), warned: identity });
		warn(`subagents: ${modelsPath} does not load in Pi (${problem.split("\n")[0]!.replace(/:$/, "")}). Children use the models loaded before; fix the file.`);
		return;
	}
	try {
		await runtime.refresh({ allowNetwork: false });
		seen.set(runtime, { identity });
	} catch (error) {
		// Marked as tried all the same, so every launch does not warn again until the file changes.
		seen.set(runtime, { identity, warned: identity });
		warn(`subagents: could not read ${modelsPath} into the model runtime: ${(error as Error).message}. Children use the models loaded before.`);
	}
}
