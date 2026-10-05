import assert from 'node:assert/strict';
import test from 'node:test';
import { ogImageUrl, repoSlug, sessionExpiry, sessionFile, sessionNote } from '../scripts/preview/upload.mjs';

test('the repository slug comes from package.json, in either URL form', () => {
  assert.equal(repoSlug({ repository: { url: 'https://github.com/jaedync/pi-extras.git' } }), 'jaedync/pi-extras');
  assert.equal(repoSlug({ repository: 'git+https://github.com/owner/name' }), 'owner/name');
  assert.throws(() => repoSlug({ repository: { url: 'https://gitlab.com/a/b.git' } }), /GitHub repository/);
  assert.throws(() => repoSlug({}), /GitHub repository/);
});

test('the served image is the og:image of the repository page', () => {
  const html = '<meta name="x"><meta property="og:image" content="https://repository-images.githubusercontent.com/1/abc?x=1&amp;y=2" /><meta property="og:image:alt" content="z">';
  assert.equal(ogImageUrl(html), 'https://repository-images.githubusercontent.com/1/abc?x=1&y=2');
  assert.throws(() => ogImageUrl('<html></html>'), /og:image/);
});

test('the browser session lives outside the repository, under the XDG state directory', () => {
  assert.equal(sessionFile({ XDG_STATE_HOME: '/state' }, '/home/u'), '/state/pi-extras/github-session.json');
  assert.equal(sessionFile({}, '/home/u'), '/home/u/.local/state/pi-extras/github-session.json');
  assert.equal(sessionFile({ XDG_STATE_HOME: '  ' }, '/home/u'), '/home/u/.local/state/pi-extras/github-session.json');
});

test('the session expires with its user_session cookie', () => {
  const at = Date.UTC(2026, 9, 18, 23) / 1000;
  assert.deepEqual(sessionExpiry({ cookies: [{ name: '_gh_sess', expires: -1 }, { name: 'user_session', expires: at }] }), new Date(at * 1000));
  assert.equal(sessionExpiry({ cookies: [{ name: '_gh_sess', expires: -1 }] }), undefined);
});

test('the session note warns before the session runs out, and says how to renew it', () => {
  const expiry = new Date(Date.UTC(2026, 9, 18, 23));
  const day = 86_400_000;
  assert.equal(sessionNote(expiry, expiry.getTime() - 10 * day), 'The GitHub session is valid until 2026-10-18.');
  assert.equal(sessionNote(expiry, expiry.getTime() - 2 * day), 'The GitHub session expires on 2026-10-18, in 2 days. Renew it now: npm run preview:upload -- --login');
  assert.equal(sessionNote(expiry, expiry.getTime() + 1), 'The GitHub session expired on 2026-10-18. Run: npm run preview:upload -- --login');
  assert.equal(sessionNote(undefined, 0), 'No saved GitHub session. Run: npm run preview:upload -- --login');
});
