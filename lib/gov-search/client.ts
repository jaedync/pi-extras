/**
 * One gov_search call: check the input, read the key and the proxy setting
 * (only now, so a change applies without /reload), send one POST, and map
 * the answer to results or to a friendly error. Every error that leaves
 * here passes through `redact`.
 */
import { createHash } from "node:crypto";
import { resolveProxy, type ProxyAddress } from "./config.ts";
import { errors, GovSearchError, redact } from "./errors.ts";
import { requestBody, validateInput } from "./input.ts";
import { defaultKeyFile, readKey } from "./key.ts";
import { formatOutput, type FormattedOutput } from "./output.ts";
import { badRequestReason, dedupe, parseResponse } from "./response.ts";
import { post, tlsSecure, type Reply, type Secure, type Target } from "./transport.ts";

export const API_TARGET: Target = { host: "api.firecrawl.dev", port: 443 };
export const API_PATH = "/v2/search/gov";
const MAX_BODY_BYTES = 2_000_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

export interface ClientOptions {
	target?: Target;
	secure?: Secure;
	timeoutMs?: number;
	maxInFlight?: number;
	env?: () => NodeJS.ProcessEnv;
	/** The key file when FIRECRAWL_API_KEY_FILE is not set; tests point it away from the real home. */
	defaultKeyFile?: string;
	/** The proxy to use; tests set it, Pi reads the setting. */
	proxy?: (env: NodeJS.ProcessEnv) => ProxyAddress | undefined;
}

export interface SearchOutput extends FormattedOutput {
	proxied: boolean;
	keyed: boolean;
}

function retryAfterMs(reply: Reply): number {
	const header = reply.headers["retry-after"];
	const seconds = Number(Array.isArray(header) ? header[0] : header);
	// Without a usable header, a short pause still stops a loop from spending requests on a known 429.
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 60_000;
}

export class GovSearchClient {
	private inFlight = 0;
	private readonly cooldowns = new Map<string, { until: number; error: GovSearchError }>();
	private readonly options: Required<ClientOptions>;

	constructor(options: ClientOptions = {}) {
		this.options = { target: API_TARGET, secure: tlsSecure(), timeoutMs: 20_000, maxInFlight: 4, env: () => process.env, defaultKeyFile: defaultKeyFile(), proxy: (env) => resolveProxy(env), ...options };
	}

	async search(input: unknown, options: { signal?: AbortSignal } = {}): Promise<SearchOutput> {
		const valid = validateInput(input);
		const env = this.options.env();
		const key = await readKey(env, options.signal, this.options.defaultKeyFile);
		try {
			const proxy = this.options.proxy(env);
			const identity = key ? createHash("sha256").update(key).digest("hex") : "keyless";
			const cooldown = this.cooldowns.get(identity);
			if (cooldown && cooldown.until > Date.now()) throw cooldown.error;
			if (this.inFlight >= this.options.maxInFlight) throw errors.busy(this.options.maxInFlight);
			this.inFlight++;
			try {
				const reply = await this.send(requestBody(valid), key, proxy, options.signal);
				if (reply.status === 429) this.cooldowns.set(identity, { until: Date.now() + retryAfterMs(reply), error: errors.rate(key !== undefined) });
				const parsed = parseResponse(this.checkStatus(reply, key));
				const unique = dedupe(parsed.results);
				const filtered = ["jurisdiction", "court", "courtType", "cites", "domain"].some((name) => valid[name as keyof typeof valid] !== undefined);
				const output = formatOutput(unique.results, { requestedCount: valid.k, retrievedCount: parsed.retrievedCount, duplicateCount: unique.duplicateCount, rejectedCount: parsed.rejectedCount, filtered });
				// The key only goes in a header, but a page that quotes it must not carry it into the transcript.
				const clean = (text: string) => redact(text, key);
				const results = output.results.map((result) => ({ ...result, title: clean(result.title), url: clean(result.url), snippet: clean(result.snippet) }));
				return { ...output, text: clean(output.text), results, proxied: proxy !== undefined, keyed: key !== undefined };
			} finally {
				this.inFlight--;
			}
		} catch (error) {
			const safe = error instanceof GovSearchError ? error : errors.network(undefined, false);
			throw redact(safe.message, key) === safe.message ? safe : new GovSearchError(safe.code, redact(safe.message, key));
		}
	}

	private async send(body: string, key: string | undefined, proxy: ProxyAddress | undefined, outer: AbortSignal | undefined): Promise<Reply> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs);
		const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
		const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "pi-extras-gov-search" };
		if (key) headers.Authorization = `Bearer ${key}`;
		try {
			return await post(API_PATH, headers, body, { target: this.options.target, proxy, secure: this.options.secure, signal, maxBodyBytes: MAX_BODY_BYTES });
		} catch (error) {
			// The socket error an abort causes says nothing useful; the reason for the abort does.
			if (timedOut) throw errors.timeout(Math.round(this.options.timeoutMs / 1000));
			if (signal.aborted) throw errors.cancelled();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private checkStatus(reply: Reply, key: string | undefined): string {
		if (reply.status === 200) return reply.body;
		if (reply.status === 400) throw errors.badRequest(redact(badRequestReason(reply.body), key));
		if (key && (reply.status === 401 || reply.status === 403)) throw errors.auth();
		if (reply.status === 403) throw errors.blocked();
		if (reply.status === 429) throw errors.rate(key !== undefined);
		if (reply.status >= 500) throw errors.upstream(reply.status);
		throw errors.http(reply.status);
	}
}
