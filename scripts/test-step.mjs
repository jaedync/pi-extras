// One limit for each step of `npm test`, on every host. It only catches a test file that never exits: each test has
// its own 60-second limit, which names a hang inside a test. A full test:unit took 174 to 314 s on op01, a shared
// agent server, at load 17 to 54 (2026-11-08), and GitHub's macOS runners took over 5 minutes (Node 22, 0.24.18).
// The old local limit of 120 s cut the last files in name order on every loaded run.
export const STEP_LIMIT_MS = 600000;

/** Says why a step of `npm test` did not pass, or returns undefined when it passed. `elapsedMs` is how long it ran. */
export function stepFailure(command, result, limitMs, elapsedMs) {
  const after = `after ${(elapsedMs / 1000).toFixed(1)} s`;
  if (result.error?.code === 'ETIMEDOUT') {
    return `${command} was stopped at the ${limitMs / 1000}-second limit ${after}: the files that still ran are reported as cancelled`;
  }
  if (result.error) return `${command} did not start: ${result.error.message}`;
  if (result.status !== 0) {
    return result.status === null ? `${command} was stopped by ${result.signal} ${after}` : `${command} failed with exit code ${result.status} ${after}`;
  }
  return undefined;
}
