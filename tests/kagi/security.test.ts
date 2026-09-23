import { describe, expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';
import { parseResults } from '../../lib/kagi/parser.js';
import { formatOutput } from '../../lib/kagi/output.js';
import { validateInput } from '../../lib/kagi/input.js';
import { abortable, delay } from '../../lib/kagi/async.js';
const html = '<div class="search-result"><a class="__sri_title_link" href="https://example.org/a?utm_source=x#top">A</a><div class="__sri-desc">body</div></div>';
const response = (body = html, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const create = (fetcher: typeof fetch, extra = {}) => new KagiClient({ credential: async () => 'test-secret', fetcher, spacingMs: 0, ...extra });
describe('security regressions', () => {
  it('never emits an HTML-entity-encoded credential', async () => {
    const entity = [...'test-secret'].map(c => `&#${c.charCodeAt(0)};`).join('');
    const result = await create(vi.fn(async () => response(html.replace('body', entity)))).search({ query: 'x' });
    expect(result.text).not.toContain('test-secret');
  });
  it('follows only bounded same-origin search redirects', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response('', 302, { location: '/search?q=x' })).mockResolvedValueOnce(response());
    await expect(create(fetcher).search({ query: 'x' })).resolves.toMatchObject({ resultCount: 1 });
    expect(fetcher.mock.calls[1][0].origin).toBe('https://kagi.com');
    for (const location of ['/welcome', '/signin', '/settings', 'https://kagi.com:444/search', '/search?token=test-secret', 'http://kagi.com/search']) {
      const f = vi.fn(async () => response('', 302, { location }));
      await expect(create(f).search({ query: 'x' })).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    }
    const loop = vi.fn(async () => response('', 302, { location: '/html/search?q=x' }));
    await expect(create(loop).search({ query: 'x' })).rejects.toThrow('redirect');
    expect(loop).toHaveBeenCalledTimes(3);
  });
  it('does not retry ordinary HTTP failures and bounds declared body length', async () => {
    const f = vi.fn(async () => response('', 404));
    await expect(create(f).search({ query: 'x' })).rejects.toThrow('HTTP'); expect(f).toHaveBeenCalledTimes(1);
    await expect(create(vi.fn(async () => response('', 200, { 'content-length': '2000001' }))).search({ query: 'x' })).rejects.toThrow('body');
    await expect(create(vi.fn(async () => new Response(null, { headers: { 'content-type': 'text/html' } }))).search({ query: 'x' })).rejects.toThrow('markup');
  });
  it('separates credential identity, expiration and capacity while reformatting cached queries by limit', async () => {
    let token = 'identity-a';
    const f = vi.fn(async () => response());
    const c = create(f, { credential: async () => token, ttlMs: 15, cacheSize: 1 });
    await c.search({ query: 'a' }); token = 'identity-b'; await c.search({ query: 'a' });
    await c.search({ query: 'b' }); await c.search({ query: 'a' });
    expect(f).toHaveBeenCalledTimes(4);
    await new Promise(r => setTimeout(r, 20)); await c.search({ query: 'a' });
    await c.search({ query: 'a', limit: 1 }); expect(f).toHaveBeenCalledTimes(5);
  });
  it('bounds queue and honors cancellation in helpers', async () => {
    const c = create(vi.fn(async () => response()), { credential: async () => new Promise(() => {}), timeoutMs: 30 });
    const tasks = Array.from({ length: 16 }, () => c.search({ query: 'x' }).catch(() => {}));
    await expect(c.search({ query: 'x' })).rejects.toThrow('queue'); await Promise.all(tasks);
    const controller = new AbortController(); controller.abort();
    await expect(delay(1, controller.signal)).rejects.toThrow('cancelled');
    await expect(abortable(Promise.resolve(), controller.signal)).rejects.toThrow('cancelled');
  });
  it('limits Unicode bytes without splitting a URL and ignores malformed result links', () => {
    const result = { rank: 1, title: '界'.repeat(240), url: 'https://example.org/' + 'a'.repeat(1500), snippet: 'b'.repeat(600), excerptClipped: true };
    const output = formatOutput([result], 1, { retrievalComplete: true, pagesFetched: 1, rejectedCount: 0 });
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(12_000); expect(output.truncated).toBe(true);
    for (const url of ['not-a-url', 'https://u:p@site.test', 'https://kagi.com/settings', 'https://a.test/' + 'a'.repeat(2048)]) {
      expect(() => parseResults(html.replace('https://example.org/a?utm_source=x#top', url), 5)).toThrow();
    }
    expect(parseResults(html, 5)[0]).toMatchObject({ url: 'https://example.org/a', snippet: 'body' });
    expect(() => validateInput(null)).toThrow('input');
  });
});
