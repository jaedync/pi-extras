/**
 * Which provider ids bill their family's plan (lib/provider-family.ts). The
 * subscription logins of a family are one identity, but a per-token API key
 * is not billed by the plan: it gets no plan windows, cooldowns or fallback
 * blocks. `openai` is plan-billed only through Sign in with ChatGPT (an OAuth
 * login in Pi's auth.json); `anthropic` is not when the Anthropic poll found
 * that Pi's credential is an API key and no proxy quota route applies.
 *
 * The state hangs off globalThis, so every module graph and /reload sees the
 * last poll's finding.
 */
import { CODEX_AUTH_FILE, chatgptLogin } from "./provider-limits.ts";
import { isFamilyId, providerFamily } from "./provider-family.ts";

/** The openai login is read from the file at most this often. */
const AUTH_TTL_MS = 2_000;

interface PlanState {
	anthropicApiKey: boolean;
	authFile?: string;
	openai?: { file: string; atMs: number; value: boolean };
}

const STATE_KEY = Symbol.for("pi-extras.plan-billing");

function state(): PlanState {
	const host = globalThis as unknown as Record<symbol, PlanState | undefined>;
	return (host[STATE_KEY] ??= { anthropicApiKey: false });
}

/** Tests point the openai check at a file of their own; undefined goes back to Pi's auth.json. */
export function setPlanAuthFile(file: string | undefined): void {
	state().authFile = file;
	state().openai = undefined;
}

/** Called by the Anthropic poll, which reads Pi's anthropic credential. */
export function noteAnthropicApiKey(apiKey: boolean): void {
	state().anthropicApiKey = apiKey;
}

export function planBilled(provider: string, now = Date.now()): boolean {
	const current = state();
	if (provider === "anthropic") return !current.anthropicApiKey;
	if (provider !== "openai") return true;
	const file = current.authFile ?? CODEX_AUTH_FILE;
	const cached = current.openai;
	if (cached?.file === file && now - cached.atMs < AUTH_TTL_MS) return cached.value;
	const value = chatgptLogin(file);
	current.openai = { file, atMs: now, value };
	return value;
}

/**
 * Where a provider's limit readings live: its family's id when it bills the
 * plan, else its own. An API key on the family's own id gets a key apart
 * from the plan's.
 */
export function limitKey(provider: string): string {
	const family = providerFamily(provider);
	if (planBilled(provider)) return family;
	return family === provider ? `${provider}:api-key` : provider;
}

/** The key of a reading named by a poller (a family id) or by a member. */
export const storeKey = (provider: string): string => (isFamilyId(provider) ? provider : limitKey(provider));
