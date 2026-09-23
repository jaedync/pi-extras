import assert from 'node:assert/strict';
import test from 'node:test';
import { webpSize } from '../scripts/preview/image-facts.mjs';

const riff = (chunk, data) => {
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), data]);
  const head = Buffer.alloc(8);
  head.write('RIFF');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

test('webpSize reads lossy, lossless and extended WebP headers', () => {
  const lossy = Buffer.alloc(10);
  lossy.set([0x9d, 0x01, 0x2a], 3);
  lossy.writeUInt16LE(2560, 6);
  lossy.writeUInt16LE(1280, 8);
  assert.deepEqual(webpSize(riff('VP8 ', lossy)), { width: 2560, height: 1280 });

  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE((2560 - 1) | ((1280 - 1) << 14), 1);
  assert.deepEqual(webpSize(riff('VP8L', lossless)), { width: 2560, height: 1280 });

  const extended = Buffer.alloc(10);
  extended.writeUIntLE(2560 - 1, 4, 3);
  extended.writeUIntLE(1280 - 1, 7, 3);
  assert.deepEqual(webpSize(riff('VP8X', extended)), { width: 2560, height: 1280 });
});

test('webpSize rejects anything that is not a WebP', () => {
  assert.equal(webpSize(Buffer.from('\x89PNG\r\n\x1a\n0000IHDR')), undefined);
  assert.equal(webpSize(Buffer.alloc(4)), undefined);
});
