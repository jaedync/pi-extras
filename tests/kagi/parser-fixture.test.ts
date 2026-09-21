import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseResults } from '../../lib/kagi/parser.js';
it('ranked-adversarial.html strips nested preformatted markup and keeps rank', () => {
  const results = parseResults(readFileSync(new URL('./fixtures/ranked-adversarial.html', import.meta.url), 'utf8'), 10);
  expect(results).toEqual([
    { rank: 1, title: 'Grouped & first', url: 'https://docs.example.test/group', snippet: 'Group text', excerptClipped: false },
    { rank: 2, title: 'Main result', url: 'https://docs.example.test/main', snippet: 'Clean preformatted 😀😀', excerptClipped: false },
  ]);
});
it('does not split a Unicode character at the fixed excerpt boundary', () => {
  const page = `<div class="search-result"><a class="__sri_title_link" href="https://example.test/">A</a><div class="__sri-desc">${'😀'.repeat(601)}</div></div>`;
  const result = parseResults(page, 1)[0];
  expect(Array.from(result.snippet.split('…')[0])).toHaveLength(600);
  expect(result.excerptClipped).toBe(true);
});
