import { abortable } from './async.js';
import { KagiError } from './errors.js';

export const ORIGIN = 'https://kagi.com';
export const MAX_BODY_BYTES = 2_000_000;
export const MAX_REQUESTS = 3;

export interface RequestBudget { used: number }

export function initialSearchUrl(query: string): URL {
  const url = new URL('/html/search', ORIGIN);
  url.searchParams.set('q', query);
  return url;
}

function validatedSearchUrl(raw: string, base: URL, query: string): URL {
  let url: URL;
  try { url = new URL(raw, base); } catch { throw new KagiError('redirect'); }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new KagiError('redirect');
  if (/^\/(?:signin|login|welcome|signup)(?:\/|$)/i.test(url.pathname)) throw new KagiError('auth');
  if (!['/html/search', '/search'].includes(url.pathname)) throw new KagiError('redirect');
  if (keys.some(key => key !== 'q' && key !== 'batch') || url.searchParams.getAll('q').length !== 1 || url.searchParams.get('q') !== query || url.searchParams.getAll('batch').length > 1) throw new KagiError('redirect');
  const batch = url.searchParams.get('batch');
  if (batch !== null && (!/^[1-9]\d*$/.test(batch) || !Number.isSafeInteger(Number(batch)))) throw new KagiError('redirect');
  return url;
}

export async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) { void response.body?.cancel(); throw new KagiError('body'); }
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) { void response.body?.cancel(); throw new KagiError('content'); }
  const reader = response.body?.getReader();
  if (!reader) throw new KagiError('markup');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new KagiError('body');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function request(startUrl: URL, query: string, token: string, signal: AbortSignal, fetcher: typeof fetch, beforeRequest: () => Promise<void>, budget: RequestBudget): Promise<string> {
  let url = validatedSearchUrl(startUrl.href, startUrl, query);
  while (true) {
    if (budget.used >= MAX_REQUESTS) throw new KagiError('requestCap');
    await beforeRequest();
    budget.used++;
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { Cookie: `kagi_session=${token}`, Accept: 'text/html', 'User-Agent': 'pi-kagi-session/0.1' } });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || budget.used >= MAX_REQUESTS) throw new KagiError('redirect');
      url = validatedSearchUrl(location, url, query);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel();
      if (response.status === 429) throw new KagiError('rate');
      if ([401, 403].includes(response.status)) throw new KagiError('auth');
      if ([502, 503, 504].includes(response.status)) throw new KagiError('network');
      throw new KagiError('http');
    }
    return readBody(response, signal);
  }
}
