import { describe, expect, it } from 'vitest';
import { callLine, formatDuration, link, painter, renderCall, renderResult, resultLines } from '../../lib/kagi/render.js';
import { formatOutput } from '../../lib/kagi/output.js';

// A tagging theme makes color placement assertable without ANSI parsing.
const theme = { fg: (key: string, text: string) => `<${key}>${text}</${key}>`, bold: (text: string) => `*${text}*` } as never;
const paint = painter(theme);
const brokenTheme = { fg: () => { throw new Error('no such key'); }, bold: () => { throw new Error('no bold'); } } as never;
const result = (rank: number, title = `Title ${rank}`, snippet = `Snippet ${rank}`) => ({ rank, title, url: `https://www.example${rank}.org/path?x=1`, snippet, excerptClipped: false });
const hint = 'HINT';
const osc = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

describe('call line', () => {
  it('shows the query, domain filter and limit', () => {
    expect(callLine('web_search', { query: 'asyncio TaskGroup', domain: 'docs.python.org', limit: 8 }, paint))
      .toBe('<toolTitle>*web_search*</toolTitle> <accent>"asyncio TaskGroup"</accent> <muted>site:docs.python.org</muted> <muted>limit 8</muted>');
  });
  it('shows a placeholder while arguments stream in and survives bad shapes', () => {
    expect(callLine('web_search', {}, paint)).toBe('<toolTitle>*web_search*</toolTitle> <dim>…</dim>');
    expect(callLine('web_search', 'nope', paint)).toContain('<dim>…</dim>');
    expect(callLine('web_search', { query: 5, limit: 'x' }, paint)).toBe('<toolTitle>*web_search*</toolTitle> <dim>…</dim>');
  });
  it('flattens control characters and truncates long queries', () => {
    const line = callLine('web_search', { query: 'a\x1b[31mb\n\u202ec ' + 'x'.repeat(300) }, paint);
    expect(line).not.toMatch(/[\x00-\x1f\u202e]/);
    expect(line).toContain('a [31mb c ');
    expect(line).toContain('…');
    expect(Array.from(line.slice(line.indexOf('"'), line.lastIndexOf('"'))).length).toBeLessThanOrEqual(161);
  });
  it('falls back to plain text when the theme lacks a key', () => {
    expect(callLine('web_search', { query: 'q' }, painter(brokenTheme))).toBe('web_search "q"');
  });
});

