import { describe, expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';

const html = (url: string) => `<div class="search-result"><a class="__sri_title_link" href="${url}">Safe</a></div>`;
const page = (url = 'https://example.test/') => new Response(html(url), { headers: { 'content-type': 'text/html' } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A fetcher that records overlap and start times, answering after `ms`. */
function slowFetcher(ms: number) {
  const seen = { active: 0, max: 0, starts: [] as number[] };
  const fetcher = vi.fn(async (url: URL) => {
    seen.active++; seen.max = Math.max(seen.max, seen.active); seen.starts.push(Date.now());
    await sleep(ms);
    seen.active--;
    return page(`https://example.test/${new URL(url).searchParams.get('q')}`);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls: fetcher, seen };
}

const create = (fetcher: typeof fetch, options = {}) => new KagiClient({ credential: async () => 'test-secret', fetcher, ...options });

describe('request pacing', () => {
  it('runs up to four searches at once and staggers their starts', async () => {
    const { fetcher, seen } = slowFetcher(100);
    const client = create(fetcher, { spacingMs: 20 });
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(query => client.search({ query })));
    expect(seen.max).toBe(4);
    // Each start is only as punctual as its timer, so check the spread rather than every gap.
    expect(seen.starts[3] - seen.starts[0]).toBeGreaterThanOrEqual(55);
    for (let i = 1; i < seen.starts.length; i++) expect(seen.starts[i] - seen.starts[i - 1]).toBeGreaterThanOrEqual(10);
  });

  it('holds page requests to the per-window cap', async () => {
    const { fetcher, seen } = slowFetcher(1);
    const client = create(fetcher, { spacingMs: 0, pagesPerWindow: 3, windowMs: 120 });
    await Promise.all(['a', 'b', 'c', 'd'].map(query => client.search({ query })));
    expect(seen.starts[3] - seen.starts[0]).toBeGreaterThanOrEqual(115);
  });

  it('fails fast instead of waiting past the deadline for the window', async () => {
    const { fetcher, calls } = slowFetcher(1);
    const client = create(fetcher, { spacingMs: 0, pagesPerWindow: 1, windowMs: 10_000, timeoutMs: 500 });
    await client.search({ query: 'a' });
    const started = Date.now();
    await expect(client.search({ query: 'b' })).rejects.toMatchObject({ code: 'pace' });
    expect(Date.now() - started).toBeLessThan(100);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('refuses queued searches without new requests once Kagi rate-limits', async () => {
    const calls = vi.fn(async () => { await sleep(20); return new Response('', { status: 429 }); });
    const client = create(calls as unknown as typeof fetch, { spacingMs: 0, concurrency: 1 });
    const results = await Promise.allSettled(['a', 'b', 'c'].map(query => client.search({ query })));
    expect(results.map(result => result.status === 'rejected' && result.reason.code)).toEqual(['rate', 'rate', 'rate']);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('lets identical concurrent queries share one request', async () => {
    const { fetcher, calls } = slowFetcher(20);
    const client = create(fetcher, { spacingMs: 0 });
    const [first, second] = await Promise.all([client.search({ query: 'same' }), client.search({ query: 'same' })]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect([first.cached, second.cached]).toEqual([false, true]);
  });

  it('frees a waiting slot when its caller cancels', async () => {
    const { fetcher, calls } = slowFetcher(40);
    const client = create(fetcher, { spacingMs: 0, concurrency: 1 });
    const controller = new AbortController();
    const running = client.search({ query: 'a' });
    const waiting = client.search({ query: 'b' }, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    await running;
    await client.search({ query: 'c' });
    expect(calls).toHaveBeenCalledTimes(2);
  });
});
