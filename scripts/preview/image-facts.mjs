// Facts about the preview images, shared by the contract test and `npm run preview:check`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const PREVIEW_DIR = '.github/preview';
/** The README image, and the only committed render. */
export const README_IMAGE = { file: 'pi-extras@2x.webp', width: 2560, height: 1280, maxBytes: 300_000 };
/**
 * The social preview upload. It is rendered next to the README image but ignored by git:
 * GitHub only takes PNG, JPEG or GIF there, and the PNGs would dominate the clone size.
 */
export const SOCIAL = { file: 'pi-extras.png', width: 1280, height: 640, maxBytes: 1_000_000 };

/** Width and height from a PNG's IHDR chunk, or undefined when the bytes are not a PNG. */
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG' || bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Width and height from a WebP's first chunk (lossy, lossless or extended), or undefined. */
export function webpSize(bytes) {
  if (bytes.length < 16 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return undefined;
  const chunk = bytes.toString('latin1', 12, 16);
  if (bytes.length < (chunk === 'VP8L' ? 25 : 30)) return undefined;
  switch (chunk) {
    case 'VP8 ': return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    case 'VP8L': {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X': return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    default: return undefined;
  }
}

function imageProblems(dir, spec, sizeOf, kind) {
  const path = resolve(dir, spec.file);
  if (!existsSync(path)) return [`${PREVIEW_DIR}/${spec.file} is missing`];
  const problems = [];
  const size = sizeOf(readFileSync(path));
  if (size?.width !== spec.width || size?.height !== spec.height) {
    problems.push(`${spec.file} is ${size ? `${size.width}x${size.height}` : `not a ${kind}`}, expected ${spec.width}x${spec.height}`);
  }
  if (statSync(path).size > spec.maxBytes) problems.push(`${spec.file} is over its ${spec.maxBytes / 1000} KB budget`);
  return problems;
}

const minor = (version) => version.split('.').slice(0, 2).join('.');

/** Every problem with the committed preview, as readable strings; empty when it is current. */
export function previewProblems(root) {
  const dir = resolve(root, PREVIEW_DIR);
  const problems = imageProblems(dir, README_IMAGE, webpSize, 'WebP');
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const metaPath = resolve(dir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined;
  if (!meta) problems.push(`${PREVIEW_DIR}/meta.json is missing`);
  else if (minor(meta.version) !== minor(version)) {
    problems.push(`the preview was rendered for ${meta.version}; a ${minor(version)} release needs a fresh one (npm run preview:render)`);
  }
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  if (!readme.includes(`${PREVIEW_DIR}/${README_IMAGE.file}`)) problems.push(`README.md does not show ${PREVIEW_DIR}/${README_IMAGE.file}`);
  return problems;
}

/** Problems with the rendered social preview upload, which only exists after a render. */
export function socialProblems(dir) {
  return imageProblems(dir, SOCIAL, pngSize, 'PNG');
}
