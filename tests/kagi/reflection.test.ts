import { expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';
import { parsePage } from '../../lib/kagi/parser.js';

const entity = (value: string) => [...value].map(character => `&#${character.charCodeAt(0)};`).join('');
const record = (title: string, snippet: string, url = 'https://example.test/safe') => `<div class="search-result"><a class="__sri_title_link" href="${url}">${title}</a><div class="__sri-desc">${snippet}</div></div>`;
const search = (html: string, token = 'test-secret') => new KagiClient({ credential: async () => token, spacingMs: 0, fetcher: vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } })) }).search({ query: 'x' });

it('redacts decoded complete snippets before applying the fixed internal excerpt boundary', async () => {
  const result = await search(record('Safe', 'a'.repeat(590) + entity('test-secret') + 'z'.repeat(20)));
  expect(result.text.split('https://example.test/safe\n')[1]?.split('\n\nStatus:')[0]).not.toMatch(/test|secre/);
});

it.each([230, 235, 239, 240])('redacts a credential crossing the former title boundary at %i without clipping the title', async prefix => {
  const result = await search(record('A'.repeat(prefix) + entity('test-secret'), 'Safe'));
  expect(result.text).not.toMatch(/test-s|test$/m);
});

it('checks decoded text after normalization and inline element joining', async () => {
  const result = await search(record('Safe', 'test-<b>secret</b>'));
  expect(result.text).not.toContain('test-secret');
  const spaced = await search(record('Safe', 'test-&#10;secret'));
  expect(spaced.text).toContain('test- secret'); // Not a recoverable contiguous reflection.
});

it.each([
  'https://example.test/?token=test%7Esecret',
  'https://example.test/?test%7esecret=value',
  'https://example.test/%74est~se%63ret',
  'https://example.test/#test%257Esecret',
  'https://test%7Esecret.example.test/',
  'https://example.test/?utm_source=test~secret',
  'https://example.test/?v=%2574est%257Esecret',
  'https://example.test/?bad=%zz&v=test%7esecret',
  'https://example.test/test~secret',
  'https://test~secret:password@example.test/',
])('rejects credential-bearing URL instead of returning a modified link: %s', async url => {
  const result = await search(record('Unsafe', 'unsafe', url) + record('Safe', 'safe'), 'test~secret');
  expect(result.resultCount).toBe(1);
  expect(result.text).not.toContain('Unsafe');
  expect(result.text).toContain('https://example.test/safe');
});

it('fails closed when the only URL reflects credentials', async () => {
  await expect(search(record('Unsafe', '', 'https://example.test/?v=test%2Dsecret'))).rejects.toThrow('markup');
});

it('redacts mixed percent-encoded text before fixed internal clipping', () => {
  const result = parsePage(record('Safe', '%74est%2Dsecret'), 'x', 'test-secret');
  expect(result.results[0].snippet).not.toContain('%74est');
});
