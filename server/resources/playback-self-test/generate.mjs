#!/usr/bin/env node
// FL-977: makes the reference clips of the video playback self-test and their manifest.
//
//   node server/resources/playback-self-test/generate.mjs
//
// Every clip is drawn by ffmpeg itself (the static `smptehdbars` test pattern), so nothing here comes
// from a camera or a third party. Each is 256×144, one second at 25 frames a second, and without sound.
// The HDR clips carry the same code values as the SDR one, tagged as HLG or PQ: what matters to the
// self-test is how a converter treats the tags, not what the picture shows.
//
// Dolby Vision 8.4 cannot be authored with stock ffmpeg (there is no way to write RPU metadata from
// scratch). `dolby-vision-8.4` is therefore the HLG clip with a Dolby Vision configuration record
// (`dvcC`: profile 8, base-layer compatibility 4, i.e. HLG) added to its sample entry. Probes and the
// converter see it as Dolby Vision 8.4; it has no per-frame RPU, which a real 8.4 file has and which a
// non-Dolby-Vision player ignores anyway.
//
// Needs ffmpeg and ffprobe with libx264 and libx265 on the PATH. The expected brightness of each clip is
// measured the way the server measures a playback copy (`MediaRepository.inspectPlaybackCopy`): one frame
// at 0.5 s, scaled to 64×36 RGB, as the mean Rec. 709 luma on a 0–255 scale.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const source = 'smptehdbars=size=256x144:rate=25:duration=1';
const run = (binary, arguments_) => execFileSync(binary, arguments_, { maxBuffer: 64 * 1024 * 1024 });
const ffmpeg = (...arguments_) => run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...arguments_]);

const x265 = (parameters) => [
  '-c:v',
  'libx265',
  '-preset',
  'medium',
  '-crf',
  '30',
  '-x265-params',
  `log-level=error:${parameters}`,
];
const tags = (primaries, transfer, matrix) => [
  '-color_primaries',
  primaries,
  '-color_trc',
  transfer,
  '-colorspace',
  matrix,
  '-color_range',
  'tv',
];
const hlg = [
  ...x265('colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited'),
  '-pix_fmt',
  'yuv420p10le',
  ...tags('bt2020', 'arib-std-b67', 'bt2020nc'),
  '-tag:v',
  'hvc1',
];

// The cases in the order the self-test runs them; `ffmpeg` is everything after the input.
const CASES = [
  {
    id: 'sdr-h264',
    file: 'sdr-h264.mp4',
    description: 'SDR H.264, the most common video',
    toneMapped: false,
    ffmpeg: [
      '-c:v',
      'libx264',
      '-preset',
      'veryslow',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-x264-params',
      'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      ...tags('bt709', 'bt709', 'bt709'),
    ],
  },
  {
    id: 'hlg-hevc',
    file: 'hlg-hevc.mov',
    description: 'HLG HEVC in a QuickTime file, as an iPhone records HDR video',
    toneMapped: true,
    ffmpeg: hlg,
  },
  {
    id: 'dolby-vision-8.4',
    file: 'dolby-vision-8.4.mp4',
    description:
      'HLG HEVC with a Dolby Vision 8.4 configuration record (approximation: no RPU, which stock ffmpeg cannot write)',
    toneMapped: true,
    ffmpeg: hlg,
    dolbyVision: { profile: 8, level: 1, compatibility: 4 },
  },
  {
    id: 'hdr10-pq',
    file: 'hdr10-pq.mp4',
    description: 'HDR10: PQ HEVC with mastering display metadata',
    toneMapped: true,
    ffmpeg: [
      ...x265(
        'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:hdr10=1:' +
          'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
      ),
      '-pix_fmt',
      'yuv420p10le',
      ...tags('bt2020', 'smpte2084', 'bt2020nc'),
      '-tag:v',
      'hvc1',
    ],
  },
  {
    id: 'hev1-hevc',
    file: 'hev1-hevc.mp4',
    description: 'SDR HEVC tagged hev1, which Safari and Apple devices refuse to play',
    toneMapped: false,
    ffmpeg: [
      ...x265('colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited'),
      '-pix_fmt',
      'yuv420p',
      ...tags('bt709', 'bt709', 'bt709'),
      '-tag:v',
      'hev1',
    ],
  },
];

// ---------------------------------------------------------------- Dolby Vision configuration record

const readBox = (buffer, offset) => ({
  size: buffer.readUInt32BE(offset),
  type: buffer.toString('latin1', offset + 4, offset + 8),
  offset,
});

const children = (buffer, start, end) => {
  const boxes = [];
  for (let offset = start; offset + 8 <= end;) {
    const box = readBox(buffer, offset);
    if (box.size < 8 || offset + box.size > end) {
      throw new Error(`Unexpected box ${box.type} at ${offset}`);
    }
    boxes.push(box);
    offset += box.size;
  }
  return boxes;
};

const find = (buffer, parent, type) => {
  const box = children(buffer, parent.offset + 8, parent.offset + parent.size).find((child) => child.type === type);
  if (!box) {
    throw new Error(`No ${type} box inside ${parent.type}`);
  }
  return box;
};