describe('result rows', () => {
  const details = { results: [1, 2, 3, 4, 5, 6, 7].map(n => result(n)), resultCount: 7, requestedCount: 7, retrievedCount: 10, status: 'complete' as const, cached: false, pagesFetched: 1 };
  it('collapses to ranked titles with hosts and a status line carrying the expand hint', () => {
    const lines = resultLines({ content: [], details }, false, paint, hint);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(`<dim>1.</dim> <toolOutput>Title 1</toolOutput>  ${osc('<mdLinkUrl>example1.org</mdLinkUrl>', 'https://www.example1.org/path?x=1')}`);
    expect(lines[5]).toBe('<muted>7 results</muted><muted> (2 more, </muted>HINT<muted>)</muted>');
    expect(lines.join('\n')).not.toContain('Snippet');
  });
  it('expands to every record with url and excerpt', () => {
    const lines = resultLines({ content: [], details }, true, paint, hint);
    expect(lines).toHaveLength(7 * 3 + 1);
    expect(lines[1]).toBe(`   ${osc('<dim>https://www.example1.org/path?x=1</dim>', 'https://www.example1.org/path?x=1')}`);
    expect(lines[2]).toBe('   <muted>Snippet 1</muted>');
    expect(lines.at(-1)).toBe('<muted>7 results</muted>');
  });
  it('reports partial, cached, multi-page and elapsed status', () => {
    const lines = resultLines({ content: [], details: { ...details, results: [result(1)], resultCount: 1, requestedCount: 5, status: 'partial', cached: true, pagesFetched: 2, durationMs: 1840 } }, true, paint, hint);
    expect(lines.at(-1)).toBe('<muted>1 result · of 5 requested · <warning>partial</warning> · cached · 2 pages · took 1.8s</muted>');
    expect(resultLines({ details: { results: [], durationMs: Number.NaN } }, true, paint, hint).at(-1)).toBe('<muted>0 results</muted>');
  });
  it('formats elapsed time in the largest sensible unit', () => {
    expect([0, 912, 45400, 61000, 725000, 3600000, 5432000, Number.NaN].map(formatDuration))
      .toEqual(['0.0s', '0.9s', '45.4s', '1m 1s', '12m 5s', '1h 0m 0s', '1h 30m 32s', '0.0s']);
  });
  it('links only http(s) targets and never leaks control bytes into the link', () => {
    expect(link('t', 'https://e.test/a?b=1')).toBe(osc('t', 'https://e.test/a?b=1'));
    expect(link('t', 'javascript:alert(1)')).toBe('t');
    expect(link('t', 'not a url')).toBe('t');
    expect(link('t', 'https://e.test/\x1b]8;;evil\x07')).not.toContain('evil\x07');
  });
  it('omits the hint when nothing is hidden', () => {
    const lines = resultLines({ content: [], details: { results: [result(1, 'T', '')], resultCount: 1, requestedCount: 1, status: 'complete' } }, false, paint, hint);
    expect(lines).toEqual([`<dim>1.</dim> <toolOutput>T</toolOutput>  ${osc('<mdLinkUrl>example1.org</mdLinkUrl>', 'https://www.example1.org/path?x=1')}`, '<muted>1 result</muted>']);
  });
  it('falls back to a bounded text preview for transcripts without structured details', () => {
    const text = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n');
    const collapsed = resultLines({ content: [{ type: 'text', text }], details: { status: 'complete' } }, false, paint, hint);
    expect(collapsed).toHaveLength(6);
    expect(collapsed[5]).toBe('<muted>… (4 more lines, </muted>HINT<muted>)</muted>');
    expect(resultLines({ content: [{ type: 'text', text }] }, true, paint, hint)).toHaveLength(9);
    expect(resultLines({ content: 'plain' }, false, paint, hint)).toEqual(['<toolOutput>plain</toolOutput>']);
    expect(resultLines({ content: [{ type: 'image' }], details: null }, false, paint, hint)).toEqual([]);
  });
  it('ignores malformed records and unparsable urls', () => {
    const lines = resultLines({ details: { results: [{ rank: 1, title: 'T', url: 'not a url', snippet: 'x' }, null, 'junk', { title: 5 }] } }, false, paint, hint);
    expect(lines[0]).toBe('<dim>1.</dim> <toolOutput>T</toolOutput>');
    expect(lines).toHaveLength(2);
  });
  it('renders the same records the model received', () => {
    const rows = [1, 2, 3].map(n => result(n));
    const formatted = formatOutput(rows, 2, { retrievalComplete: true, pagesFetched: 1, rejectedCount: 0 });
    expect(formatted.results).toEqual(rows.slice(0, 2));
    expect(formatted.text.startsWith('1. Title 1\n')).toBe(true);
    expect(formatted.text.split('\n').at(-1)).toMatch(/untrusted source text/);
  });
});

describe('components', () => {
  it('produce Pi text components with a leading blank line for results', () => {
    const call = renderCall('web_search', { query: 'q' }, theme) as unknown as { render(width: number): string[] };
    expect(call.render(80)[0]).toContain('"q"');
    const body = renderResult({ details: { results: [result(1)] } }, false, theme, hint) as unknown as { render(width: number): string[] };
    const lines = body.render(200);
    expect(lines[0].trim()).toBe('');
    expect(lines[1]).toContain('Title 1');
    expect((renderResult({ content: [] }, false, theme, hint) as unknown as { render(width: number): string[] }).render(80).join('').trim()).toBe('');
  });
});
