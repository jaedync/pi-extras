// Facts about the committed preview image, shared by the contract test and `npm run preview:check`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const PREVIEW_DIR = '.github/preview';
export const SOCIAL = { file: 'pi-extras.png', width: 1280, height: 640, maxBytes: 1_000_000 };
export const RETINA = { file: 'pi-extras@2x.png', width: 2560, height: 1280 };

/** Width and height from a PNG's IHDR chunk, or undefined when the file is not a PNG. */
export function pngSize(path) {
  const head = readFileSync(path).subarray(0, 24);
  if (head.toString('latin1', 1, 4) !== 'PNG' || head.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

const minor = (version) => version.split('.').slice(0, 2).join('.');

/** Every problem with the committed preview, as readable strings; empty when it is current. */
export function previewProblems(root) {
  const problems = [];
  const dir = resolve(root, PREVIEW_DIR);
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  for (const spec of [SOCIAL, RETINA]) {
    const path = resolve(dir, spec.file);
    if (!existsSync(path)) { problems.push(`${PREVIEW_DIR}/${spec.file} is missing`); continue; }
    const size = pngSize(path);
    if (size?.width !== spec.width || size?.height !== spec.height) {
      problems.push(`${spec.file} is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, expected ${spec.width}x${spec.height}`);
    }
    if (spec.maxBytes && statSync(path).size > spec.maxBytes) problems.push(`${spec.file} is over GitHub's 1 MB social preview limit`);
  }
  const metaPath = resolve(dir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined;
  if (!meta) problems.push(`${PREVIEW_DIR}/meta.json is missing`);
  else if (minor(meta.version) !== minor(version)) {
    problems.push(`the preview was rendered for ${meta.version}; a ${minor(version)} release needs a fresh one (npm run preview:render)`);
  }
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  if (!readme.includes(`${PREVIEW_DIR}/${RETINA.file}`)) problems.push(`README.md does not show ${PREVIEW_DIR}/${RETINA.file}`);
  return problems;
}
