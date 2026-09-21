import test from 'node:test';
import assert from 'node:assert/strict';
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
      await handlers.get('before_provider_request')({}, ctx);
      assert.equal(reads, 0);
    } finally {
      await handlers.get('session_shutdown')({}, ctx);
      if (old === undefined) delete process.env[setting]; else process.env[setting] = old;
      if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
    }
  });
}
