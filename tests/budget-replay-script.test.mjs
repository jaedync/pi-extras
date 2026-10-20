import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runClockHead } from '../lib/subagents/format.ts';
import { estimatesIn, replay } from '../scripts/budget-replay.mjs';

const START = Date.parse('2026-10-19T23:37:03.000Z');
const at = (minutes) => new Date(START + minutes * 60_000).toISOString();
let id = 0;
const entry = (minutes, message) => ({ type: 'message', id: `e${++id}`, timestamp: at(minutes), message });
const system = (minutes, budget) => entry(minutes, { role: 'system', content: '', sections: { subagent: `## Budget\nThis run may work ${budget} minutes (time counts only while you work).` } });
const user = (minutes, text) => entry(minutes, { role: 'user', content: [{ type: 'text', text }] });
const think = (minutes, thinking, calls = [{ type: 'toolCall', id: `c${id}`, name: 'bash', arguments: {} }]) =>
  entry(minutes, { role: 'assistant', stopReason: calls.length ? 'toolUse' : 'stop', content: [{ type: 'thinking', thinking }, ...calls] });
const result = (minutes, toolCallId = `c${id - 1}`) => entry(minutes, { role: 'toolResult', toolCallId, content: [{ type: 'text', text: 'ok' }] });
const reply = (minutes, text) => entry(minutes, { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });

/** Two runs of a child with a 120-minute budget: the first guesses high and stops early, the second asks and waits. */
function fixture() {
  return [
    { type: 'session', version: 3, id: 's', timestamp: at(0), cwd: '/tmp' },
    system(0, 120),
    user(0, 'Do the task.'),
    think(1, 'Given the 120-minute budget, I will spend 20 minutes reading. Time check: ~22 min used.'),
    result(1.1),
    think(5, 'With about 95 minutes left, I narrow down. Spend 10 minutes on the core.'),
    result(5.1),
    think(8, 'With time running short, I commit to a plan.'),
    result(8.1),
    reply(10, 'Report: done.'),
    system(30, 120),
    user(30, 'Message from main:\nRound 2.'),
    // Asking main: the budget pauses until the answer comes.
    think(31, 'I ask main first.', [{ type: 'toolCall', id: 'ask', name: 'message', arguments: { to: 'main', text: 'Which?', expectReply: true } }]),
    result(41, 'ask'),
    think(43, 'I have used about 3 minutes of 120 so far, with 117 minutes left.'),
    result(43.2),
    reply(45, 'Report: round 2.'),
  ];
}

test('estimatesIn finds used, left and short claims, one per sentence, and skips plans and budgets', () => {
  const found = (text) => estimatesIn(text).map(({ kind, minutes }) => [kind, minutes]);
  assert.deepEqual(found('Time check: ~22 min used. Time is tight: ~26 min elapsed'), [['used', 22], ['used', 26]]);
  assert.deepEqual(found('With about 95 minutes left, I narrow down. Spend 10 minutes on it.'), [['left', 95]]);
  assert.deepEqual(found('I need to focus given the time budget—about 10 minutes used of 120'), [['used', 10]]);
  assert.deepEqual(found("Given the 120-min budget (I've used ~15), I need to prioritize"), [['used', 15]]);
  assert.deepEqual(found("Time: ~105 min\nI'm at ~100 min\nI have ~15 min\nGiven time (28 min left)"), [['used', 105], ['used', 100], ['left', 15], ['left', 28]]);
  assert.deepEqual(found('With time running short, I commit. With limited time left, I lock it in. Time is very short (~22 min)'), [['short', undefined], ['short', undefined], ['short', undefined]]);
  assert.deepEqual(found('Used 30 of 120 work minutes; 90 work minutes left.'), [['used', 30]]);
  assert.deepEqual(found('About 1.5 hours left.'), [['left', 90]]);
  for (const plan of ['keeping in mind the 120-minute, $40 budget', 'Time budget: 90 min', '- 20 min: gap table', "I'll need ~8 minutes for gh searches",
    'totaling around 22 minutes', '≤10 min per job', 'spend the next 25 minutes running searches', '~12 min']) {
    assert.deepEqual(found(plan), [], plan);
  }
});

