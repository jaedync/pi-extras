/**
 * Subscription-limit fetching, parsing and credential lookup for the footer.
 * Credentials are sent only to the matching provider's usage endpoint.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageWindowKey = "primary" | "secondary" | "rolling" | "weekly" | "monthly";

export interface UsageWindow {
	key: UsageWindowKey;
	pct: number;
	windowSeconds?: number;
	resetsAtMs?: number;
	exhausted?: boolean;
}

export interface ProviderUsage {
	provider: "codex" | "opencode-go";
	windows: UsageWindow[];
	/** The provider's own plan label ("plus", "enterprise"), lowercased. */
	plan?: string;
}

export interface RegistryLike {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const USAGE_REQUEST_TIMEOUT_MS = 3000;
export const CODEX_AUTH_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");

const PLAN_LABEL = /^[a-z0-9_-]{1,32}$/;
const OPENCODE_GO_WINDOWS: ReadonlyArray<readonly [UsageWindowKey, number]> = [
	["rolling", 5 * 3600],
	["weekly", 7 * 86400],
	["monthly", 30 * 86400],
];

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const FALLBACK_WINDOW_LABELS: Record<UsageWindowKey, string> = {
	primary: "Primary limit", secondary: "Secondary limit",
	rolling: "Rolling limit", weekly: "Weekly limit", monthly: "Monthly limit",
};

/** Codex's primary slot can be weekly on plans with no five-hour bucket. */
export function usageWindowLabel(window: UsageWindow): string {
	const seconds = window.windowSeconds;
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
		return FALLBACK_WINDOW_LABELS[window.key];
	}
	if (seconds === 7 * SECONDS_PER_DAY) return "Weekly limit";
	if (seconds === 30 * SECONDS_PER_DAY) return "Monthly limit";
	for (const [unit, size] of [
		["day", SECONDS_PER_DAY], ["hour", SECONDS_PER_HOUR],
		["minute", SECONDS_PER_MINUTE], ["second", 1],
	] as const) {
		if (seconds % size === 0) return `${seconds / size}-${unit} limit`;
	}
	return FALLBACK_WINDOW_LABELS[window.key];
}

export function planLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const plan = value.trim().toLowerCase();
	return PLAN_LABEL.test(plan) ? plan : undefined;
}

function readCodexAuth(authFile: string): { access?: unknown; accountId?: unknown } {
	try {
		const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { access?: unknown; accountId?: unknown }>;
		return auth["openai-codex"] ?? {};
	} catch {
		return {};
	}
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function codexAccountId(authFile = CODEX_AUTH_FILE): string | undefined {
	return nonEmpty(process.env.PI_CODEX_ACCOUNT_ID) ?? nonEmpty(readCodexAuth(authFile).accountId);
}

/**
 * openai-codex is an OAuth credential (access/refresh), so the registry's
 * getApiKeyForProvider() returns nothing for it; the live access token is
 * read from the same auth file that holds the account id.
 */
export function codexAccessToken(authFile = CODEX_AUTH_FILE): string | undefined {
	return nonEmpty(process.env.PI_CODEX_ACCESS_TOKEN) ?? nonEmpty(readCodexAuth(authFile).access);
}

export async function codexCredentials(
	registry?: RegistryLike,
	authFile = CODEX_AUTH_FILE,
): Promise<{ token: string; accountId: string } | undefined> {
	const token = (await registry?.getApiKeyForProvider("openai-codex")) || codexAccessToken(authFile);
	const accountId = codexAccountId(authFile);
	return token && accountId ? { token, accountId } : undefined;
}

export function parseCodexUsage(body: unknown): ProviderUsage | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as {
		plan_type?: unknown;
		rate_limit?: Record<string, { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown } | null>;
	};
	const windows: UsageWindow[] = [];
	for (const [source, key] of [["primary_window", "primary"], ["secondary_window", "secondary"]] as const) {
		const window = record.rate_limit?.[source];
		if (!window || typeof window.used_percent !== "number") continue;
		windows.push({
			key,
			pct: window.used_percent,
			...(typeof window.limit_window_seconds === "number" ? { windowSeconds: window.limit_window_seconds } : {}),
			...(typeof window.reset_at === "number" ? { resetsAtMs: window.reset_at * 1000 } : {}),
		});
	}
	if (!windows.length) return undefined;
	const plan = planLabel(record.plan_type);
	return { provider: "codex", windows, ...(plan ? { plan } : {}) };
}

export function parseOpenCodeGoUsage(body: unknown): ProviderUsage | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as { usage?: Record<string, { percent?: unknown; resetsAt?: unknown; status?: unknown }> };
	const windows: UsageWindow[] = [];
	for (const [key, windowSeconds] of OPENCODE_GO_WINDOWS) {
		const window = record.usage?.[key];
		if (!window || typeof window.percent !== "number") continue;
		const resetMs = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
		windows.push({
			key,
			pct: window.percent,
			windowSeconds,
			...(Number.isFinite(resetMs) ? { resetsAtMs: resetMs } : {}),
			exhausted: window.status === "rate-limited" || window.percent >= 100,
		});
	}
	return windows.length ? { provider: "opencode-go", windows } : undefined;
}

async function fetchJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS) });
	if (!response.ok) return undefined;
	return response.json();
}

/** Codex usage, the same endpoint the Codex CLI reads. */
export async function pollCodexUsage(
	registry?: RegistryLike,
	fetchImpl: FetchLike = fetch,
	authFile = CODEX_AUTH_FILE,
): Promise<ProviderUsage | undefined> {
	const credentials = await codexCredentials(registry, authFile);
	if (!credentials) return undefined;
	return parseCodexUsage(await fetchJson(fetchImpl, CODEX_USAGE_URL, {
		authorization: `Bearer ${credentials.token}`,
		"chatgpt-account-id": credentials.accountId,
	}));
}

/** OpenCode Go rolling, weekly, and monthly windows. */
export async function pollOpenCodeGoUsage(
	registry?: RegistryLike,
	fetchImpl: FetchLike = fetch,
): Promise<ProviderUsage | undefined> {
	const apiKey = await registry?.getApiKeyForProvider("opencode-go");
	if (!apiKey) return undefined;
	return parseOpenCodeGoUsage(await fetchJson(fetchImpl, OPENCODE_GO_USAGE_URL, { authorization: `Bearer ${apiKey}` }));
}
