#!/usr/bin/env node
/**
 * Replays a subagent's session log against its time budget: each time
 * estimate the child wrote in its thinking or text ("about 10 minutes used",
 * "95 minutes left", "time is short"), next to the true work time at that
 * reply, and each run's end against its budget. It measures how well a child
 * knows its clock (lib/subagents/budget.ts).
 *
 * Work time follows the budget: a run's clock stops while the child waits
 * after a reply with no tool call (for an answer, its subagents, or a new
 * run) and while a call blocks on an answer (message with expectReply, or
 * subagent with wait). Time in line for a slot is not visible in the log.
 * A reply's time is when the log saved it, which is when it ended.
 *
 *   node scripts/budget-replay.mjs <child-session.jsonl> [--budget <minutes>[,<minutes of run 2>...]] [--json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MINUTE = 60_000;
const QUOTE_CHARS = 110;

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const ABOUT = String.raw`(?:(?:about|around|roughly|approximately|approx\.?|only|just|nearly|almost|over|some|~|≈)\s*)*`;
const UNIT = String.raw`(min(?:ute)?s?|hours?|hrs?|h)\b`;
const WORK = String.raw`(?:work(?:ing)?\s+)?`;

/** Patterns of a claim with a number: which kind, and the groups of the number and its unit. */
const NUMBERED = [
  ['used', String.raw`\b${NUM}\s+of\s+(?:the\s+|my\s+)?\d+(?:\.\d+)?\s*${WORK}${UNIT}\s+(?:are\s+|is\s+)?(?:used|elapsed|gone)`],
  ['used', String.raw`\b${NUM}\s*-?\s*${WORK}${UNIT}\s+(?:of\s+(?:the\s+|my\s+)?\d+(?:\.\d+)?\s*(?:${WORK}${UNIT})?\s*)?(?:(?:are|is|have|has)\s+)?(?:used|elapsed|gone|passed|so far)\b`],
  ['used', String.raw`\bused\s+${ABOUT}${NUM}\s*(?:of\s+\d+(?:\.\d+)?\s*)?${WORK}${UNIT}`],
  ['used', String.raw`\b(?:I've|I have|I'd|I had|already)\s+used\s+${ABOUT}${NUM}()(?!\s*%)`],
  ['used', String.raw`\belapsed\s*:?\s*${ABOUT}${NUM}\s*${UNIT}`],
  ['used', String.raw`\btime(?:\s+check)?\s*:\s*${ABOUT}${NUM}\s*${UNIT}`],
  ['used', String.raw`\b(?:I'm|I am|we're|we are|now)\s+at\s+${ABOUT}${NUM}\s*${UNIT}`],
  ['used', String.raw`\b${NUM}\s*${UNIT}\s+into\s+(?:the|this|my)\s+(?:run|budget|task|work)`],
  ['left', String.raw`\b${NUM}\s*(?:more\s+)?${WORK}${UNIT}\s+(?:are\s+|is\s+)?(?:left|remain(?:s|ing)?|to go)\b`],
  ['left', String.raw`\b(?:I have|I've got|we have)\s+${ABOUT}${NUM}\s*${UNIT}(?!\s+(?:of|for|to)\b)`],
];
const SHORT = [
  String.raw`\btime(?:'s|\s+is)?\s+(?:very\s+|getting\s+|now\s+)?(?:short|tight)\b`,
  String.raw`\btime\s+(?:is\s+)?running\s+(?:short|out|low)\b`,
  String.raw`\brunning\s+(?:out\s+of|low\s+on|short\s+(?:on|of))\s+time\b`,
  String.raw`\bshort\s+on\s+time\b`,
  String.raw`\blimited\s+time\b`,
  String.raw`\b(?:little|not\s+much)\s+time\s+(?:left|remains)\b`,
];
const NUMBERED_RE = NUMBERED.map(([kind, source]) => [kind, new RegExp(source, 'i')]);
const SHORT_RE = SHORT.map((source) => new RegExp(source, 'i'));

