import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pi-extras-tests-'));
// Keep real account state and tokens outside every test process.
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || tmpdir(),
  PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
  STATUSLINE_TZ: 'America/Chicago', TZ: 'UTC', CI: 'true' };
try {
  for (const command of ['test:unit', 'test:kagi']) {
    const result = spawnSync('npm', ['run', command], { env, stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) {
      console.error(`${command} failed or exceeded the 120-second limit`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
