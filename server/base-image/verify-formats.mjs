// Format matrix (FL-1354): node verify-formats.mjs <manifest.json> <name>=<dir>... [--dist <server dist>]
// Fixtures whose root is not given a directory are not run, and the summary says so.
//
// Runs inside the built server image. Every fixture in the manifest goes through the decode entry
// points the server itself uses, and the result is compared with what the manifest expects:
//
//   kind     decode entry point                                             rungs
//   still    MediaRepository.decodeImage: the still ladder (FL-1356)        strict | lenient | djpeg | jxrlib |
//                                                                           magick | ffmpeg | embedded
//   design   the same as still (ImageMagick behind libvips today)           as still
//   raw      MediaRepository.renderRaw, the RAW ladder (FL-1355)            libraw | darktable | preview
//   video    MediaRepository.probe, then ffmpeg decodes the first frame     ffmpeg
//   font     libvips text with the font file (no server entry point yet)    specimen
//
// `integrity` is MediaIntegrityService.validate({ deep: true }) said in the product's words:
//   healthy | cut-short (service: corrupt) | unsupported | couldnt-check (transient, timeout)
//
// `matches: "<fixture>"` also compares the decoded picture, shrunk to 8x8, with that fixture's (same root):
// a wrong colour conversion, a dark 12-bit read or a turned picture decodes at the right size and still fails.
//
// A fixture whose fix has not landed carries `expectedFailure: "<why, and which story fixes it>"`.
// with `failsOn`, the keys that differ today. It must fail on exactly those keys: once it passes, or
// fails differently, the run fails until the entry is updated.
// `--actual` prints what the image does with each fixture, as a starting point for new manifest entries.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
const distFlag = args.indexOf('--dist');
const dist = distFlag === -1 ? '/usr/src/app/server/dist' : args.splice(distFlag, 2)[1];
const printActual = args.includes('--actual') && args.splice(args.indexOf('--actual'), 1).length > 0;
const [manifestPath, ...rootArgs] = args;
assert.ok(
  manifestPath && rootArgs.length > 0,
  'usage: verify-formats.mjs <manifest.json> <name>=<dir>... [--dist <dir>]',
);
const roots = Object.fromEntries(rootArgs.map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
// `fate=` with nothing after it (an unset shell variable, say) must not read as a root left off.
assert.ok(Object.values(roots).every(Boolean), 'every <name>=<dir> needs a directory');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const load = (file) => import(pathToFileURL(join(dist, file)).href);
const sharp = createRequire(pathToFileURL(join(dist, 'index.js')))('sharp');
const { AssetType } = await load('enum.js');
const { LoggingRepository } = await load('repositories/logging.repository.js');
const { MediaRepository } = await load('repositories/media.repository.js');
const { StorageRepository } = await load('repositories/storage.repository.js');
const { CryptoRepository } = await load('repositories/crypto.repository.js');
const { MediaIntegrityService } = await load('services/media-integrity.service.js');

const logger = LoggingRepository.create();
const media = new MediaRepository(logger);
const integrity = new MediaIntegrityService(new StorageRepository(logger), new CryptoRepository(), media);
const run = promisify(execFile);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const decoders = {
  async still(file, { matches } = {}) {
    const decode = (path) => media.decodeImage(path, { colorspace: 'srgb', processInvalidImages: false });
    const { data, info, rung } = await decode(file);
    const decoded = { rung, width: info.width, height: info.height };
    if (matches) {
      const small = (pixels) =>
        sharp(pixels.data, {
          raw: { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels },
        })
          .resize(8, 8, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer();
      const [actual, wanted] = await Promise.all([small({ data, info }), decode(matches).then(small)]);
      const difference = actual.reduce((sum, value, index) => sum + Math.abs(value - wanted[index]), 0) / actual.length;
      // A CMYK original read through a generic profile sits about 15 away; inverted or dark is 70 and more.
      decoded.matches = difference < 24 ? true : `no (differs by ${difference.toFixed(1)} of 255)`;
    }
    return decoded;
  },
  async raw(file) {
    // The server's own RAW ladder (MediaRepository.renderRaw). On the libraw rung, the checks
    // verify-raw.mjs makes: LibRaw from /usr/local, real 16-bit TIFF bytes with a profile, every pixel
    // decoded. On the darktable and preview rungs, the picture must decode. The original is never touched.
    const linkage = (await run('ldd', ['/usr/local/bin/dcraw_emu'])).stdout;
    assert.match(linkage, /libraw(?:_r)?\.so.*=> \/usr\/local\/lib\//);
    assert.doesNotMatch(linkage, /not found/);
    const before = sha256(file);
    const { rung, buffer } = await media.renderRaw(file, { threads: availableParallelism() });
    let info;
    if (rung === 'libraw') {
      assert.ok(['49492a00', '4d4d002a'].includes(buffer.subarray(0, 4).toString('hex')), 'not TIFF bytes');
      const metadata = await sharp(buffer).metadata();
      assert.equal(metadata.depth, 'ushort', 'sensor rendering must retain 16-bit channels');
      assert.ok(metadata.icc?.length, 'sensor rendering must embed its output profile');
      ({ info } = await sharp(buffer)
        .toColourspace('rgb16')
        .raw({ depth: 'ushort' })
        .toBuffer({ resolveWithObject: true }));
    } else {
      ({ info } = await media.decodeImage(buffer, { colorspace: 'srgb', processInvalidImages: false }));
    }
    assert.equal(sha256(file), before, 'rendering must preserve the original');
    return { rung, width: info.width, height: info.height };
  },
  async video(file) {
    const [stream] = (await media.probe(file)).videoStreams;
    assert.ok(stream, 'no video stream');
    await run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-map',
      `0:${stream.index}`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    return { rung: 'ffmpeg', width: stream.width, height: stream.height, codec: stream.codecName };
  },
  async font(file) {
    // ponytail: proves libvips can open the font file; swap for the specimen renderer when FL-1359 adds it.
    const { info } = await sharp({ text: { text: 'Aa', fontfile: file, dpi: 144 } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.ok(info.width > 0 && info.height > 0);
    return { rung: 'specimen' };
  },
};
decoders.design = decoders.still;

const verdicts = {
  healthy: 'healthy',
  corrupt: 'cut-short',
  unsupported: 'unsupported',
  transient: 'couldnt-check',
  timeout: 'couldnt-check',
};
const assetTypes = {
  still: AssetType.Image,
  raw: AssetType.Image,
  design: AssetType.Image,
  video: AssetType.Video,
  font: AssetType.Other,
};

const rows = [];
const skipped = new Set();
let failed = 0;
for (const fixture of manifest.fixtures) {
  const { file, root, kind, expectedFailure, failsOn = [], ...expected } = fixture;
  if (!roots[root]) {
    skipped.add(root); // a root left off the command line, e.g. a local run without the FATE downloads
    continue;
  }
  assert.ok(decoders[kind], `${file}: unknown kind "${kind}"`);
  const path = resolve(roots[root], file);
  readFileSync(path); // a missing fixture is a broken run, not a decode result

  let decoded, error;
  try {
    decoded = await decoders[kind](path, { matches: expected.matches && resolve(roots[root], expected.matches) });
  } catch (caught) {
    error = caught;
  }
  const result = await integrity.validate({
    path,
    originalFileName: file.split('/').pop(),
    type: assetTypes[kind],
    deep: true,
  });
  const actual = { decodes: !!decoded, ...decoded, integrity: verdicts[result.status] ?? result.status };

  if (printActual) {
    console.log(
      JSON.stringify({ file, root, kind, ...actual, detail: [result.reason, error?.message.split('\n')[0]] }),
    );
  }
  const mismatches = Object.keys(expected).filter((key) => (key === 'matches' ? true : expected[key]) !== actual[key]);
  const detail = [
    result.status === 'healthy' ? '' : `integrity: ${result.status}/${result.reason}`,
    error ? `decode: ${String(error.message).split('\n')[0]}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  let outcome = mismatches.length === 0 ? 'pass' : 'FAIL';
  if (expectedFailure) {
    // Only the listed keys may differ, so a marker cannot hide a new regression or outlive half a fix.
    const asListed = mismatches.length === failsOn.length && mismatches.every((key) => failsOn.includes(key));
    outcome = asListed ? 'expected failure' : 'FAIL (fails on other keys than failsOn)';
    if (mismatches.length === 0) {
      outcome = 'FAIL (passes now: remove expectedFailure)';
    }
  }
  failed += outcome.startsWith('FAIL') ? 1 : 0;
  rows.push({
    fixture: `${root}:${file}`,
    outcome,
    mismatch: mismatches.map((key) => `${key}: want ${expected[key]}, got ${actual[key]}`).join('; '),
    note: expectedFailure ?? (outcome === 'pass' ? '' : detail),
  });
}

const shown = rows.filter((row) => row.outcome !== 'pass');
if (shown.length > 0) {
  console.table(shown);
}
const count = (prefix) => rows.filter((row) => row.outcome.startsWith(prefix)).length;
if (skipped.size > 0) {
  console.log(`Not run, no directory given for: ${[...skipped].join(', ')}`);
}
console.log(
  `Format matrix: ${count('pass')} passed, ${count('expected')} expected failures, ${failed} failed, of ${rows.length}`,
);
// A misspelt root name selects nothing: that must not pass.
assert.ok(rows.length > 0, 'no fixture was run: check the <name>=<dir> arguments against the manifest roots');
// Exiting also ends the image worker pool.
process.exit(failed ? 1 : 0);
