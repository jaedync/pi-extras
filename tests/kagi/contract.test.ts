import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';
import { registerKagi } from '../../lib/kagi/index.js';
import { validateInput } from '../../lib/kagi/input.js';
import { MAX_OUTPUT_BYTES, formatOutput } from '../../lib/kagi/output.js';
import { MAX_EXCERPT_CHARS, parsePage } from '../../lib/kagi/parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const card = (n: number, snippet = `Excerpt ${n}`) => `<div class="search-result"><a class="__sri_title_link" href="https://example.test/${n}">Title ${n}</a><div class="__sri-desc">${snippet}</div></div>`;

describe('public tool contract', () => {
  it('exposes only query, optional limit up to 20, and optional domain', () => {
    const pi = { registerTool: vi.fn() };
    registerKagi(pi as never, { name: 'web_search', client: { search: vi.fn() } as never });
    const tool = pi.registerTool.mock.calls[0][0];
    expect(Object.keys(tool.parameters.properties)).toEqual(['query', 'limit', 'domain']);
    expect(tool.parameters.properties.limit.maximum).toBe(20);
    expect(tool.description).toContain('Max 20 results');
    expect(tool.description).not.toMatch(/snippetChars|maxOutputBytes|24KB|1000 characters/);
  });

  it('purely strips removed resumed-call fields and never honors them', async () => {
    const search = vi.fn(async () => ({ text: 'safe result', cached: false, resultCount: 1, truncated: false, requestedCount: 1, retrievedCount: 1, omittedCount: 0, excerptClippedCount: 0, status: 'complete', pagesFetched: 1 }));
    const pi = { registerTool: vi.fn() };
    registerKagi(pi as never, { name: 'web_search', client: { search } as never });
    const tool = pi.registerTool.mock.calls[0][0];
    const prepared = tool.prepareArguments({ query: 'x', limit: 1, snippetChars: 0, maxOutputBytes: 1024 });
    expect(prepared).toEqual({ query: 'x', limit: 1 });
    // Pi schema validation structured-clones prepared arguments before execute.
    const result = await tool.execute('legacy', structuredClone(prepared), undefined, undefined, { hasUI: false });
    expect(search).toHaveBeenCalledWith({ query: 'x', limit: 1 }, { signal: undefined });
    expect(result.content[0].text).toBe('safe result');
    expect(tool.prepareArguments(prepared)).toEqual(prepared);
  });

  it('defaults limit to 5, accepts 20, normalizes DNS domains, and rejects removed fields at the runtime boundary', () => {
    expect(validateInput({ query: 'x' }).limit).toBe(5);
    expect(validateInput({ query: 'x', domain: ' ПРИМЕР.РФ. ' }).query).toBe('x site:xn--e1afmkfd.xn--p1ai');
    expect(validateInput({ query: 'x', limit: 20 }).limit).toBe(20);
    expect(() => validateInput({ query: 'x', limit: 21 })).toThrow('input');
    expect(() => validateInput({ query: 'x', snippetChars: 1 })).toThrow('input');
    expect(() => validateInput({ query: 'x', maxOutputBytes: 2000 })).toThrow('input');
  });
});

describe('verified parsing states', () => {
  it('distinguishes the verified empty state from unknown markup', () => {
    const empty = parsePage(fixture('verified-empty.html'), '"MZALC4T0" datasheet');
    expect(empty).toMatchObject({ results: [], empty: true, nextUrl: undefined });
    expect(() => parsePage('<title>Kagi Search</title><p>unknown</p>', 'x')).toThrow('markup');
  });

  it.each(['captcha', 'just a moment', 'sign in', 'captcha tutorial', 'just a moment in history', 'how to sign in'])('does not classify query-bearing title %s as auth or challenge', query => {
    expect(parsePage(`<title>${query} - Kagi Search</title>${card(1)}`, query).results).toHaveLength(1);
  });

  it('clips excerpts at the internal boundary with an explicit indicator while preserving the title and URL', () => {
    const title = 'Complete title';
    const page = parsePage(card(1, 'a'.repeat(MAX_EXCERPT_CHARS + 1)).replace('Title 1', title), 'x');
    expect(page.results[0]).toMatchObject({ title, url: 'https://example.test/1', excerptClipped: true });
    expect(page.results[0].snippet).toMatch(/… \[excerpt clipped\]$/);
  });
});

