import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseShard, shardFiles, unitTestFiles } from '../scripts/test-files.mjs';
import { fileName } from '../scripts/test-timings-reporter.mjs';

const expected = ['ts', 'mjs', 'mts'].flatMap((ext) => readdirSync('tests').filter((name) => name.endsWith(`.test.${ext}`)).sort()
  .map((name) => `tests/${name}`));

test('the unit list is the files that the tests/*.test.{ts,mjs,mts} globs name, in the same order', () => {
  assert.deepEqual(unitTestFiles(), expected);
  assert.ok(expected.includes('tests/test-shards.test.mjs'));
});

test('the shards of every count cover each unit test file exactly once', () => {
  for (let count = 1; count <= 12; count++) {
    const seen = new Map();
    for (let index = 1; index <= count; index++) {
      for (const file of shardFiles({ index, count })) seen.set(file, (seen.get(file) ?? 0) + 1);
    }
    assert.deepEqual([...seen.keys()].sort(), [...expected].sort(), `${count} shards cover a different set`);
    assert.deepEqual([...seen.values()].filter((n) => n !== 1), [], `${count} shards run a file twice`);
  }
});

test('a timings file that is missing or names old files still covers every file once', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-shards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const timings = join(dir, 'timings.json');
  writeFileSync(timings, JSON.stringify({ version: 1, files: { 'tests/gone.test.ts': 500, [expected[0]]: 90 } }));
  for (const path of [timings, join(dir, 'missing.json')]) {
    const all = [1, 2, 3].flatMap((index) => shardFiles({ index, count: 3 }, { timings: path }));
    assert.deepEqual(all.sort(), [...expected].sort());
  }
});

test('a shard is i/n with 1 <= i <= n, and anything else is refused', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  assert.equal(parseShard(undefined), undefined);
  assert.equal(parseShard(''), undefined);
  for (const bad of ['0/4', '5/4', '1/0', '1', 'a/b', '1/4 ', '-1/4']) assert.throws(() => parseShard(bad), /PI_TEST_SHARD/, bad);
});

// The matrix form that ci.yml uses: `shard: [1, 2, ...]`, excludes `- { os: x, shard: n }` and includes
// `- { os: x, shards: n }` that give each OS (or Pi version) its shard count.
function shardedJobs(workflow) {
  const jobs = workflow.split(/^ {2}(?=[\w-]+:$)/m).slice(1);
  return jobs.filter((job) => /^\s+shard: \[/m.test(job)).map((job) => {
    const name = job.slice(0, job.indexOf(':'));
    const all = /^\s+shard: \[([\d, ]+)\]$/m.exec(job)[1].split(',').map(Number);
    const pairs = (key) => [...job.matchAll(new RegExp(`^\\s+- \\{ (\\w+): ([\\w.-]+), ${key}: (\\d+) \\}$`, 'gm'))]
      .map((m) => ({ key: m[1], value: m[2], n: Number(m[3]) }));
    return { name, job, all, excludes: pairs('shard'), includes: pairs('shards') };
  });
}

test('the CI matrix runs shards 1 to `shards` for each OS, so no shard of the plan is left without a job', () => {
  const jobs = shardedJobs(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.deepEqual(jobs.map((job) => job.name), ['test', 'pi-versions']);
  for (const { name, job, all, excludes, includes } of jobs) {
    assert.ok(includes.length > 0, `${name}: no shard count`);
    for (const { key, value, n } of includes) {
      const left = all.filter((shard) => !excludes.some((ex) => ex.key === key && ex.value === value && ex.n === shard));
      assert.deepEqual(left, Array.from({ length: n }, (_, k) => k + 1), `${name} ${value}`);
    }
    assert.match(job, /PI_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}/, `${name} passes its shard to npm test`);
  }
});

test('the timings reporter names each file by its repository path with forward slashes', () => {
  assert.equal(fileName(join(process.cwd(), 'tests', 'a.test.ts')), 'tests/a.test.ts');
});

test('a sharded test:unit runs only the files of its shard', () => {
  const result = spawnSync(process.execPath, ['scripts/test-unit.mjs', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, PI_TEST_SHARD: '2/3' },
  });
  assert.equal(result.status, 0, result.stderr);
  const files = result.stdout.trim().split('\n').filter((line) => line.startsWith('tests/'));
  assert.deepEqual(files, shardFiles({ index: 2, count: 3 }));
  assert.ok(files.length > 0 && files.length < expected.length);
});
