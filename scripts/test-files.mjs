import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planShards } from '../skills/speed-up-ci/scripts/lib/shards.mjs';

// The one list of unit test files: what the old `tests/*.test.ts tests/*.test.mjs tests/*.test.mts` shell globs named.
// Both a full test:unit and every CI shard read it, so a shard can never miss a file that a full run has.
const EXTENSIONS = ['ts', 'mjs', 'mts'];
export const TIMINGS = '.ci/timings.json';

/** @param {string} [root] */
export function unitTestFiles(root = process.cwd()) {
  const names = readdirSync(join(root, 'tests'));
  // Code-point order, as `ls` in the C locale: the same on every OS and locale.
  return EXTENSIONS.flatMap((ext) => names.filter((name) => name.endsWith(`.test.${ext}`)).sort().map((name) => `tests/${name}`));
}

/** `i/n` from PI_TEST_SHARD, or undefined for a full run. @param {string | undefined} value */
export function parseShard(value) {
  if (value === undefined || value === '') return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`PI_TEST_SHARD must be i/n with 1 <= i <= n, not ${JSON.stringify(value)}`);
  return { index: Number(match[1]), count: Number(match[2]) };
}

/** Recorded seconds for each file, or none: a missing or unreadable file gives a split by count. @param {string} path */
function readTimings(path) {
  if (!existsSync(path)) return {};
  const files = JSON.parse(readFileSync(path, 'utf8')).files;
  return files && typeof files === 'object' ? files : {};
}

/**
 * The files of one shard, packed by the committed timings (longest first onto the lightest shard). Every shard of a
 * run reads the same committed file, so the shards of one commit split the list the same way, also on a re-run.
 * @param {{ index: number, count: number }} shard
 * @param {{ root?: string, timings?: string }} [options]
 */
export function shardFiles(shard, { root = process.cwd(), timings = join(root, TIMINGS) } = {}) {
  return planShards(unitTestFiles(root), readTimings(timings), shard.count)[shard.index - 1].files;
}
