import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentRoot } from '../tests/support/pi-runtime.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pi-extras-install-'));
const source = 'git:github.com/jaedync/pi-extras';
const fixture = join(scratch, 'upstream');
const home = join(scratch, 'home');
const agentDir = join(home, '.pi/agent');
const cli = join(agentRoot, 'dist/cli.js');
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(),
  PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${pathToFileURL(fixture).href}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/jaedync/pi-extras',
  GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
};
function run(command, args, cwd = scratch, overrides = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} failed: ${result.error?.code || result.stderr}`);
  return result.stdout.trim();
}
try {
  mkdirSync(fixture); mkdirSync(agentDir, { recursive: true });
  // Git installs include the lockfile; npm tarballs deliberately omit it.
  // Model the supported Git distribution, not an unshipped npm package.
  const tracked = run('git', ['ls-files', '-z'], resolve()).split('\0').filter(Boolean);
  assert.ok(tracked.includes('package-lock.json'));
  for (const file of tracked) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(file), target);
  }
  run('git', ['init', '-b', 'main'], fixture);
  run('git', ['config', 'user.name', 'Package Test'], fixture);
  run('git', ['config', 'user.email', 'test@example.invalid'], fixture);
  run('git', ['add', '.'], fixture);
  run('git', ['commit', '-m', 'test: initial package'], fixture);
  run(process.execPath, [cli, 'install', source]);
  const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
  assert.ok(settings.packages.includes(source));
  const installed = join(agentDir, 'git/github.com/jaedync/pi-extras');
  assert.ok(existsSync(join(installed, 'node_modules/node-html-parser')));
  assert.ok(!existsSync(join(installed, 'node_modules/vitest')), 'Development tools leaked into production install');

  // Import only after isolating the SDK environment; factories run without session events.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args[0]); throw new Error('Network forbidden during offline SDK smoke'); };
  const { DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } = await import(pathToFileURL(join(agentRoot, 'dist/bundle/index.js')).href);
  const loader = new DefaultResourceLoader({ cwd: scratch, agentDir,
    settingsManager: SettingsManager.create(scratch, agentDir),
    noSkills: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  assert.equal(extensions.extensions.length, 7);
  assert.ok(loader.getThemes().themes.some(theme => theme.name === 'quiet'));
  assert.deepEqual(loader.getThemes().diagnostics, []);
  const tools = extensions.extensions.flatMap(ext => [...ext.tools.keys()]);
  assert.ok(tools.includes('kagi_search'));
  assert.ok(tools.includes('usage'));
  assert.ok(!tools.includes('web_search'));
  const errors = [];
  const { session } = await createAgentSession({ cwd: scratch, agentDir, resourceLoader: loader,
    settingsManager: SettingsManager.create(scratch, agentDir), sessionManager: SessionManager.inMemory(scratch) });
  try {
    await session.bindExtensions({ onError: error => errors.push(error) });
    assert.ok(session.agent.state.tools.some(tool => tool.name === 'shell_job_start'));
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 0, 'Offline startup unexpectedly attempted a network request');
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
  console.log('Native Git install, seven-extension loader and session lifecycle passed without credentials.');

  writeFileSync(join(fixture, 'lib/smoke-marker.txt'), 'updated\n');
  run('git', ['add', 'lib/smoke-marker.txt'], fixture);
  run('git', ['commit', '-m', 'test: newer upstream revision'], fixture);
  // Explicit updates are disabled by offline mode too. Only local Git traffic
  // is needed here; the URL rewrite remains active for both checks and updates.
  process.env.PI_OFFLINE = '';
  const { DefaultPackageManager } = await import(pathToFileURL(join(agentRoot, 'dist/core/package-manager.js')).href);
  const manager = new DefaultPackageManager({ cwd: scratch, agentDir, settingsManager: SettingsManager.create(scratch, agentDir) });
  const updates = await manager.checkForAvailableUpdates();
  assert.ok(updates.some(update => update.source === source && update.type === 'git'));
  run(process.execPath, [cli, 'update', '--extensions'], scratch, { PI_OFFLINE: '', PI_SKIP_VERSION_CHECK: '1' });
  assert.equal(readFileSync(join(installed, 'lib/smoke-marker.txt'), 'utf8'), 'updated\n');
  run(process.execPath, [cli, 'remove', source]);
  const removed = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
  assert.ok(!removed.packages?.includes(source));
  console.log('Native Git update and removal passed. No real account settings changed.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
