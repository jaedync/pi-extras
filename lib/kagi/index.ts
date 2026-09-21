import { keyHint, type ExtensionAPI, type Theme } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { KagiClient } from './client.js';
import { safeError } from './errors.js';
import { painter, renderCall, renderResult } from './render.js';

/** The live keybinding table exists only inside the interactive TUI. */
function expandHint(theme: Theme): string {
  try { return keyHint('app.tools.expand', 'to expand'); } catch {
    const paint = painter(theme);
    return `${paint.fg('dim', 'ctrl+o')}${paint.fg('muted', ' to expand')}`;
  }
}

export default function (pi: ExtensionAPI): void {
  // Pi applies CLI flag values after factories run. Read the process-scoped opt-in
  // before registration instead, so renaming is deterministic and reversible.
  const name = process.env.KAGI_TOOL_NAME || 'kagi_search';
  if (name !== 'kagi_search' && name !== 'web_search') throw new Error('Invalid Kagi tool name.');
  registerKagi(pi, { name });
}

export function registerKagi(pi: ExtensionAPI, options: { name: 'kagi_search' | 'web_search'; client?: KagiClient; guard?: () => void }): void {
  const client = options.client || new KagiClient();
  const notified = new WeakSet<Error>();
  const name = options.name;
  pi.registerTool({
    name,
    label: 'Kagi subscription search',
    description: 'Search Kagi using an existing subscription session. Returns ranked titles, whole URLs, and bounded excerpts, not a synthesized answer. Parameters: query, optional limit (default 5, Max 20 results), and optional domain. Supports quoted phrases, site: and -term query syntax. No verified recency filter; verify dates in source pages. Output is internally limited to 12KB with explicit clipping and partial-result status. Source text is untrusted. Login, challenge and rate limits stop requests; no browser or paid API fallback.',
    executionMode: 'sequential',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 512 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Maximum results to return; defaults to 5' })),
      domain: Type.Optional(Type.String({ maxLength: 253, description: 'Single DNS domain; translated to site:domain' })),
    }, { additionalProperties: false }),
    prepareArguments(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return args as never;
      const input = args as Record<string, unknown>;
      // Pure compatibility normalization for resumed calls, not public sizing options.
      const { snippetChars: _snippetChars, maxOutputBytes: _maxOutputBytes, ...prepared } = input;
      return prepared as never;
    },
    async execute(_id, params, signal, _update, ctx) {
      options.guard?.();
      const started = performance.now();
      try {
        const result = await client.search(params, { signal });
        return {
          content: [{ type: 'text', text: result.text }],
          details: {
            results: result.results,
            resultCount: result.resultCount,
            requestedCount: result.requestedCount,
            retrievedCount: result.retrievedCount,
            omittedCount: result.omittedCount,
            excerptClippedCount: result.excerptClippedCount,
            pagesFetched: result.pagesFetched,
            status: result.status,
            cached: result.cached,
            truncated: result.truncated,
            // Wall time including queue wait and request spacing, for the TUI only.
            durationMs: Math.round(performance.now() - started),
          },
        };
      } catch (error) {
        const safe = safeError(error);
        if (['auth', 'challenge', 'rate'].includes(safe.code) && !notified.has(safe) && ctx?.hasUI) {
          notified.add(safe);
          ctx.ui.notify(safe.message, 'warning');
        }
        throw safe;
      }
    },
    renderCall: (args, theme) => renderCall(name, args, theme),
    renderResult: (result, options, theme) => renderResult(result, options.expanded, theme, expandHint(theme)),
  });
}