describe('bounded count-driven pagination', () => {
  it('follows only the verified explicit same-origin marker, deduplicates, and caches structured query results independently of limit', async () => {
    const fetcher = vi.fn(async (url: URL) => response(url.searchParams.get('batch') === '2' ? fixture('verified-pagination-page-2.html') : fixture('verified-pagination-page-1.html')));
    const client = new KagiClient({ credential: async () => 'fixture-token', fetcher: fetcher as typeof fetch, spacingMs: 0 });
    const first = await client.search({ query: 'python documentation', limit: 1 });
    expect(first).toMatchObject({ resultCount: 1, pagesFetched: 1, cached: false });
    const expanded = await client.search({ query: 'python documentation', limit: 4 });
    expect(expanded).toMatchObject({ resultCount: 4, pagesFetched: 2, cached: true, status: 'complete' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0].href).toBe('https://kagi.com/html/search?q=python+documentation&batch=2');
    expect(expanded.text.match(/https:\/\/example\.test\/two/g)).toHaveLength(1);
  });

  it('never follows arbitrary or invalid pagination links and reports a safe partial result', async () => {
    for (const link of [
      '<a rel="next" href="https://evil.test/steal">More Results</a>',
      '<a id="load_more_results" class="btn --secondary --block" href="https://evil.test/html/search?q=x&batch=2">More Results</a>',
      '<a id="load_more_results" class="btn --secondary --block" href="/settings?q=x&batch=2">More Results</a>',
      '<a id="load_more_results" class="btn --secondary --block" href="/html/search?q=other&batch=2">More Results</a>',
    ]) {
      const fetcher = vi.fn(async () => response(card(1) + link));
      const result = await new KagiClient({ credential: async () => 'fixture-token', fetcher, spacingMs: 0 }).search({ query: 'x', limit: 2 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ resultCount: 1, status: 'partial' });
      expect(result.text).toMatch(/pagination link was rejected|no verified pagination link/);
    }
  });

  it('caps all HTTP attempts at three and returns prior safe records if a later page is blocked', async () => {
    const page = (batch: number) => card(batch) + `<a id="load_more_results" class="btn --secondary --block" href="/html/search?q=x&amp;batch=${batch + 1}">More Results</a>`;
    const fetcher = vi.fn(async (url: URL) => response(page(Number(url.searchParams.get('batch') || 1))));
    const result = await new KagiClient({ credential: async () => 'fixture-token', fetcher: fetcher as typeof fetch, spacingMs: 0 }).search({ query: 'x', limit: 5 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ resultCount: 3, pagesFetched: 3, status: 'partial' });
    expect(result.text).toContain('request cap');

    const blocked = vi.fn().mockResolvedValueOnce(response(card(1) + '<a id="load_more_results" class="btn --secondary --block" href="/html/search?q=y&amp;batch=2">More Results</a>')).mockResolvedValueOnce(response('', 429));
    const client = new KagiClient({ credential: async () => 'fixture-token', fetcher: blocked, spacingMs: 0 });
    await expect(client.search({ query: 'y', limit: 2 })).resolves.toMatchObject({ resultCount: 1, status: 'partial' });
    await expect(client.search({ query: 'other' })).rejects.toMatchObject({ code: 'rate' });
    expect(blocked).toHaveBeenCalledTimes(2);
  });
});

describe('markup cooldown and output budgeting', () => {
  it('uses a bounded query-specific markup cooldown rather than poisoning unrelated queries', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('<p>unknown</p>'))
      .mockImplementation(async () => response(card(1)));
    const client = new KagiClient({ credential: async () => 'fixture-token', fetcher, spacingMs: 0, markupCooldownMs: 10 });
    await expect(client.search({ query: 'bad' })).rejects.toMatchObject({ code: 'markup' });
    await expect(client.search({ query: 'good' })).resolves.toMatchObject({ resultCount: 1 });
    await expect(client.search({ query: 'bad' })).rejects.toMatchObject({ code: 'markup' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await new Promise(resolve => setTimeout(resolve, 15));
    await expect(client.search({ query: 'bad' })).resolves.toMatchObject({ resultCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('skips an oversized first record, returns later useful records, and reports exact clipping counts', () => {
    const records = [
      { rank: 1, title: 'x'.repeat(MAX_OUTPUT_BYTES), url: 'https://example.test/oversized', snippet: '', excerptClipped: false },
      { rank: 2, title: 'Useful', url: 'https://example.test/useful', snippet: 'Evidence', excerptClipped: false },
    ];
    const output = formatOutput(records, 2, { retrievalComplete: true, pagesFetched: 1, rejectedCount: 0 });
    expect(output.text).toContain('https://example.test/useful');
    expect(output.text).not.toContain('https://example.test/oversized');
    expect(output).toMatchObject({ resultCount: 1, omittedCount: 1, truncated: true });
    expect(output.text).toContain('1 retrieved record omitted by the output budget');
  });

  it('accepts a record that exactly fits the internal output budget', () => {
    const base = formatOutput([{ rank: 1, title: '', url: 'https://e.test/', snippet: '', excerptClipped: false }], 1, { retrievalComplete: true, pagesFetched: 1, rejectedCount: 0 });
    const padding = MAX_OUTPUT_BYTES - Buffer.byteLength(base.text);
    const exact = formatOutput([{ rank: 1, title: 'x'.repeat(padding), url: 'https://e.test/', snippet: '', excerptClipped: false }], 1, { retrievalComplete: true, pagesFetched: 1, rejectedCount: 0 });
    expect(Buffer.byteLength(exact.text)).toBe(MAX_OUTPUT_BYTES);
    expect(exact).toMatchObject({ resultCount: 1, omittedCount: 0 });
  });
});
