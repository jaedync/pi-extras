import { describe, expect, it, vi, afterEach } from 'vitest';
import extension from '../../lib/kagi/index.js';
vi.mock('../../lib/kagi/client.js', () => ({ KagiClient: class { search = vi.fn(async () => ({ text: 'fixture output', results: [{ rank: 1, title: 'T', url: 'https://e.test/', snippet: 's', excerptClipped: false }], cached: false, resultCount: 1, requestedCount: 1, retrievedCount: 1, omittedCount: 0, excerptClippedCount: 0, pagesFetched: 1, status: 'complete', truncated: false })) } }));
afterEach(() => vi.unstubAllEnvs());
describe('Pi registration', () => {
  it('registers default tool and executes through the client', async () => {
    vi.stubEnv('KAGI_TOOL_NAME', '');
    const pi = { registerTool: vi.fn() };
    extension(pi as never);
    const tool = pi.registerTool.mock.calls[0][0];
    expect(tool.name).toBe('kagi_search');
    expect(await tool.execute('fixture', { query: 'test' })).toEqual({
      content: [{ type: 'text', text: 'fixture output' }],
      details: { results: [{ rank: 1, title: 'T', url: 'https://e.test/', snippet: 's', excerptClipped: false }], resultCount: 1, requestedCount: 1, retrievedCount: 1, omittedCount: 0, excerptClippedCount: 0, pagesFetched: 1, status: 'complete', cached: false, truncated: false, durationMs: expect.any(Number) },
    });
  });
  it('allows an explicitly reversible rename only', () => {
    vi.stubEnv('KAGI_TOOL_NAME', 'web_search');
    const pi = { registerTool: vi.fn() }; extension(pi as never);
    expect(pi.registerTool.mock.calls[0][0].name).toBe('web_search');
    vi.stubEnv('KAGI_TOOL_NAME', 'bash'); expect(() => extension(pi as never)).toThrow('tool name');
  });
  it('registers renderers that show the query and the returned records', () => {
    vi.stubEnv('KAGI_TOOL_NAME', 'web_search');
    const pi = { registerTool: vi.fn() }; extension(pi as never);
    const tool = pi.registerTool.mock.calls[0][0];
    const theme = { fg: (_k: string, t: string) => t, bold: (t: string) => t };
    expect(tool.renderCall({ query: 'hello', limit: 3 }, theme, {}).render(80)[0].trimEnd()).toBe('web_search "hello" limit 3');
    const details = { results: [{ rank: 1, title: 'T', url: 'https://e.test/', snippet: 's', excerptClipped: false }], resultCount: 1, requestedCount: 1, status: 'complete' };
    const lines = tool.renderResult({ content: [{ type: 'text', text: 'ignored' }], details }, { expanded: false, isPartial: false }, theme, {}).render(120);
    // The host is an OSC 8 hyperlink; strip the escape framing to check the visible text.
    expect(lines[1].replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').trimEnd()).toBe('1. T  e.test');
    // Outside the interactive TUI the keybinding table is absent, so the hint falls back.
    expect(lines[2].trimEnd()).toBe('1 result (ctrl+o to expand)');
  });
});

import { registerKagi } from '../../lib/kagi/index.js';
import { KagiError } from '../../lib/kagi/errors.js';
it('notifies only once per credential failure incident and throws safe actionable errors', async () => {
  const failure = new KagiError('auth');
  const search = vi.fn().mockRejectedValue(failure);
  const pi = { registerTool: vi.fn() };
  registerKagi(pi as never, { name: 'web_search', client: { search } as never });
  const tool = pi.registerTool.mock.calls[0][0];
  const ctx = { hasUI: true, ui: { notify: vi.fn() } };
  for (let i = 0; i < 3; i++) await expect(tool.execute('id', { query: 'x' }, undefined, undefined, ctx)).rejects.toThrow('token FILE');
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  search.mockRejectedValue(new KagiError('auth'));
  await expect(tool.execute('id', { query: 'x' }, undefined, undefined, ctx)).rejects.toThrow('never paste it into chat');
  expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
});
