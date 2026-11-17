import { spawnSync } from 'node:child_process';
import { parseShard, shardFiles, unitTestFiles } from './test-files.mjs';

// `npm run test:unit`: node --test over the unit test files, or over one CI shard of them with PI_TEST_SHARD=i/n.
// PI_TEST_TIMINGS=<file> also writes each file's seconds as JUnit XML, the input of `ci.mjs timings`.
// Other arguments go to node --test (for example --test-concurrency=1).
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const passThrough = args.filter((arg) => arg !== '--dry-run');

let shard;
try {
  shard = parseShard(process.env.PI_TEST_SHARD);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const files = shard ? shardFiles(shard) : unitTestFiles();
const timings = process.env.PI_TEST_TIMINGS;
const reporters = timings
  ? ['--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/test-timings-reporter.mjs', `--test-reporter-destination=${timings}`]
  : [];
const nodeArgs = ['--import', './tests/support/keep-alive.mjs', '--test', '--test-timeout=60000', ...reporters, ...passThrough];

if (shard) console.error(`test:unit shard ${shard.index}/${shard.count}: ${files.length} files`);
if (dryRun) {
  console.log(['node', ...nodeArgs].join(' '));
  for (const file of files) console.log(file);
  process.exit(0);
}
const result = spawnSync(process.execPath, [...nodeArgs, ...files], { stdio: 'inherit' });
if (result.error) console.error(`test:unit did not start: ${result.error.message}`);
process.exit(result.status ?? 1);
