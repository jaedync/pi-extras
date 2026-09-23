import { describe, expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';
import { RequestPacer } from '../../lib/kagi/pacing.js';

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
  it('runs up to four searches at once', async () => {
    const { fetcher, seen } = slowFetcher(100);
    const client = create(fetcher, { spacingMs: 0 });
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(query => client.search({ query })));
    expect(seen.max).toBe(4);
  });

  it('applies the start spacing to every request', async () => {
    const { fetcher, calls } = slowFetcher(1);
    const client = create(fetcher, { spacingMs: 10_000, timeoutMs: 500 });
    await client.search({ query: 'a' });
    await expect(client.search({ query: 'b' })).rejects.toMatchObject({ code: 'pace' });
    expect(calls).toHaveBeenCalledTimes(1);
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

  it('frees a slot only once however often it is released', async () => {
    const pacer = new RequestPacer({ concurrency: 1, spacingMs: 0, pagesPerWindow: 30, windowMs: 60_000 });
    const release = await pacer.acquire(new AbortController().signal);
    release(); release();
    const again = await pacer.acquire(new AbortController().signal);
    // A double release must not have freed a second slot.
    let second = false;
    void pacer.acquire(new AbortController().signal).then(() => { second = true; });
    await sleep(5);
    expect(second).toBe(false);
    again();
    await sleep(0);
    expect(second).toBe(true);
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

describe('RequestPacer schedule', () => {
  /** A frozen clock whose waits are recorded instead of slept. */
  function frozen(at = 1000) {
    const clock = { time: at, waits: [] as number[] };
    return { clock, now: () => clock.time, wait: async (ms: number) => { clock.waits.push(ms); } };
  }
  const signal = new AbortController().signal;
  const options = { concurrency: 4, spacingMs: 150, pagesPerWindow: 30, windowMs: 60_000 };

  it('reserves starts spacing apart, even when requested together', async () => {
    const { clock, now, wait } = frozen();
    const pacer = new RequestPacer(options, { now, wait });
    await Promise.all([pacer.start(signal, Infinity), pacer.start(signal, Infinity), pacer.start(signal, Infinity)]);
    expect(clock.waits).toEqual([0, 150, 300]);
  });

  it('holds starts past the per-window cap until the oldest leaves the window', async () => {
    const { clock, now, wait } = frozen();
    const pacer = new RequestPacer({ ...options, spacingMs: 0, pagesPerWindow: 3, windowMs: 100 }, { now, wait });
    for (let i = 0; i < 4; i++) await pacer.start(signal, Infinity);
    expect(clock.waits).toEqual([0, 0, 0, 100]);
    clock.time += 150;
    await pacer.start(signal, Infinity);
    expect(clock.waits.at(-1)).toBe(0);
  });

  it('refuses a start past the deadline without reserving it', async () => {
    const { clock, now, wait } = frozen();
    const pacer = new RequestPacer({ ...options, spacingMs: 0, pagesPerWindow: 1, windowMs: 10_000 }, { now, wait });
    await pacer.start(signal, Infinity);
    await expect(pacer.start(signal, clock.time + 500)).rejects.toMatchObject({ code: 'pace' });
    await pacer.start(signal, Infinity);
    expect(clock.waits).toEqual([0, 10_000]);
  });
});
