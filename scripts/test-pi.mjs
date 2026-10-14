import { spawnSync } from 'node:child_process';

// Runs typecheck and tests against one Pi release. CI uses it for the minimum and for `latest`; developers use it
// before they raise the minimum. Only a release number or `latest` is allowed, so the argument never reaches npm as
// a path, a URL or a shell word.
const PACKAGES = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'];
const VERSION = /^(latest|\d+\.\d+\.\d+)$/;
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const [version] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

if (!version || !VERSION.test(version)) {
  console.error('Usage: npm run test:pi -- <release number or latest> [--no-restore]');
  process.exit(2);
}

const restore = !flags.has('--no-restore');
const steps = [
  ['npm', 'install', '--no-save', '--ignore-scripts', ...PACKAGES.map((name) => `${name}@${version}`)],
  ['npm', 'run', 'typecheck'],
  ['npm', 'test'],
];
// npm ci puts the locked Pi back, so the next local run does not test a Pi that nobody chose.
const restoreStep = ['npm', 'ci', '--ignore-scripts'];

if (flags.has('--dry-run')) {
  for (const step of [...steps, ...(restore ? [restoreStep] : [])]) console.log(step.join(' '));
  process.exit(0);
}

const run = ([command, ...args]) => spawnSync(command, args, { stdio: 'inherit' }).status ?? 1;
let status = 0;
for (const step of steps) {
  status = run(step);
  if (status !== 0) break;
}
if (restore) {
  const restored = run(restoreStep);
  if (status === 0) status = restored;
}
process.exit(status);
