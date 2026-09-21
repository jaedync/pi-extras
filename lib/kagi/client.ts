import { createHash } from 'node:crypto';
import { abortable, delay } from './async.js';
import { parseCredential, readCredential } from './credential.js';
import { KagiError, safeError } from './errors.js';
import { validateInput, type SearchInput, type ValidInput } from './input.js';
import { initialSearchUrl, MAX_REQUESTS, request, type RequestBudget } from './http.js';
import { parsePage, type SearchResult } from './parser.js';
import { formatOutput, type FormattedOutput } from './output.js';

interface Options {
  credential?: (signal?: AbortSignal) => Promise<string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  spacingMs?: number;
  ttlMs?: number;
  cacheSize?: number;
  retries?: number;
  markupCooldownMs?: number;
}

interface CachedSearch {
  expires: number;
  results: SearchResult[];
  nextUrl?: string;
  pagesFetched: number;
  rejectedCount: number;
  knownExhausted: boolean;
  terminalReason?: string;
}

export interface SearchOutput extends FormattedOutput {
  cached: boolean;
  pagesFetched: number;
}

export class KagiClient {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private nextRequest = 0;
  private stopped = new Map<string, KagiError>();
  private markupUntil = new Map<string, number>();
  private identity?: string;
  private cache = new Map<string, CachedSearch>();
  private readonly options: Required<Options>;

  constructor(options: Options = {}) {
    this.options = { credential: readCredential, fetcher: fetch, timeoutMs: 20000, spacingMs: 750, ttlMs: 300000, cacheSize: 64, retries: 1, markupCooldownMs: 30000, ...options };
  }

  async search(input: SearchInput, options: { signal?: AbortSignal; bypassCache?: boolean } = {}): Promise<SearchOutput> {
    const validated = validateInput(input);
    if (this.pending >= 16) throw new KagiError('queue');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    this.pending++;
    const task = this.tail.then(async () => {
      if (signal.aborted) throw new KagiError('cancelled');
      const token = parseCredential(await abortable(this.options.credential(signal), signal));
      const identity = createHash('sha256').update(token).digest('hex');
      if (identity !== this.identity) { this.cache.clear(); this.identity = identity; }
      const stopped = this.stopped.get(identity);
      if (stopped) throw stopped;
      return this.searchWithToken(validated, token, identity, signal, options.bypassCache === true);
    });
    this.tail = task.catch(() => {});
    try { return await abortable(task, signal); }
    catch (error) { throw signal.aborted ? new KagiError('cancelled') : safeError(error); }
    finally { clearTimeout(timer); this.pending--; }
  }

