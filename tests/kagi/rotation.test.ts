import { expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';
const html = '<div class="search-result"><a class="__sri_title_link" href="https://example.test/">Safe</a></div>';
it('blocks the same failed credential but recovers on rotation in the running client', async () => {
  let credential = 'synthetic-old';
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }))
    .mockImplementation(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  const client = new KagiClient({ credential: async () => credential, fetcher, spacingMs: 0 });
  await expect(client.search({ query: 'a' })).rejects.toMatchObject({ code: 'auth' });
  await expect(client.search({ query: 'b' })).rejects.toMatchObject({ code: 'auth' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  credential = 'synthetic-new';
  await expect(client.search({ query: 'a' })).resolves.toMatchObject({ resultCount: 1, cached: false });
  expect(fetcher).toHaveBeenCalledTimes(2);
  credential = 'synthetic-old';
  await expect(client.search({ query: 'c' })).rejects.toMatchObject({ code: 'auth' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCredential } from '../../lib/kagi/credential.js';
it('rereads a changed token FILE after auth failure without restarting Pi', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'kagi-rotation-')), 'credential');
  await writeFile(path, 'synthetic-before', { mode: 0o600 });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }))
    .mockImplementation(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  const client = new KagiClient({ credential: signal => readCredential(signal, path), fetcher, spacingMs: 0 });
  await expect(client.search({ query: 'x' })).rejects.toMatchObject({ code: 'auth' });
  await expect(client.search({ query: 'x' })).rejects.toMatchObject({ code: 'auth' });
  await writeFile(path, 'synthetic-after', { mode: 0o600 });
  await expect(client.search({ query: 'x' })).resolves.toMatchObject({ cached: false });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