/** The head of a run's first prompt (format.ts `runClockHead`); in a log that has them, only a head starts a run. */
const HEAD_RE = /This run started at \d{1,2}:\d{2}(?::\d{2})? UTC\b/;
const HEAD_BUDGET_RE = /time budget of (\d+(?:\.\d+)?) work minutes/;
const SYSTEM_BUDGET_RE = /This run may work (\d+(?:\.\d+)?) minutes/;
/** Prompts that go on with the same run: an answer, a subagent's report, a swap or a fallback model (format.ts, swap.ts, fallback.ts). */
const CONTINUES_RE = [/^Answer from \S+:/, /^\[Your session moved/, /^Your model \S+ failed: /,
  /^\S+ \([^)\n]*\) (?:finished after|failed after|was stopped after|was interrupted|could not resume|reached its)/];
const WRAP_UP_RE = /budget for this run is used up/;

const toMinutes = (value, unit) => (/^h/i.test(unit ?? '') ? value * 60 : value);

/** The sentences of `text` that claim how much time is used or left, one claim per sentence. */
export function estimatesIn(text) {
  const found = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    let best;
    for (const [kind, re] of NUMBERED_RE) {
      const match = re.exec(sentence);
      if (match && (!best || match.index < best.index)) best = { index: match.index, kind, minutes: toMinutes(Number(match[1]), match[2]) };
    }
    if (best) found.push({ kind: best.kind, minutes: best.minutes, quote: sentence });
    else if (SHORT_RE.some((re) => re.test(sentence))) found.push({ kind: 'short', minutes: undefined, quote: sentence });
  }
  return found;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : '');
const callsOf = (message) => (Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'toolCall') : []);
/** A call during which the budget waits: an answer from main or the parent, or a subagent with wait. */
const blocks = (call) => (call.name === 'message' && call.arguments?.expectReply === true) || (call.name === 'subagent' && call.arguments?.wait === true);
const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * The runs in a session's entries, each with its budget, its time estimates
 * against the true work time, and its end. `budget` overrides the budget
 * that the log names: one number, or one for each run (the last one is used
 * for the runs after it).
 */
export function replay(entries, options = {}) {
  const messages = entries.filter((entry) => entry?.type === 'message' && entry.message && entry.timestamp);
  const headed = messages.some((entry) => entry.message.role === 'user' && HEAD_RE.test(textOf(entry.message.content)));
  const runs = [];
  const override = options.budget === undefined ? [] : [options.budget].flat();
  const budgetOf = (index) => override[Math.min(index, override.length - 1)];
  let run;
  let systemBudget;
  let last;
  let idle = false;
  const waiting = new Set();
  for (const entry of messages) {
    const { message } = entry;
    const time = Date.parse(entry.timestamp);
    if (run && last !== undefined && !idle && waiting.size === 0) run.workMs += time - last;
    last = time;
    if (message.role === 'system') {
      const match = SYSTEM_BUDGET_RE.exec(JSON.stringify(message));
      if (match) systemBudget = Number(match[1]);
      continue;
    }
    if (message.role === 'user') {
      const text = textOf(message.content);
      const starts = !run || (headed ? HEAD_RE.test(text) : idle && !CONTINUES_RE.some((re) => re.test(text)));
      if (starts) {
        const head = HEAD_BUDGET_RE.exec(text);
        run = { start: entry.timestamp, budget: budgetOf(runs.length) ?? (head ? Number(head[1]) : systemBudget), workMs: 0, estimates: [], lastMs: 0, how: 'log ends mid-run' };
        runs.push(run);
        waiting.clear();
      }
      if (WRAP_UP_RE.test(text)) run.wrapUp = true;
      idle = false;
      continue;
    }
    if (!run) continue;
    if (message.role === 'toolResult') waiting.delete(message.toolCallId);
    if (message.role !== 'assistant') continue;
    const calls = callsOf(message);
    for (const call of calls) if (blocks(call)) waiting.add(call.id);
    idle = calls.length === 0;
    run.lastMs = run.workMs;
    run.how = idle ? (run.wrapUp ? 'wrap-up report at the budget' : 'final reply') : 'log ends mid-run';
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const text = part?.type === 'thinking' ? part.thinking : part?.type === 'text' ? part.text : undefined;
      if (typeof text !== 'string') continue;
      for (const found of estimatesIn(text)) run.estimates.push({ ...found, source: part.type, trueMinutes: round(run.workMs / MINUTE) });
    }
  }
  return runs.map((entry) => summary(entry));
}