// The 24 bytes of a `dvcC` box (ETSI GS CCM 001 / Dolby's ISOBMFF spec), without its header.
const dvcc = ({ profile, level, compatibility }) => {
  const payload = Buffer.alloc(24);
  payload.writeUInt8(1, 0); // dv_version_major
  payload.writeUInt8(0, 1); // dv_version_minor
  // dv_profile (7) | dv_level (6) | rpu_present (1) | el_present (1) | bl_present (1)
  payload.writeUInt16BE((profile << 9) | (level << 3) | (1 << 2) | (0 << 1) | 1, 2);
  payload.writeUInt32BE((compatibility << 28) >>> 0, 4); // dv_bl_signal_compatibility_id (4) + reserved
  return payload;
};

// Adds a `dvcC` box at the end of the first video track's hvc1 sample entry.
const addDolbyVisionRecord = (input, record) => {
  const file = readFileSync(input);
  const top = children(file, 0, file.length);
  const moov = top.find((box) => box.type === 'moov');
  const mdat = top.find((box) => box.type === 'mdat');
  if (!moov || !mdat || moov.offset < mdat.offset) {
    // the chunk offsets would move otherwise
    throw new Error('Expected the moov box after the media data');
  }
  const trak = children(file, moov.offset + 8, moov.offset + moov.size).find((box) => box.type === 'trak');
  const mdia = find(file, trak, 'mdia');
  const minf = find(file, mdia, 'minf');
  const stbl = find(file, minf, 'stbl');
  const stsd = find(file, stbl, 'stsd');
  // stsd is a full box with an entry count; its first entry is the sample entry
  const entry = readBox(file, stsd.offset + 16);
  if (entry.type !== 'hvc1') {
    throw new Error(`Expected an hvc1 sample entry, found ${entry.type}`);
  }
  const box = Buffer.alloc(8);
  box.writeUInt32BE(32, 0);
  box.write('dvcC', 4, 'latin1');
  const insertAt = entry.offset + entry.size;
  const output = Buffer.concat([file.subarray(0, insertAt), box, dvcc(record), file.subarray(insertAt)]);
  for (const ancestor of [moov, trak, mdia, minf, stbl, stsd, entry]) {
    output.writeUInt32BE(ancestor.size + 32, ancestor.offset);
  }
  writeFileSync(input, output);
};

// ---------------------------------------------------------------- measuring

const probe = (input) => {
  const { streams } = JSON.parse(
    run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', input]).toString(),
  );
  const [stream] = streams;
  const sideData = Object.assign({}, ...(stream.side_data_list ?? []));
  return {
    codecName: stream.codec_name,
    codecTag: stream.codec_tag_string,
    pixelFormat: stream.pix_fmt,
    colorPrimaries: stream.color_primaries ?? 'unknown',
    colorTransfer: stream.color_transfer ?? 'unknown',
    colorMatrix: stream.color_space ?? 'unknown',
    ...(sideData.dv_profile !== undefined && {
      dvProfile: sideData.dv_profile,
      dvBlSignalCompatibilityId: sideData.dv_bl_signal_compatibility_id,
    }),
  };
};

// Mean Rec. 709 luma (0–255) of the frame at 0.5 s, as `MediaRepository.inspectPlaybackCopy` measures it.
const meanLuma = (input) => {
  const pixels = run('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-ss',
    '0.5',
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    'scale=64:36:flags=area,format=rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  let sum = 0;
  for (let index = 0; index + 2 < pixels.length; index += 3) {
    sum += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
  }
  return Math.round((sum / (pixels.length / 3)) * 10) / 10;
};

// ---------------------------------------------------------------- the clips

const manifest = {
  description:
    'FL-977 video playback self-test: reference clips made by generate.mjs from ffmpeg test patterns. ' +
    'sourceMeanLuma is the brightness of the clip as stored; a playback copy that keeps its colours (SDR, or ' +
    'HDR with tone mapping off) should measure within lumaTolerance of it. A tone-mapped HDR copy should fall ' +
    'between toneMappedLuma.min and toneMappedLuma.max (not dark, not blown out); a copy made on the graphics ' +
    'card is also compared with the same clip converted on the processor.',
  lumaTolerance: 12,
  referenceTolerance: 20,
  cases: [],
};

for (const item of CASES) {
  const file = path.join(folder, item.file);
  rmSync(file, { force: true });
  ffmpeg('-f', 'lavfi', '-i', source, ...item.ffmpeg, '-an', '-map_metadata', '-1', file);
  if (item.dolbyVision) {
    addDolbyVisionRecord(file, item.dolbyVision);
  }
  const facts = probe(file);
  const bytes = statSync(file).size;
  manifest.cases.push({
    id: item.id,
    file: item.file,
    description: item.description,
    bytes,
    source: facts,
    sourceMeanLuma: meanLuma(file),
    // A tone-mapped copy outside this band is visibly too dark or washed out. The medium test
    // (test/medium/specs/services/playback-self-test.service.spec.ts) checks it with the server's ffmpeg.
    // eslint-disable-next-line unicorn/no-null
    toneMappedLuma: item.toneMapped ? { min: 45, max: 200 } : null,
  });
  console.log(`${item.file}: ${bytes} bytes`, facts);
}

// eslint-disable-next-line unicorn/no-null
writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
