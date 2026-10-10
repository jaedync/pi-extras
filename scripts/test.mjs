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
    // The unit tests can run past 2 minutes on GitHub's macOS runners, so CI gets more room; locally a hang still shows in 2 minutes.
    const timeout = serial ? 600000 : process.env.CI ? 300000 : 120000;
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
