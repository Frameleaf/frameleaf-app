// Hosted container gate: node verify-raw.mjs <fixture> <width> <height> [renderer module path].
// Copy this script into the built server image and mount the existing test-assets read-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [fixture, width, height, modulePath = '/usr/src/app/server/dist/utils/raw-renderer.js'] = process.argv.slice(2);
assert.ok(fixture && Number(width) > 0 && Number(height) > 0, 'fixture and qualified sensor dimensions are required');
const moduleUrl = pathToFileURL(modulePath);
const { renderRawWithLibRaw } = await import(moduleUrl.href);
const sharp = createRequire(moduleUrl)('sharp');
const linkage = execFileSync('ldd', ['/usr/local/bin/dcraw_emu'], { encoding: 'utf8' });
assert.match(linkage, /libraw(?:_r)?\.so.*=> \/usr\/local\/lib\//);
assert.doesNotMatch(linkage, /not found/);
const checksum = () => createHash('sha256').update(readFileSync(fixture)).digest('hex');
const before = checksum();
const tiff = await renderRawWithLibRaw(fixture);
const metadata = await sharp(tiff).metadata();
// The production image decodes TIFF through ImageMagick when libvips' TIFF loader is disabled.
// Sharp reports that loader as "magick"; validate the container bytes, not the loader name.
assert.ok(
  ['49492a00', '4d4d002a'].includes(tiff.subarray(0, 4).toString('hex')),
  'sensor rendering must return actual TIFF bytes',
);
assert.equal(metadata.depth, 'ushort', 'sensor rendering must retain 16-bit channels');
assert.equal(metadata.width, Number(width));
assert.equal(metadata.height, Number(height));
assert.ok(metadata.icc?.length, 'sensor rendering must embed its output profile');
// Decode every pixel as well as reading the header; TIFF metadata alone does not prove decodability.
const decoded = await sharp(tiff).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
assert.equal(decoded.info.width, Number(width));
assert.equal(decoded.info.height, Number(height));
assert.equal(checksum(), before, 'sensor rendering must preserve the original checksum');
console.log('RAW sensor roundtrip passed: linkage, dimensions, 16-bit TIFF, ICC, full pixel decode, original checksum');
