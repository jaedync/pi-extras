import { describe, expect, it, vi } from 'vitest';
import { parseCredential } from '../../lib/kagi/credential.js';
import { parseResults } from '../../lib/kagi/parser.js';
import { KagiClient } from '../../lib/kagi/client.js';
import { validateInput } from '../../lib/kagi/input.js';

const html = '<title>Kagi Search</title><div class="search-result"><a class="__sri_title_link" href="https://example.org/doc">Example &amp; Docs</a><div class="__sri-desc">A <b>useful</b> snippet</div></div>';
const response = (body = html, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const client = (fetcher = vi.fn(async () => response()), options = {}) => new KagiClient({ credential: async () => 'fixture-token', fetcher, spacingMs: 0, ...options });

describe('credential boundary', () => {
  it('accepts raw and safely extracts a session link without requesting it', () => {
    expect(parseCredential('fixture-token\n')).toBe('fixture-token');
    expect(parseCredential('https://kagi.com/search?token=fixture-token')).toBe('fixture-token');
  });
  it.each(['', 'x\ny', 'x; cookie=y', 'https://evil.test/?token=x', 'https://kagi.com.evil.test/?token=x', 'http://kagi.com/?token=x', 'https://kagi.com/?token=x&token=y'])('rejects unsafe credential %s', value => {
    expect(() => parseCredential(value)).toThrow('credential');
  });
});

describe('input', () => {
  it('preserves search syntax and applies a domain filter', () => {
    expect(validateInput({ query: '"a b" -c', domain: 'docs.python.org' }).query).toBe('"a b" -c site:docs.python.org');
  });
  it.each([{ query: '' }, { query: 'x', limit: NaN }, { query: 'x', limit: 1.5 }, { query: 'x', limit: 21 }, { query: 'x', domain: 'x OR y' }, { query: 'x', recency: 'day' }, { query: 'x'.repeat(513) }])('rejects invalid input %j', value => {
    expect(() => validateInput(value)).toThrow('input');
  });
});

describe('parser', () => {
  it('extracts decoded clean ranked results', () => {
    expect(parseResults(html, 5)).toEqual([{ rank: 1, title: 'Example & Docs', url: 'https://example.org/doc', snippet: 'A useful snippet', excerptClipped: false }]);
  });
  it('deduplicates and retains grouped results in document order', () => {
    const grouped = '<div class="sr-group"><div class="__srgi"><div class="__srgi-title"><a href="https://group.test/">Group</a></div></div></div>';
    expect(parseResults(grouped + html + html, 5).map(r => r.title)).toEqual(['Group', 'Example & Docs']);
  });
  it.each(['<title>Sign in - Kagi</title>', '<title>Just a moment...</title>', '<form action="/signin"><input type="password"></form>', '<div class="search-result">changed markup</div>', '<p>unrecognized</p>'])('fails closed instead of fake empty', page => {
    expect(() => parseResults(page, 5)).toThrow();
  });
  it('rejects javascript links and removes executable text', () => {
    expect(() => parseResults(html.replace('https://example.org/doc', 'javascript:alert(1)'), 5)).toThrow();
    expect(parseResults(html.replace('A <b>', '<script>secret</script>A <b>'), 5)[0].snippet).toBe('A useful snippet');
  });
});

describe('HTTP integration with adversarial responses', () => {
  it('uses cookie only on fixed HTTPS origin and caches safely', async () => {
    const fetcher = vi.fn(async () => response());
    const search = client(fetcher);
    const a = await search.search({ query: 'docs' });
    const b = await search.search({ query: 'docs' });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, { redirect: string; headers: Record<string, string> }];
    expect(url.origin).toBe('https://kagi.com');
    expect(init.redirect).toBe('manual');
    expect(init.headers.Cookie).toBe('kagi_session=fixture-token');
    await search.search({ query: 'docs' }, { bypassCache: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never follows a cross-origin redirect', async () => {
    const fetcher = vi.fn(async () => response('', 302, { location: 'https://evil.test' }));
    await expect(client(fetcher).search({ query: 'docs' })).rejects.toThrow('redirect');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops live attempts on login and rate limit', async () => {
    for (const status of [401, 403, 429]) {
      const fetcher = vi.fn(async () => response('', status));
      const search = client(fetcher);
      await expect(search.search({ query: 'docs' })).rejects.toThrow();
      await expect(search.search({ query: 'other' })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('retries transient statuses only once', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response('', 503)).mockResolvedValueOnce(response());
    await expect(client(fetcher).search({ query: 'docs' })).resolves.toMatchObject({ cached: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('bounds body and content type, sanitizes network errors', async () => {
    await expect(client(vi.fn(async () => response('x'.repeat(2_000_001)))).search({ query: 'x' })).rejects.toThrow('body');
    await expect(client(vi.fn(async () => response('{}', 200, { 'content-type': 'application/json' }))).search({ query: 'x' })).rejects.toThrow('content');
    await expect(client(vi.fn(async () => { throw new Error('SECRET cookie'); })).search({ query: 'x' })).rejects.toThrow(/^Kagi network failure\.$/);
  });
  it('times out body and queued work, supports caller cancellation', async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/html' } }));
    const search = client(fetcher, { timeoutMs: 30 });
    await Promise.all([expect(search.search({ query: 'x' })).rejects.toThrow('cancelled'), expect(search.search({ query: 'y' })).rejects.toThrow('cancelled')]);
    const controller = new AbortController(); controller.abort();
    await expect(client().search({ query: 'x' }, { signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