function summary(run) {
  const { budget } = run;
  const estimates = run.estimates.map((found) => {
    const estUsed = found.kind === 'used' ? found.minutes : found.kind === 'left' && budget !== undefined ? round(budget - found.minutes) : undefined;
    const ratio = estUsed !== undefined && found.trueMinutes > 0 ? round(estUsed / found.trueMinutes) : undefined;
    return { trueMinutes: found.trueMinutes, kind: found.kind, claim: found.minutes, estUsed, ratio,
      trueShare: budget ? found.trueMinutes / budget : undefined, source: found.source, quote: found.quote };
  });
  const trueMinutes = round(run.lastMs / MINUTE);
  return { start: run.start, budget, estimates, end: { trueMinutes, share: budget ? trueMinutes / budget : undefined, how: run.how } };
}

const pct = (share) => `${Math.round(share * 100)}%`;
const fixed = (value) => value.toFixed(1);
const shortQuote = (text) => JSON.stringify(text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text);

export function formatReplay(runs) {
  const lines = [];
  runs.forEach((run, index) => {
    const budget = run.budget === undefined ? 'unknown' : `${run.budget} min`;
    lines.push(`run ${index + 1}: budget ${budget}, started ${run.start.replace(/\.\d+Z$/, 'Z')}`);
    lines.push('   true  claim         estimate   ratio  quote');
    for (const e of run.estimates) {
      const claim = e.kind === 'short' ? 'short' : `${e.kind} ${e.claim}`;
      const estimate = e.kind === 'short' ? (e.trueShare === undefined ? '' : `at ${pct(e.trueShare)} of budget`) : e.estUsed === undefined ? '' : `est ${fixed(e.estUsed)}`;
      const ratio = e.ratio === undefined ? '' : `${fixed(e.ratio)}x`;
      lines.push(`  ${fixed(e.trueMinutes).padStart(5)}  ${claim.padEnd(12)}  ${estimate.padEnd(9)}  ${ratio.padStart(6)}  ${shortQuote(e.quote)}`);
    }
    const ratios = run.estimates.map((e) => e.ratio).filter((r) => r !== undefined).sort((a, b) => a - b);
    if (ratios.length > 0) lines.push(`  estimates: ${ratios.length} with a number, median ratio ${fixed(ratios[Math.floor(ratios.length / 2)])}x, highest ${fixed(ratios.at(-1))}x`);
    const share = run.end.share === undefined ? '' : ` of ${run.budget} (${pct(run.end.share)})`;
    lines.push(`  end at ${fixed(run.end.trueMinutes)} min${share}: ${run.end.how}`, '');
  });
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--budget');
  const budgetAt = args.indexOf('--budget');
  const budget = budgetAt >= 0 ? String(args[budgetAt + 1] ?? '').split(',').map(Number) : undefined;
  if (!file || (budget !== undefined && !budget.every((value) => value > 0))) {
    process.stderr.write('Usage: node scripts/budget-replay.mjs <child-session.jsonl> [--budget <minutes>[,<minutes of run 2>...]] [--json]\n');
    return 2;
  }
  const entries = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const runs = replay(entries, budget === undefined ? {} : { budget });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(runs, null, 2)}\n` : `${formatReplay(runs)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv);
