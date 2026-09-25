import assert from 'node:assert/strict';
import test from 'node:test';
import { pickFrame } from '../scripts/preview/render.mjs';

const frame = (voice) => [
  ' + 89 const TAIL_CELL_MIN = 10;',
  ' Run unit tests                          in background ┃',
  ' Watch types                             in background ┃',
  // Pi's spacer above the widgets.
  '',
  ' Run unit tests                                  12.0s ',
  ' Watch types                                     12.0s ',
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
  // Watch types has finished, so the widget above the phase row no longer shows it.
  const noJobs = frame('── ● 0:07  ⣿⣿  ◆ ──').replace(/ Watch types +12\.0s \n/, '');
  const notRecording = frame('────────────────');
  assert.throws(() => pickFrame([noJobs, notRecording]), /re-run the stage/);
});
