import { relative, sep } from 'node:path';

// A node:test reporter that writes one JUnit <testsuite> for each test file, with the file's own wall time from its
// test:summary event. Node's junit reporter puts test cases with no describe block straight under <testsuites> and
// times only the test bodies, not the file's start and imports, so it cannot time a file. The output is the input of
// `ci.mjs timings`, which packs the CI shards by these seconds.

const escape = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Repository-relative path with forward slashes, so the names match the shard file list on every OS. */
export function fileName(path, root = process.cwd()) {
  return relative(root, path).split(sep).join('/');
}

export default async function* timingsReporter(source) {
  yield '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n';
  for await (const event of source) {
    if (event.type !== 'test:summary' || !event.data.file) continue;
    const name = escape(fileName(event.data.file));
    const seconds = (event.data.duration_ms / 1000).toFixed(3);
    const failed = event.data.success ? 0 : 1;
    yield `\t<testsuite name="${name}" file="${name}" time="${seconds}" failures="${failed}"/>\n`;
  }
  yield '</testsuites>\n';
}
