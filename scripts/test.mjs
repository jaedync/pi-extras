import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serial = process.env.PI_TEST_SERIAL === '1';
const home = mkdtempSync(join(tmpdir(), 'pi-extras-tests-'));
// Keep real account state and tokens outside every test process.
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || tmpdir(),
  PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
  STATUSLINE_TZ: 'America/Chicago', TZ: 'UTC', CI: 'true' };
try {
  for (const command of ['test:unit', 'test:kagi']) {
    const args = ['run', command, ...(serial && command === 'test:unit' ? ['--', '--test-concurrency=1'] : [])];
    // GitHub's macOS runners took from under 3 to over 5 minutes for the same commit (Node 22, 0.24.18), so CI gets
    // 10; each test's own 60-second limit still names a hang. Locally a hang still shows in 2 minutes.
    const timeout = serial || process.env.CI ? 600000 : 120000;
    const result = spawnSync('npm', args, { env, stdio: 'inherit', timeout });
    if (result.error || result.status !== 0) {
      console.error(`${command} failed or exceeded the ${timeout / 1000}-second limit`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
