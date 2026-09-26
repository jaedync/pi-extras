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

test('a staged session whose dictation transcribed nothing is rejected', () => {
  // A flat meter and no chunks: the recorder heard silence instead of the scripted speech.
  const silent = frame('── ● 0:06  ⠶⠶⠶⠶⠶⠶ ──');
  const loading = frame('── ● 0:01  ⠀⠀⠶⠶  ⠹ loading ──');
  assert.throws(() => pickFrame([silent, loading]), /transcribed nothing/);
});

test('the preview frame is taken while the model is still thinking', () => {
  const thinking = frame('── ● 0:07  ⠶⠆⠀⠀  ◆◇ ──');
  // The reply has started: the phase row restarts its clock on Text.
  const replying = frame('── ● 0:07  ⣿⣿⣿⣿  ◆◆ ──').replace('00:09.7 Think', '00:00.0 Text');
  assert.equal(pickFrame([replying, thinking]), thinking);
  assert.throws(() => pickFrame([replying]), /re-run the stage/);
});
