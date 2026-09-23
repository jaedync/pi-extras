import assert from 'node:assert/strict';
import test from 'node:test';
import { pickFrame } from '../scripts/preview/render.mjs';

const frame = (voice) => [
  ' + 89 const TAIL_CELL_MIN = 10;',
  ' ⠴  j1  12s    Run unit tests  npm test',
  ' ⠴  j2  12s    Watch types  npx tsc -p . --watch',
  '─ ⠁ 00:09.7 Think ──── TPS 109.4 ─ TTFT 0.7s ─',
  voice,
].join('\n');

test('the preview frame prefers a chunk mid-decode, then the fullest level meter', () => {
  const quiet = frame('── ● 0:07  ⠶⠆⠀⠀  ◆◇ ──');
  const loud = frame('── ● 0:07  ⣿⣿⣿⣿  ◆◇ ──');
  const decoding = frame('── ● 0:07  ⠶⠆⠀⠀  ◆◈ ──');
  assert.equal(pickFrame([quiet, loud]), loud);
  assert.equal(pickFrame([loud, decoding, quiet]), decoding);
  const later = frame('── ● 0:07  ⠶⠆⠀⠀  ◆◈ ──').replace('◆◈', '◆◆◈');
  assert.equal(pickFrame([decoding, later]), later, 'more of the sentence already transcribed wins');
});

test('a staged session that never showed everything at once is rejected', () => {
  const noJobs = frame('── ● 0:07  ⣿⣿  ◆ ──').replace(/j2/, 'j9');
  const notRecording = frame('────────────────');
  assert.throws(() => pickFrame([noJobs, notRecording]), /re-run the stage/);
});
