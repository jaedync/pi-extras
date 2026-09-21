import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathologicalHtml } from './fixtures/pathological.js';
import { parseResults } from '../../lib/kagi/parser.js';

it('documents cooperative timers rather than promising interruptible synchronous parsing', () => {
  const readme = readFileSync('README.md', 'utf8');
  expect(readme).toContain('cooperative I/O deadline');
  expect(readme).toContain('synchronous parsing cannot be interrupted');
  expect(readme).not.toContain('total timeout 20s');
});
it('measures heartbeat starvation on a bounded pathological search/source fixture', async () => {
  expect(Buffer.byteLength(pathologicalHtml)).toBeLessThan(2_000_000);
  let beat = false;
  const timer = setTimeout(() => { beat = true; }, 1);
  const start = performance.now();
  try {
    expect(parseResults(pathologicalHtml, 5)).toHaveLength(1);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThan(1);
    expect(beat).toBe(false); // Timers do not preempt the synchronous parser.
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(beat).toBe(true);
    // Regression budget, not a hard deadline guarantee on other machines/input.
    expect(elapsed).toBeLessThan(5000);
  } finally { clearTimeout(timer); }
}, 15000);
