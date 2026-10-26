---
name: be-ambitious
description: Turn a task into the deeper version a field-leading expert would do, then do it with their raw material, their instruments and a check from outside the model. Covers depth (expert methods), altitude (the goal behind the task) and range (methods from other fields). Use when the user asks to be more ambitious, go deeper, aim higher, think bigger or do it properly, when an open analysis, research, design, investigation or quality task is likely to get a shallow answer, or when the user runs /skill:be-ambitious. Not for small, fully specified edits.
---

<!-- Based on Felix Rieseberg, "How to be more ambitious: A tutorial for humans
with models" (2026-10-13):
https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/ -->

# Be ambitious

Make the task deeper, not bigger. A deeper task uses the material, the
instruments and the checks that the best people in the field use. A bigger task
only gives more of the same output: more pages, more options, more slides.

There are three axes:

- **Depth**: do the task as a field-leading expert does it. Start from raw
  material, use real instruments, aim at a hard target, and get an outside
  check.
- **Altitude**: serve the goal behind the task, so that the next tasks of this
  type become unnecessary.
- **Range**: use methods from fields that the task does not seem to need.

Depth applies to almost every task. Altitude fits when the task is one step
toward an outcome (a sign: people will meet to discuss the result). Range fits
when the result must persuade, ship or survive hostile scrutiny. Skip an axis
that adds nothing, and say so in one line.

For one task taken through all three axes, read `references/examples.md`.

## 1. Reframe the task

Answer each question in a few lines, for this task only. Name real things:
files, datasets, tools, commands, roles. Generic advice is a failure.

Depth:

1. What does a top professional in this field do here that the user does not
   ask for?
2. What is the rawest material that they start from (logs, raw tables, source
   code, primary sources, measurements), instead of the digested material that
   the user gave (a summary, a template, a dashboard, a screenshot)?
3. Which methods and tools do they use? Name the instrument (a database and a
   statistical model, a profiler, a fuzzer, a simulation, a test harness), not
   only its vocabulary. Plan to install and run it.
4. What, other than you or the user, shows that the result is correct? Prefer
   a check that you can run: a test, a benchmark, held-out data, a
   reproduction, a second implementation, a primary source, a measurement.
5. What is the unreasonable target: hard, but possible for a strong expert?
   If the user wants 5 s instead of 10 s, aim for 200 ms.

Altitude:

6. What must happen after this task? Propose one task at that level that makes
   the next tasks of this type unnecessary ("keep the app free of crashes",
   not "fix this crash").
7. What access does that task need (data feeds, logs, machines, permissions)?
   Say which you have and which the user must give.

Range:

8. Describe the task with verbs, not nouns. "A deck" becomes "get busy people
   to believe a cause and to decide in 30 minutes". For each verb, name the
   field whose experts do it best and one method from that field.
9. Add one adversarial field whose work tries to prove the result wrong: a
   short seller, a forensic accountant, a penetration tester, a peer reviewer.

Do not play roles. Take each field's method, not its voice: do the research
that a short seller does, do not write like one.

## 2. Rewrite the task and get approval

Write the new prompt. It says what to make, from which raw material, with
which instruments, to which target, and which outside check decides whether
it is correct. Below it, list the access that is missing.

Show the new prompt and wait for approval before you start, unless the user
told you to go ahead without one. When this skill loads in the middle of a
task, keep the reframe short and ask before you change the scope.

## 3. Do the work at that depth

- Get the raw material yourself. If you cannot reach it, say what is missing
  and ask. Do not fall back to the digested version without saying so.
- Install and run the instruments that you named. A Markdown table is not a
  statistical model. A missing free tool is not a blocker: install it in user
  or project scope.
- Test the beliefs behind the task. Write each assumption down, then try to
  reproduce it from the raw material ("we think churn is an onboarding
  problem": does the data show that?). Report the ones that fail.
- When you are deep in the material, look for something new: a blind spot, an
  earlier signal, a cause that nobody named. Show that it holds on data that
  it was not fitted on.
- When the target seems impossible, keep going. Try a different method before
  you lower the target. If you lower it, give the measurements that forced it.
- Do not grade your own work. Run the outside check from step 1. If no check
  exists, build one (a test, a benchmark, a reproduction script) or get a
  review from a fresh agent that did not do the work.

## 4. Report

- The result, and the outside evidence: the command, its output, the numbers.
- The assumptions that held and the ones that failed.
- What you found that the user did not know.
- What is still not verified, and the access that would close the gap.

## Traps

- Expert vocabulary on top of the same shallow method.
- Bigger instead of deeper: more output, the same depth.
- Role play: prose in a persona instead of the persona's method.
- Self-grading: "I reviewed it and it looks correct" is not evidence.
- A quiet downgrade: a simpler tool or a smaller target with no mention.
