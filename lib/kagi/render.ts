/**
 * TUI rows for the Kagi tool. The call line shows what was searched; the result
 * lists titles and hosts, and expands to excerpts plus the status line. Nothing
 * here reaches the model: Pi sends only `content` to the provider, and `details`
 * stays in the transcript for display.
 */
import { Text, type Component } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { SearchResult } from './parser.js';

export const PREVIEW_RESULTS = 5;
const MAX_QUERY_COLUMNS = 160;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

type PaintKey = 'toolTitle' | 'toolOutput' | 'muted' | 'dim' | 'accent' | 'warning' | 'mdLinkUrl';

interface Paint { fg(key: PaintKey, text: string): string; bold(text: string): string }

export interface RenderDetails {
  results?: SearchResult[];
  resultCount?: number;
  retrievedCount?: number;
  requestedCount?: number;
  status?: 'complete' | 'partial';
  cached?: boolean;
  pagesFetched?: number;
  durationMs?: number;
}

export interface RenderResultInput { content?: unknown; details?: unknown }

/** A theme missing a key degrades to plain text instead of breaking the row. */
export function painter(theme: Theme): Paint {
  const safe = (paint: () => string, text: string) => { try { return paint(); } catch { return text; } };
  return {
    fg: (key, text) => safe(() => theme.fg(key, text), text),
    bold: text => safe(() => theme.bold(text), text),
  };
}

function clean(value: unknown, maxColumns = MAX_QUERY_COLUMNS): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > maxColumns ? `${chars.slice(0, maxColumns - 1).join('')}…` : text;
}

function webUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch { return undefined; }
}

/** OSC 8 hyperlink; terminals without support show the plain text. */
export function link(text: string, url: string): string {
  const target = webUrl(clean(url, 2048));
  if (!target) return text;
  return `\x1b]8;;${target.href}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Same shape as Pi's built-in bash footer, so tool rows agree with each other. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export function callLine(name: string, args: unknown, paint: Paint): string {
  const input = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const query = clean(input.query);
  const parts = [paint.fg('toolTitle', paint.bold(name))];
  parts.push(query ? paint.fg('accent', `"${query}"`) : paint.fg('dim', '…'));
  const domain = clean(input.domain, 253);
  if (domain) parts.push(paint.fg('muted', `site:${domain}`));
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) parts.push(paint.fg('muted', `limit ${input.limit}`));
  return parts.join(' ');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text?: unknown } => typeof part === 'object' && part !== null)
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n');
}

function statusLine(details: RenderDetails, results: SearchResult[], paint: Paint): string {
  const shown = details.resultCount ?? results.length;
  const parts = [`${shown} result${shown === 1 ? '' : 's'}`];
  if (typeof details.requestedCount === 'number' && details.requestedCount !== shown) parts.push(`of ${details.requestedCount} requested`);
  if (details.status === 'partial') parts.push('partial');
  if (details.cached) parts.push('cached');
  if (typeof details.pagesFetched === 'number' && details.pagesFetched > 1) parts.push(`${details.pagesFetched} pages`);
  if (typeof details.durationMs === 'number' && Number.isFinite(details.durationMs)) parts.push(`took ${formatDuration(details.durationMs)}`);
  const line = paint.fg('muted', parts.join(' · '));
  return details.status === 'partial' ? line.replace('partial', paint.fg('warning', 'partial')) : line;
}

/** Lines for a result row; `expanded` adds excerpts and the full list. */
export function resultLines(input: RenderResultInput, expanded: boolean, paint: Paint, expandHint: string): string[] {
  const details = (input.details && typeof input.details === 'object' ? input.details : {}) as RenderDetails;
  const results = Array.isArray(details.results) ? details.results.filter(r => r && typeof r === 'object' && typeof r.title === 'string' && typeof r.url === 'string') : undefined;
  if (!results) {
    // Resumed transcripts from before structured details, or an error body.
    const text = textOf(input.content).trimEnd();
    if (!text) return [];
    const lines = text.split('\n');
    const shown = expanded ? lines : lines.slice(0, PREVIEW_RESULTS);
    const out = shown.map(line => paint.fg('toolOutput', line));
    if (lines.length > shown.length) out.push(`${paint.fg('muted', `… (${lines.length - shown.length} more lines, `)}${expandHint}${paint.fg('muted', ')')}`);
    return out;
  }
  const shown = expanded ? results : results.slice(0, PREVIEW_RESULTS);
  const width = String(results.length).length;
  const lines: string[] = [];
  for (const result of shown) {
    const rank = String(result.rank ?? lines.length + 1).padStart(width);
    const title = clean(result.title, 200);
    const site = webUrl(result.url)?.hostname.replace(/^www\./, '') ?? '';
    lines.push(`${paint.fg('dim', `${rank}.`)} ${paint.fg('toolOutput', title)}${site ? `  ${link(paint.fg('mdLinkUrl', site), result.url)}` : ''}`);
    if (expanded) {
      lines.push(`${' '.repeat(width + 2)}${link(paint.fg('dim', clean(result.url, 300)), result.url)}`);
      const snippet = clean(result.snippet, 600);
      if (snippet) lines.push(`${' '.repeat(width + 2)}${paint.fg('muted', snippet)}`);
    }
  }
  const hidden = results.length - shown.length;
  const status = statusLine(details, results, paint);
  if (!expanded && (hidden > 0 || results.some(r => r.snippet))) {
    const more = hidden > 0 ? `${hidden} more, ` : '';
    lines.push(`${status}${paint.fg('muted', ` (${more}`)}${expandHint}${paint.fg('muted', ')')}`);
  } else {
    lines.push(status);
  }
  return lines;
}

export function renderCall(name: string, args: unknown, theme: Theme): Component {
  return new Text(callLine(name, args, painter(theme)), 0, 0);
}

export function renderResult(input: RenderResultInput, expanded: boolean, theme: Theme, expandHint: string): Component {
  const lines = resultLines(input, expanded, painter(theme), expandHint);
  return new Text(lines.length ? `\n${lines.join('\n')}` : '', 0, 0);
}
