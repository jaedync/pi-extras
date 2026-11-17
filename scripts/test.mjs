import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseShard } from './test-files.mjs';
import { STEP_LIMIT_MS, stepFailure } from './test-step.mjs';
import { runTmpDir, sharedLeakWarning, testTmpPrefixes, tmpLeakFailure } from './tmp-guard.mjs';

const serial = process.env.PI_TEST_SERIAL === '1';
// CI splits test:unit over jobs with PI_TEST_SHARD=i/n (scripts/test-files.mjs). The short steps run once, on shard 1.
const shard = parseShard(process.env.PI_TEST_SHARD);
const commands = shard && shard.index > 1 ? ['test:unit'] : ['lint:slop', 'test:unit', 'test:kagi'];
const sharedBefore = readdirSync(tmpdir());
const home = mkdtempSync(join(tmpdir(), 'pi-extras-tests-'));
const runTmp = runTmpDir();
// Keep real account state and tokens outside every test process.
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: runTmp,
  PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
  STATUSLINE_TZ: 'America/Chicago', TZ: 'UTC', CI: 'true',
  // The bash and shell-jobs tree switch (lib/process-tree.ts treeKillOn), so a run can test it on or off.
  ...(process.env.PI_TREE_KILL === undefined ? {} : { PI_TREE_KILL: process.env.PI_TREE_KILL }),
  ...(shard ? { PI_TEST_SHARD: process.env.PI_TEST_SHARD } : {}),
  // An absolute path: test:unit writes the file after this script has changed HOME and TMPDIR.
  ...(process.env.PI_TEST_TIMINGS ? { PI_TEST_TIMINGS: resolve(process.env.PI_TEST_TIMINGS) } : {}) };
try {
  // lint:slop first: it takes under a second and names a new slop site before the long suites run.
  for (const command of commands) {
    const args = ['run', command, ...(serial && command === 'test:unit' ? ['--', '--test-concurrency=1'] : [])];
    // Vitest keeps a temp folder of its own module cache in TMPDIR; give it one inside the home that this script removes.
    const stepTmp = command === 'test:kagi' ? join(home, 'kagi-tmp') : env.TMPDIR;
    mkdirSync(stepTmp, { recursive: true });
    const started = Date.now();
    const result = spawnSync('npm', args, { env: { ...env, TMPDIR: stepTmp }, stdio: 'inherit', timeout: STEP_LIMIT_MS });
    const failure = stepFailure(command, result, STEP_LIMIT_MS, Date.now() - started);
    if (failure) {
      console.error(failure);
      process.exitCode = 1;
      break;
    }
  }
  checkTmpLeaks();
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(runTmp, { recursive: true, force: true });
}

function checkTmpLeaks() {
  const failure = tmpLeakFailure(runTmp);
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
  }
  const warning = sharedLeakWarning(sharedBefore, readdirSync(tmpdir()), testTmpPrefixes('tests'));
  if (warning) console.error(warning);
}