test('replay splits runs, takes the budget from the system prompt, and counts only work time', () => {
  const runs = replay(fixture());
  assert.equal(runs.length, 2);
  const [first, second] = runs;
  assert.equal(first.budget, 120);
  assert.equal(first.start, at(0));
  assert.deepEqual(first.estimates.map((e) => [e.trueMinutes, e.kind, e.estUsed, e.ratio]), [
    [1, 'used', 22, 22], [5, 'left', 25, 5], [8, 'short', undefined, undefined],
  ]);
  assert.equal(first.estimates[2].trueShare, 8 / 120);
  assert.deepEqual(first.end, { trueMinutes: 10, share: 10 / 120, how: 'final reply' });
  // The 10 minutes it waited on main's answer are not work time.
  assert.equal(second.start, at(30));
  assert.deepEqual(second.estimates.map((e) => [e.trueMinutes, e.kind, e.estUsed]), [[3, 'used', 3]]);
  assert.equal(second.estimates[0].ratio, 1);
  assert.deepEqual(second.end, { trueMinutes: 5, share: 5 / 120, how: 'final reply' });
});

test('a wake from an answer or a report continues the run; a swap note does too', () => {
  const log = fixture().slice(0, 10);
  log.push(user(20, 'Answer from main:\nYes.'), think(21, 'About 11 minutes used.'), result(21.1),
    user(21.2, '[Your session moved to current code and settings. Your work so far is above. Continue where you stopped.]'),
    reply(22, 'Done.'));
  const runs = replay(log);
  assert.equal(runs.length, 1);
  // 10 minutes of work before the wait, then 1 more after the answer.
  assert.deepEqual(runs[0].estimates.at(-1).trueMinutes, 11);
  assert.deepEqual(runs[0].end, { trueMinutes: 12, share: 12 / 120, how: 'final reply' });
});

test('--budget overrides the system prompt, and a run with its clock head starts a new run', () => {
  const log = fixture().slice(0, 10);
  log.push(user(20, 'Message from main:\nGo on.'), think(21, '5 minutes used.'), result(21.5), reply(22, 'Done.'));
  assert.equal(replay(log).length, 2, 'a message after a final reply starts a new run');
  assert.equal(replay(log, { budget: 30 })[0].budget, 30);
  // A message can set a run a shorter deadline than its budget: one value for each run, the last one for the rest.
  assert.deepEqual(replay(log, { budget: [120, 90] }).map((run) => run.budget), [120, 90]);
  assert.deepEqual(replay(log, { budget: [60] }).map((run) => run.budget), [60, 60]);
  // The head as the harness writes it, so the script can't drift from it.
  const head = [system(0, 10), user(0, `${runClockHead({ now: START, minutes: 10, notes: true })}\n\nTask.`),
    think(2, '2 minutes used.'), result(2.1), reply(3, 'Waiting.'),
    user(5, 'Message from worker:\nDone.'), think(6, '4 minutes used.'), result(6.1), reply(7, 'Report.')];
  const runs = replay(head);
  assert.equal(runs.length, 1, 'with heads in the log, only a head starts a run');
  assert.equal(replay(head.map((e) => (e.message.role === 'system' ? system(0, 60) : e)))[0].budget, 10, 'the head names the budget');
  assert.equal(runs[0].budget, 10);
  assert.deepEqual(runs[0].estimates.map((e) => e.trueMinutes), [2, 4]);
});

test('the CLI prints each estimate with the true time, its ratio, and the run end against the budget', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'child.jsonl');
  writeFileSync(file, fixture().map((e) => JSON.stringify(e)).join('\n'));
  const out = spawnSync(process.execPath, ['scripts/budget-replay.mjs', file], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /run 1: budget 120 min, started 2026-10-19T23:37:03Z/);
  assert.match(out.stdout, /\n\s+1\.0\s+used 22\s+est 22\.0\s+22\.0x\s+"Time check: ~22 min used\."/);
  assert.match(out.stdout, /\n\s+5\.0\s+left 95\s+est 25\.0\s+5\.0x\s+"With about 95 minutes left, I narrow down\."/);
  assert.match(out.stdout, /\n\s+8\.0\s+short\s+at 7% of budget\s+"With time running short, I commit to a plan\."/);
  assert.match(out.stdout, /end at 10\.0 min of 120 \(8%\): final reply/);
  const json = spawnSync(process.execPath, ['scripts/budget-replay.mjs', file, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(json.stdout).length, 2);
  const split = spawnSync(process.execPath, ['scripts/budget-replay.mjs', file, '--budget', '120,90'], { encoding: 'utf8' });
  assert.match(split.stdout, /run 2: budget 90 min/);
  for (const bad of [[], [file, '--budget', '0'], [file, '--budget', '120,x']]) {
    assert.notEqual(spawnSync(process.execPath, ['scripts/budget-replay.mjs', ...bad], { encoding: 'utf8' }).status, 0, bad.join(' '));
  }
});
