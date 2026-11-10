// Decoder inventory (FL-1354): node verify-decoders.mjs [--dist <server dist>]
//
// Runs inside the built server image and fails when a decoder the format plan relies on is gone, so a
// base-image bump cannot drop a format without anyone noticing. Something that is missing on purpose,
// or not yet built, goes in KNOWN_GAPS with the reason; an entry that is no longer a gap fails the
// run until it is removed.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distFlag = process.argv.indexOf('--dist');
const dist = distFlag === -1 ? '/usr/src/app/server/dist' : process.argv[distFlag + 1];

/** "<group> <name>": why it is absent today. */
const KNOWN_GAPS = {};

const present = new Map(); // "<group> <name>" -> true | reason it is missing
const check = (group, name, ok, why = 'missing') => present.set(`${group} ${name}`, ok ? true : why);
const output = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
};

// libvips loaders, as sharp reports them (sharp names the JPEG 2000 loader "jp2").
const sharp = createRequire(pathToFileURL(join(dist, 'index.js')))('sharp');
for (const [name, key] of Object.entries({
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  heif: 'heif',
  jxl: 'jxl',
  jp2k: 'jp2',
  svg: 'svg',
  magick: 'magick',
  dcraw: 'dcraw',
  // FL-1356: what the djpeg rung writes
  ppm: 'ppm',
})) {
  check('libvips loader', name, sharp.format[key]?.input.file === true);
}

// ImageMagick is built --with-modules: a coder is one shared object, usable only if all its libraries resolve.
const magickRoot = readdirSync('/usr/local/lib').find((entry) => entry.startsWith('ImageMagick-'));
const coderDir =
  magickRoot &&
  join(
    '/usr/local/lib',
    magickRoot,
    readdirSync(join('/usr/local/lib', magickRoot)).find((entry) => entry.startsWith('modules-')) ?? '',
    'coders',
  );
for (const [coder, module] of Object.entries({
  PSD: 'psd',
  TIFF: 'tiff',
  EXR: 'exr',
  BMP: 'bmp',
  TGA: 'tga',
  ICO: 'icon',
  PCX: 'pcx',
  DDS: 'dds',
  DPX: 'dpx',
  CIN: 'cin',
  SGI: 'sgi',
  XCF: 'xcf',
  PICT: 'pict',
  QOI: 'qoi',
  FITS: 'fits',
  PNM: 'pnm',
})) {
  const file = coderDir && join(coderDir, `${module}.so`);
  if (!file || !existsSync(file)) {
    check('ImageMagick coder', coder, false, 'module not built');
    continue;
  }
  const unresolved = output('ldd', [file])
    .split('\n')
    .filter((line) => line.includes('not found'));
  check(
    'ImageMagick coder',
    coder,
    unresolved.length === 0,
    `unresolved: ${unresolved.map((line) => line.trim().split(' ')[0]).join(', ')}`,
  );
}

// FL-1356: the still ladder's other decoders, each run as its own program.
check('still decoder', 'djpeg (libjpeg-turbo 3)', /version 3\./.test(output('djpeg', ['-version'])));
check('still decoder', 'magick', /ImageMagick 7\./.test(output('magick', ['-version'])));
// JxrDecApp has no version flag; run bare it prints its usage, and names itself.
check('still decoder', 'JxrDecApp (jxrlib)', /JPEG XR Decoder Utility/i.test(output('JxrDecApp', [])));

// ffmpeg: second column of -decoders / -demuxers; a demuxer row may name several formats ("mov,mp4,m4a").
const names = (flag) =>
  new Set(
    output('ffmpeg', ['-hide_banner', flag])
      .split('\n')
      .flatMap((line) => (line.trim().split(/\s+/)[1] ?? '').split(',')),
  );
const decoders = names('-decoders');
// AV1 is decoded by libdav1d in this build; either that or the native decoder will do.
check('ffmpeg decoder', 'av1', decoders.has('av1') || decoders.has('libdav1d'));
for (const name of [
  'h264',
  'hevc',
  'vvc',
  'vp8',
  'vp9',
  'prores',
  'prores_raw',
  'apv',
  'dnxhd',
  'cfhd',
  'mjpeg',
  'mpeg2video',
  'mpeg4',
  'wmv3',
  'vc1',
  'dvvideo',
  'jpeg2000',
  'ffv1',
  'theora',
]) {
  check('ffmpeg decoder', name, decoders.has(name));
}
const demuxers = names('-demuxers');
for (const name of ['mov', 'matroska', 'mxf', 'mpegts', 'avi', 'asf', 'flv']) {
  check('ffmpeg demuxer', name, demuxers.has(name));
}

// LibRaw: the version compiled into the library must be the pinned one (sources/libraw.json beside this script).
const pin = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sources/libraw.json'), 'utf8'),
).version;
const library = readdirSync('/usr/local/lib').find((entry) => /^libraw\.so\.\d+\.\d+\.\d+$/.test(entry));
const libraw =
  library &&
  readFileSync(join('/usr/local/lib', library))
    .toString('latin1')
    .match(/\b0\.\d+\.\d+-(?:Release|Snapshot\d*|Devel\d*|Beta\d*|Alpha\d*)/)?.[0];
const series = (version) => version?.match(/^\d+\.\d+/)?.[0];
check(
  'LibRaw',
  `${series(pin)} (pin ${pin})`,
  !!libraw && series(libraw) === series(pin),
  `found ${libraw ?? 'no libraw.so'}`,
);
check(
  'LibRaw',
  'dcraw_emu',
  /libraw(?:_r)?\.so.*=> \/usr\/local\/lib\//.test(output('ldd', ['/usr/local/bin/dcraw_emu'])),
);

const problems = [];
for (const [name, state] of present) {
  if (state !== true && !KNOWN_GAPS[name]) {
    problems.push({ decoder: name, problem: state });
  } else if (state === true && KNOWN_GAPS[name]) {
    problems.push({ decoder: name, problem: 'present now: remove it from KNOWN_GAPS' });
  }
}
for (const name of Object.keys(KNOWN_GAPS).filter((name) => !present.has(name))) {
  problems.push({ decoder: name, problem: 'KNOWN_GAPS names something that is not checked' });
}
const gaps = Object.entries(KNOWN_GAPS).filter(([name]) => present.get(name) !== true);
if (gaps.length > 0) {
  console.log('Known gaps:');
  console.table(gaps.map(([decoder, reason]) => ({ decoder, reason })));
}
if (problems.length > 0) {
  console.table(problems);
}
console.log(
  `Decoder inventory: ${present.size - gaps.length - problems.length} present, ${gaps.length} known gaps, ${problems.length} problems (libvips ${sharp.versions.vips}, LibRaw ${libraw})`,
);
process.exit(problems.length > 0 ? 1 : 0);
