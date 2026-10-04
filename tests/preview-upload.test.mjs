import assert from 'node:assert/strict';
import test from 'node:test';
import { ogImageUrl, repoSlug, sessionFile } from '../scripts/preview/upload.mjs';

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