  private async searchWithToken(input: ValidInput, token: string, identity: string, signal: AbortSignal, bypass: boolean): Promise<SearchOutput> {
    const key = createHash('sha256').update(JSON.stringify([token, input.query])).digest('hex');
    const existing = this.cache.get(key);
    const cached = !bypass && existing && existing.expires > Date.now() ? existing : undefined;
    const state: CachedSearch = cached
      ? { ...cached, results: cached.results.map(result => ({ ...result })) }
      : { expires: 0, results: [], nextUrl: initialSearchUrl(input.query).href, pagesFetched: 0, rejectedCount: 0, knownExhausted: false };
    const usedCache = Boolean(cached);
    const budget: RequestBudget = { used: 0 };

    while (state.results.length < input.limit && state.nextUrl && !state.knownExhausted) {
      const cooldown = this.markupUntil.get(this.markupKey(identity, input.query)) || 0;
      if (cooldown > Date.now()) {
        if (state.results.length === 0) throw new KagiError('markup');
        state.terminalReason = 'markup';
        break;
      }
      if (budget.used >= MAX_REQUESTS) {
        state.terminalReason = 'request-cap';
        state.nextUrl = undefined;
        break;
      }

      const pageUrl = new URL(state.nextUrl);
      let html: string;
      try {
        html = await this.fetchHtml(pageUrl, input.query, token, signal, budget);
        state.pagesFetched++;
        const page = parsePage(html, input.query, token);
        state.rejectedCount += page.rejectedCount;
        const seen = new Set(state.results.map(result => result.url));
        for (const result of page.results) {
          if (state.results.length >= 20) break;
          if (seen.has(result.url)) continue;
          seen.add(result.url);
          state.results.push({ ...result, rank: state.results.length + 1 });
        }
        state.knownExhausted = page.empty;
        state.nextUrl = page.nextUrl;
        state.terminalReason = page.nextRejected ? 'pagination-link-rejected' : (!page.nextUrl && !page.empty ? 'no-verified-pagination-link' : undefined);
      } catch (error) {
        const safe = safeError(error);
        this.stopIfNeeded(safe, identity, input.query);
        if (signal.aborted || safe.code === 'cancelled' || state.results.length === 0) throw safe;
        state.terminalReason = safe.code === 'requestCap' ? 'request-cap' : safe.code;
        // Keep the verified failed cursor for an explicit retry after cooldown.
        // Authentication incidents still block the entire credential above.
        break;
      }
    }

    if (state.results.length < input.limit && state.nextUrl && budget.used >= MAX_REQUESTS) {
      state.terminalReason = 'request-cap';
      state.nextUrl = undefined;
    }
    const retrievalComplete = state.results.length >= input.limit || state.knownExhausted;
    const partialReasons = retrievalComplete || !state.terminalReason ? [] : [state.terminalReason];
    const formatted = formatOutput(state.results, input.limit, { retrievalComplete, pagesFetched: state.pagesFetched, rejectedCount: state.rejectedCount, partialReasons });
    const replacement = '[redacted]'.slice(0, token.length);
    const redact = (value: string) => value.split(token).join(replacement).split(encodeURIComponent(token)).join(replacement);
    const results = formatted.results.map(result => ({ ...result, title: redact(result.title), url: redact(result.url), snippet: redact(result.snippet) }));
    const value = { ...formatted, text: redact(formatted.text), results, cached: usedCache, pagesFetched: state.pagesFetched };

    const hardStopped = state.terminalReason !== undefined && ['auth', 'challenge', 'rate'].includes(state.terminalReason);
    if (!bypass && !hardStopped) {
      this.pruneCaches();
      this.cache.delete(key);
      this.cache.set(key, { ...state, results: state.results.map(result => ({ ...result })), expires: cached?.expires ?? Date.now() + this.options.ttlMs });
      while (this.cache.size > this.options.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    }
    return value;
  }

  private async fetchHtml(url: URL, query: string, token: string, signal: AbortSignal, budget: RequestBudget): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(url, query, token, signal, this.options.fetcher, async () => {
          await delay(this.nextRequest - Date.now(), signal);
          this.nextRequest = Date.now() + this.options.spacingMs;
        }, budget);
      } catch (error) {
        const safe = safeError(error);
        if (signal.aborted || safe.code !== 'network' || attempt >= Math.min(this.options.retries, 1) || budget.used >= MAX_REQUESTS) throw safe;
        await delay(250, signal);
      }
    }
  }

  private stopIfNeeded(error: KagiError, identity: string, query: string): void {
    if (['auth', 'challenge', 'rate'].includes(error.code)) {
      this.stopped.set(identity, error);
      this.cache.clear();
      return;
    }
    if (error.code === 'markup') {
      this.markupUntil.set(this.markupKey(identity, query), Date.now() + this.options.markupCooldownMs);
      while (this.markupUntil.size > this.options.cacheSize) this.markupUntil.delete(this.markupUntil.keys().next().value!);
    }
  }

  private markupKey(identity: string, query: string): string {
    return createHash('sha256').update(`${identity}\0${query}`).digest('hex');
  }

  private pruneCaches(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) if (value.expires <= now) this.cache.delete(key);
    for (const [key, expires] of this.markupUntil) if (expires <= now) this.markupUntil.delete(key);
  }
}
