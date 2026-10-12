import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import statusPlus from '../extensions/status-plus.ts';

for (const setting of ['PI_OFFLINE', 'STATUS_PLUS_POLL_LIMITS']) {
  test(`${setting} suppresses credential lookups for usage polling`, async () => {
    const old = process.env[setting];
    const offline = process.env.PI_OFFLINE;
    delete process.env.PI_OFFLINE;
    process.env[setting] = setting === 'PI_OFFLINE' ? '1' : '0';
    const handlers = new Map();
    let reads = 0;
    const ctx = {
      mode: 'print', model: { id: 'test', provider: 'opencode-go' },
      modelRegistry: { async getApiKeyForProvider() { reads++; return undefined; } },
      sessionManager: { getBranch: () => [], getSessionDir: () => '/nonexistent-test-session', getSessionFile: () => undefined },
      ui: { setWidget() {}, setStatus() {} },
    };
    statusPlus({ on: (name, handler) => handlers.set(name, handler) });
    try {
      await handlers.get('session_start')({}, ctx);
      // A turn's own request, which forces an OpenCode Go poll when polling is allowed.
      await handlers.get('turn_start')({}, ctx);
      await handlers.get('before_provider_request')({}, ctx);
      assert.equal(reads, 0);
    } finally {
      await handlers.get('session_shutdown')({}, ctx);
      if (old === undefined) delete process.env[setting]; else process.env[setting] = old;
      if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
    }
  });
}

for (const value of ['0', 'false']) {
  test(`PI_OFFLINE=${value} is not offline, as in Pi, so usage polling still runs`, async () => {
    const old = process.env.PI_OFFLINE;
    const poll = process.env.STATUS_PLUS_POLL_LIMITS;
    process.env.PI_OFFLINE = value;
    delete process.env.STATUS_PLUS_POLL_LIMITS;
    const handlers = new Map();
    let reads = 0;
    const ctx = {
      mode: 'print', model: { id: 'test', provider: 'opencode-go' },
      modelRegistry: { async getApiKeyForProvider() { reads++; return undefined; } },
      sessionManager: { getBranch: () => [], getSessionDir: () => '/nonexistent-test-session', getSessionFile: () => undefined },
      ui: { setWidget() {}, setStatus() {} },
    };
    statusPlus({ on: (name, handler) => handlers.set(name, handler) });
    try {
      await handlers.get('session_start')({}, ctx);
      await handlers.get('turn_start')({}, ctx);
      await handlers.get('before_provider_request')({}, ctx);
      assert.ok(reads > 0);
    } finally {
      await handlers.get('session_shutdown')({}, ctx);
      if (old === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = old;
      if (poll === undefined) delete process.env.STATUS_PLUS_POLL_LIMITS; else process.env.STATUS_PLUS_POLL_LIMITS = poll;
      // The poll's claim is shared through the agent directory; the next case must not wait on it.
      // Only an isolated agent directory (npm test sets one) is cleaned.
      if (process.env.PI_CODING_AGENT_DIR) rmSync(join(process.env.PI_CODING_AGENT_DIR, 'status-plus-limits'), { recursive: true, force: true });
    }
  });
}
