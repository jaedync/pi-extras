import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP_LIMIT_MS, stepFailure } from './test-step.mjs';

const serial = process.env.PI_TEST_SERIAL === '1';
const home = mkdtempSync(join(tmpdir(), 'pi-extras-tests-'));
// Keep real account state and tokens outside every test process.
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || tmpdir(),
  PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
  STATUSLINE_TZ: 'America/Chicago', TZ: 'UTC', CI: 'true' };
try {
  // lint:slop first: it takes under a second and names a new slop site before the long suites run.
  for (const command of ['lint:slop', 'test:unit', 'test:kagi']) {
    const args = ['run', command, ...(serial && command === 'test:unit' ? ['--', '--test-concurrency=1'] : [])];
    // Vitest keeps a temp folder of its own module cache in TMPDIR; give it one inside the home that this script removes.
    const stepTmp = command === 'test:kagi' ? join(home, 'kagi-tmp') : env.TMPDIR;
    mkdirSync(stepTmp, { recursive: true });
    const result = spawnSync('npm', args, { env: { ...env, TMPDIR: stepTmp }, stdio: 'inherit', timeout: STEP_LIMIT_MS });
    const failure = stepFailure(command, result, STEP_LIMIT_MS);
    if (failure) {
      console.error(failure);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
