import { parse } from 'node-html-parser';
import { KagiError } from './errors.js';
import { credentialBearing, redactText } from './redaction.js';
import { ORIGIN } from './http.js';

export const MAX_EXCERPT_CHARS = 600;
const MAX_TITLE_BYTES = 4096;
const MAX_RESULTS_PER_PAGE = 20;
const EMPTY_TEXT = 'There are no results that match all your keywords exactly.';
const RESULT_SELECTOR = '.search-result .__sri_title_link, .sr-group .__srgi .__srgi-title a';
const NEXT_SELECTOR = 'a#load_more_results.btn.--secondary.--block';
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  excerptClipped: boolean;
}

export interface ParsedPage {
  results: SearchResult[];
  empty: boolean;
  nextUrl?: string;
  nextRejected: boolean;
  rejectedCount: number;
}

function cleanText(value: string, token?: string): string {
  return redactText(value, token).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function cleanExcerpt(value: string, token?: string): { text: string; clipped: boolean } {
  const complete = cleanText(value, token);
  const characters = Array.from(complete);
  if (characters.length <= MAX_EXCERPT_CHARS) return { text: complete, clipped: false };
  return { text: `${characters.slice(0, MAX_EXCERPT_CHARS).join('')}… [excerpt clipped]`, clipped: true };
}

function cleanUrl(raw: string | undefined, token?: string): string | undefined {
  if (!raw || raw.length > 2048) return;
  try {
    const url = new URL(raw);
    // Inspect before rewriting. A credential-bearing result is rejected, never made followable.
    if (token && (credentialBearing(raw, token) || credentialBearing(url.href, token) || credentialBearing(url.hostname.toLowerCase(), token.toLowerCase()))) return;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (url.hostname === 'kagi.com' && /^\/(?:settings|signin|welcome|login)/.test(url.pathname)) return;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return; }
}

function parseNextUrl(root: ReturnType<typeof parse>, query: string): { nextUrl?: string; rejected: boolean } {
  const links = root.querySelectorAll(NEXT_SELECTOR).filter(link => cleanText(link.textContent) === 'More Results');
  if (links.length === 0) return { rejected: false };
  if (links.length !== 1) return { rejected: true };
  const raw = links[0].getAttribute('href');
  try {
    const next = new URL(raw || '', ORIGIN);
    const keys = [...next.searchParams.keys()];
    const batch = next.searchParams.getAll('batch');
    const queries = next.searchParams.getAll('q');
    const allowedKeys = keys.every(key => key === 'q' || key === 'batch');
    const validBatch = batch.length === 1 && /^[1-9]\d*$/.test(batch[0]) && Number.isSafeInteger(Number(batch[0]));
    if (!raw || next.origin !== ORIGIN || next.username || next.password || next.pathname !== '/html/search' || next.hash || !allowedKeys || queries.length !== 1 || queries[0] !== query || !validBatch) return { rejected: true };
    return { nextUrl: next.href, rejected: false };
  } catch { return { rejected: true }; }
}

export function parsePage(html: string, query: string, token?: string): ParsedPage {
  const root = parse(html, { blockTextElements: { script: true, style: true, noscript: true } });
  // Page titles contain the query, so only verified structural markers classify
  // auth/challenge incidents. Unknown title-only pages still fail closed as markup.
  if (root.querySelector('#challenge-form, .g-recaptcha, .h-captcha, #cf-challenge-running')) throw new KagiError('challenge');
  if (root.querySelector('input[type="password"], form[action="/signin"], form[action="/login"]')) throw new KagiError('auth');
  root.querySelectorAll('script, style, noscript, template, svg').forEach(node => node.remove());

  const links = root.querySelectorAll(RESULT_SELECTOR);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  for (const link of links) {
    if (results.length >= MAX_RESULTS_PER_PAGE) break;
    const url = cleanUrl(link.getAttribute('href'), token);
    const resultTitle = cleanText(link.textContent, token);
    if (!url || !resultTitle || Buffer.byteLength(resultTitle) > MAX_TITLE_BYTES) {
      rejectedCount++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const container = link.closest('.__srgi') || link.closest('.search-result');
    const excerpt = cleanExcerpt(container?.querySelector('.__sri-desc')?.textContent || '', token);
    results.push({ rank: results.length + 1, title: resultTitle, url, snippet: excerpt.text, excerptClipped: excerpt.clipped });
  }

  const emptyMarkers = root.querySelectorAll('.error-content > div').filter(node => cleanText(node.textContent) === EMPTY_TEXT);
  const empty = links.length === 0 && emptyMarkers.length === 1;
  if (results.length === 0 && !empty) throw new KagiError('markup');
  const next = parseNextUrl(root, query);
  return { results, empty, nextUrl: next.nextUrl, nextRejected: next.rejected, rejectedCount };
}

export function parseResults(html: string, limit = 20, token?: string): SearchResult[] {
  return parsePage(html, '', token).results.slice(0, limit).map((result, index) => ({ ...result, rank: index + 1 }));
}
