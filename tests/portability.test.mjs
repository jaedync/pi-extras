import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function evaluate(expression, overrides = {}) {
  const env = { ...process.env, TZ: 'UTC', ...overrides };
  delete env.STATUSLINE_TZ;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', expression], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('footer defaults to the user timezone, not a fixed region', () => {
  assert.equal(evaluate("import { STATUS_TIME_ZONE } from './lib/status-plus-logic.ts'; console.log(STATUS_TIME_ZONE)"), 'UTC');
});
test('provider authentication respects an isolated agent directory', () => {
  const value = evaluate("import { CODEX_AUTH_FILE } from './lib/provider-limits.ts'; console.log(CODEX_AUTH_FILE)", { PI_CODING_AGENT_DIR: '/tmp/pi-extras-synthetic-agent' });
  assert.equal(value, '/tmp/pi-extras-synthetic-agent/auth.json');
});
