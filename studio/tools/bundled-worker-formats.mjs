// FL-105 / FL-408: the container × codec matrix the bundled Studio worker writes, and how.
//
// The Studio engine composites and encodes H.264/AAC through WebCodecs. Every other format is a
// second pass in this container's ffmpeg: H.264 is stream-copied into MOV or MKV, and H.265, VP8,
// VP9, AV1 and ProRes are encoded from the engine's high-bitrate H.264 master. Audio-only exports
// take the master's sound. At admission the worker encodes a real sample into each format and
// advertises only the formats whose file ffprobe reads back as promised (`probeExportMatrix`).
//
// Every format here is 8-bit SDR. FL-107: HEVC Main10 is written only as an HDR10 or HLG master
// from the engine's float route (`bundled-worker-hdr.mjs`), and only for the transfers the same
// admission check wrote and decoded back. 10-bit AV1 and ProRes 422 HQ stay refused.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HDR_MASTER_FORMAT, hdrEvidenceToken, probeHdrMasters } from './bundled-worker-hdr.mjs';

/** Cancellation must join the child before its output directory can be removed. */
export function execFileClosed(file, args, options) {
  return new Promise((resolve, reject) => {
    let result;
    let failure;
    const child = execFile(file, args, { killSignal: 'SIGKILL', ...options }, (error, stdout, stderr) => {
      failure = error;
      result = { stdout, stderr };
    });
    child.once('close', () => {
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error('Media process closed without a result'));
    });
  });
}

/** Server profile tokens (server/src/utils/render-admission.ts). */
export const SIDECAR_PROFILE = 'srt-sidecar-v2';
export const EMBEDDED_PROFILE = 'embedded-text-v2';

/** The engine's own writers, proven by the H.264/AAC conformance render. */
export const ENGINE_VIDEO_WRITER = 'webcodecs-avc';
export const ENGINE_AUDIO_WRITER = 'aac';

const MP4 = {
  container: 'mp4',
  muxer: 'mp4',
  extension: '.mp4',
  textTrack: 'mov_text',
  faststart: true,
};
const MOV = {
  container: 'mov',
  muxer: 'mov',
  extension: '.mov',
  textTrack: 'mov_text',
  faststart: true,
};
const MKV = {
  container: 'mkv',
  muxer: 'matroska',
  extension: '.mkv',
  textTrack: 'subrip',
  faststart: false,
};
const WEBM = {
  container: 'webm',
  muxer: 'webm',
  extension: '.webm',
  textTrack: 'webvtt',
  faststart: false,
};

const H264 = { codec: 'h264', encoders: ['copy'] };
const HEVC = { codec: 'hevc', encoders: ['libx265'] };
const AV1 = { codec: 'av1', encoders: ['libsvtav1', 'libaom-av1'] };
const VP8 = { codec: 'vp8', encoders: ['libvpx'] };
const VP9 = { codec: 'vp9', encoders: ['libvpx-vp9'] };
const PRORES = { codec: 'prores', encoders: ['prores_ks'] };

const video = (box, stream) => ({ kind: 'video', ...box, ...stream });

/**
 * What the bundled worker can write. `encoders` are tried in order; `copy` is the engine's own H.264.
 * Formats the server knows but this worker does not write (10-bit, stills) are absent on purpose.
 */
export const BUNDLED_FORMATS = Object.freeze({
  'mp4-h264': video(MP4, H264),
  'mp4-hevc': video(MP4, HEVC),
  'mp4-av1': video(MP4, AV1),
  'mov-h264': video(MOV, H264),
  'mov-hevc': video(MOV, HEVC),
  'mov-prores-422': video(MOV, PRORES),
  'mkv-h264': video(MKV, H264),
  'mkv-hevc': video(MKV, HEVC),
  'mkv-vp8': video(MKV, VP8),
  'mkv-vp9': video(MKV, VP9),
  'mkv-av1': video(MKV, AV1),
  'webm-vp8': video(WEBM, VP8),
  'webm-vp9': video(WEBM, VP9),
  'webm-av1-sdr': video(WEBM, AV1),
  'audio-mp3': {
    kind: 'audio',
    container: 'mp3',
    muxer: 'mp3',
    extension: '.mp3',
    codec: 'mp3',
    encoders: ['libmp3lame'],
  },
  'audio-aac': {
    kind: 'audio',
    container: 'm4a',
    muxer: 'ipod',
    extension: '.m4a',
    codec: 'aac',
    encoders: ['copy'],
    faststart: true,
  },
  'audio-wav': {
    kind: 'audio',
    container: 'wav',
    muxer: 'wav',
    extension: '.wav',
    codec: 'pcm_s16le',
    encoders: ['pcm_s16le'],
  },
});

/**
 * Formats the server knows that only a 10-bit worker may write; the reason names what to pick instead.
 * `mp4-hevc-main10` is the exception when the export is an HDR10 or HLG master (FL-107).
 */
export const TEN_BIT_FORMATS = Object.freeze({
  'mp4-hevc-main10': 'MP4 · HEVC (8-bit)',
  'webm-av1': 'WebM · AV1 (8-bit)',
  'prores-422-hq': 'ProRes 422',
});

export const bundledFormat = (format) => (Object.hasOwn(BUNDLED_FORMATS, format) ? BUNDLED_FORMATS[format] : null);

/** Opus carries only these rates; anything else is Vorbis in WebM, never resampled. */
export const OPUS_RATES = new Set([8000, 12_000, 16_000, 24_000, 48_000]);

/** Per-quality settings for each software encoder: CRF where the encoder has one, else a bitrate. */
const QUALITY = Object.freeze({
  libx265: { low: 30, medium: 26, high: 22, ultra: 18 },
  'libvpx-vp9': { low: 40, medium: 34, high: 28, ultra: 22 },
  libsvtav1: { low: 42, medium: 35, high: 28, ultra: 22 },
  'libaom-av1': { low: 42, medium: 35, high: 28, ultra: 22 },
  libvpx: {
    low: 2_500_000,
    medium: 5_000_000,
    high: 10_000_000,
    ultra: 20_000_000,
  },
  libmp3lame: { low: '128k', medium: '192k', high: '256k', ultra: '320k' },
});

const videoArgs = (encoder, format, quality) => {
  switch (encoder) {
    case 'copy': {
      return ['-c:v', 'copy'];
    }
    case 'libx265': {
      return [
        '-c:v',
        'libx265',
        '-preset',
        'fast',
        '-crf',
        String(QUALITY.libx265[quality]),
        '-pix_fmt',
        'yuv420p',
        '-x265-params',
        'log-level=error',
        ...(format.container === 'mp4' || format.container === 'mov' ? ['-tag:v', 'hvc1'] : []),
      ];
    }
    case 'libvpx': {
      const bitrate = QUALITY.libvpx[quality];
      return [
        '-c:v',
        'libvpx',
        '-b:v',
        String(bitrate),
        '-crf',
        '10',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-pix_fmt',
        'yuv420p',
      ];
    }
    case 'libvpx-vp9': {
      return [
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '0',
        '-crf',
        String(QUALITY['libvpx-vp9'][quality]),
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-row-mt',
        '1',
        '-pix_fmt',
        'yuv420p',
      ];
    }
    case 'libsvtav1': {
      return ['-c:v', 'libsvtav1', '-preset', '8', '-crf', String(QUALITY.libsvtav1[quality]), '-pix_fmt', 'yuv420p'];
    }
    case 'libaom-av1': {
      return [
        '-c:v',
        'libaom-av1',
        '-b:v',
        '0',
        '-crf',
        String(QUALITY['libaom-av1'][quality]),
        '-cpu-used',
        '6',
        '-row-mt',
        '1',
        '-pix_fmt',
        'yuv420p',
      ];
    }
    case 'prores_ks': {
      // ProRes 422 (profile 2) is always a 10-bit 4:2:2 file; the picture it carries is the 8-bit render.
      return ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'];
    }
    default: {
      throw new Error(`No arguments for encoder ${encoder}`);
    }
  }
};

/** The audio codec a format's file carries for the master's sound, or why it cannot. */
export const audioPlan = (format, master, encoders) => {
  if (!master) return { args: [] };
  // The engine copies an untouched source's sound (PCM from a WAV, say) instead of encoding AAC.
  const aac =
    master.codec_name === 'aac'
      ? { args: ['-c:a', 'copy'], encoder: ENGINE_AUDIO_WRITER }
      : { args: ['-c:a', 'aac', '-b:a', '320k'], encoder: 'aac' };
  if (format.kind === 'audio') {
    if (format.codec === 'aac') return aac;
    return { args: ['-c:a', format.encoders[0]], encoder: format.encoders[0] };
  }
  if (format.codec === 'prores') return { args: ['-c:a', 'pcm_s16le'], encoder: 'pcm_s16le' };
  // MP4 players expect AAC; MOV and MKV carry the master's sound as it is.
  if (format.container === 'mp4') return aac;
  if (format.container !== 'webm')
    return {
      args: ['-c:a', 'copy'],
      encoder: master.codec_name === 'aac' ? ENGINE_AUDIO_WRITER : undefined,
    };
  const rate = Number(master.sample_rate);
  if (OPUS_RATES.has(rate) && encoders.has('libopus'))
    return { args: ['-c:a', 'libopus', '-b:a', '192k'], encoder: 'libopus' };
  if (encoders.has('libvorbis')) return { args: ['-c:a', 'libvorbis', '-q:a', '6'], encoder: 'libvorbis' };
  return {
    refusal: `WebM cannot carry sound sampled at ${rate} Hz here without resampling it. Choose MKV or MP4.`,
  };
};

/**
 * The ffmpeg arguments that turn the engine's master into `output` in `format`.
 * `master` is ffprobe's audio stream of the master (or null), `subtitles` an SRT file to embed.
 */
export const encodeArgs = ({ input, output, format, encoder, quality = 'high', audio, subtitles }) => {
  const args = ['-v', 'error', '-nostdin', '-y', '-i', input];
  if (subtitles) args.push('-f', 'srt', '-i', subtitles);
  if (format.kind === 'audio') {
    args.push('-vn', '-map', '0:a:0', ...audio.args);
    if (format.codec === 'mp3') args.push('-b:a', QUALITY.libmp3lame[quality]);
  } else {
    args.push('-map', '0:v:0', '-map', '0:a?', ...videoArgs(encoder, format, quality), ...audio.args);
    if (subtitles) {
      args.push(
        '-map',
        '1:s:0',
        '-c:s',
        format.textTrack,
        '-metadata:s:s:0',
        'language=und',
        '-disposition:s:0',
        'default',
      );
    }
  }
  args.push('-map_metadata', '-1', '-map_chapters', '-1');
  if (format.faststart) args.push('-movflags', '+faststart');
  args.push('-f', format.muxer, output);
  return args;
};

/** Seconds from a stream's own duration, or Matroska/WebM's `DURATION` tag. */
export const streamSeconds = (stream) => {
  const own = Number(stream?.duration);
  if (Number.isFinite(own) && own > 0) return own;
  const tag = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(stream?.tags?.DURATION ?? stream?.tags?.duration ?? '');
  return tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) : null;
};

/** ffprobe of a file: its streams (with a normalized `duration`) and its container. */
export async function probeMedia(file, ffprobe = 'ffprobe', { signal } = {}) {
  const { stdout } = await execFileClosed(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,channels,sample_rate,duration,pix_fmt,profile:stream_tags=DURATION,language:stream_disposition=default:format=format_name,duration',
      '-of',
      'json',
      file,
    ],
    { signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const streams = (parsed.streams ?? []).map((stream) => {
    const seconds = streamSeconds(stream);
    return seconds === null ? stream : { ...stream, duration: String(seconds) };
  });
  return { streams, format: parsed.format ?? {} };
}

/** ffprobe's container family for each muxer. */
const FAMILIES = {
  mp4: 'mp4',
  mov: 'mov',
  ipod: 'mp4',
  matroska: 'matroska',
  webm: 'webm',
  mp3: 'mp3',
  wav: 'wav',
};

/**
 * Does the file hold what the format promises? Null when it does. `expect` adds what the export
 * asked for: dimensions, audio and an embedded caption track.
 */
export const formatMismatch = (format, probed, expect = {}) => {
  const { streams, format: box } = probed;
  const family = FAMILIES[format.muxer];
  if (
    !String(box?.format_name ?? '')
      .split(',')
      .includes(family)
  ) {
    return `the file is ${box?.format_name ?? 'unreadable'}, not ${format.container}`;
  }
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audios = streams.filter((stream) => stream.codec_type === 'audio');
  const texts = streams.filter((stream) => stream.codec_type === 'subtitle');
  if (format.kind === 'audio') {
    if (videos.length > 0) return 'the sound-only file also holds a picture';
    if (audios.length !== 1 || audios[0].codec_name !== format.codec)
      return `the file is not one ${format.codec} audio stream`;
    if (!(Number(audios[0].duration) > 0)) return 'the sound has no measurable duration';
  } else {
    if (videos.length !== 1 || videos[0].codec_name !== format.codec)
      return `the result is not one ${format.codec} video stream`;
    if (expect.width && (videos[0].width !== expect.width || videos[0].height !== expect.height)) {
      return `the result is ${videos[0].width}×${videos[0].height}, not ${expect.width}×${expect.height}`;
    }
  }
  if (expect.audio !== undefined) {
    if (expect.audio && audios.length !== 1) return 'the result has no audio stream';
    if (!expect.audio && audios.length > 0 && format.kind !== 'audio')
      return 'the result has sound the export did not ask for';
  }
  if (expect.textTrack) {
    if (texts.length !== 1 || texts[0].codec_name !== format.textTrack)
      return `the result has no ${format.textTrack} caption track`;
    if ((texts[0].tags?.language ?? 'und') !== 'und' || texts[0].disposition?.default !== 1)
      return 'the caption track is not the default untagged track';
  } else if (texts.length > 0) {
    return 'the result has a caption track the export did not ask for';
  }
  return null;
};

/** Run ffmpeg, killing it on abort or after `timeoutMs`. */
export async function runFfmpeg(args, { ffmpeg = 'ffmpeg', signal, timeoutMs = 6 * 60 * 60_000 } = {}) {
  await execFileClosed(ffmpeg, args, {
    signal,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Names in `ffmpeg -encoders` / `-muxers` output. */
export const listedNames = (text) =>
  new Set(
    String(text)
      .split('\n')
      .map((line) => /^\s*[A-Z.]{1,6}\s+([\w-]+)\s/.exec(line)?.[1])
      .filter(Boolean),
  );

const SAMPLE_SRT = '1\n00:00:00,100 --> 00:00:00,600\nFrameleaf\n';

/**
 * Encode `master` (the conformance render, H.264/AAC MP4) into every format this container's
 * ffmpeg claims to support, read each result back, and return the evidence for admission: the
 * writers used and the containers, format ids and caption profiles that came back as promised.
 */
export async function probeExportMatrix({
  master,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  sidecar = true,
  hdr = true,
  log = () => {},
  signal,
}) {
  signal?.throwIfAborted();
  const run = async (args) =>
    (
      await execFileClosed(ffmpeg, ['-hide_banner', ...args], {
        signal,
        timeout: 60_000,
      })
    ).stdout;
  const encoders = listedNames(await run(['-encoders']));
  const muxers = listedNames(await run(['-muxers']));
  const masterProbe = await probeMedia(master, ffprobe, { signal });
  const masterAudio = masterProbe.streams.find((stream) => stream.codec_type === 'audio') ?? null;
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-matrix-'));
  const codecs = new Set([ENGINE_VIDEO_WRITER, ENGINE_AUDIO_WRITER]);
  const formats = new Set(['mp4', 'mp4-h264']);
  const writers = {};
  const refused = {};
  try {
    const srt = path.join(folder, 'sample.srt');
    await writeFile(srt, SAMPLE_SRT);
    for (const [id, format] of Object.entries(BUNDLED_FORMATS)) {
      signal?.throwIfAborted();
      const encoder = format.encoders.find((name) => name === 'copy' || encoders.has(name));
      if (!encoder || !muxers.has(format.muxer)) {
        refused[id] = encoder ? `no ${format.muxer} muxer` : `no ${format.encoders.join('/')} encoder`;
        continue;
      }
      const audio = audioPlan(format, masterAudio, encoders);
      if (audio.refusal || (audio.encoder && audio.encoder !== ENGINE_AUDIO_WRITER && !encoders.has(audio.encoder))) {
        refused[id] = audio.refusal ?? `no ${audio.encoder} encoder`;
        continue;
      }
      const output = path.join(folder, `${id}${format.extension}`);
      try {
        await runFfmpeg(
          encodeArgs({
            input: master,
            output,
            format,
            encoder,
            quality: 'low',
            audio,
          }),
          { ffmpeg, signal, timeoutMs: 120_000 },
        );
        const mismatch = formatMismatch(format, await probeMedia(output, ffprobe, { signal }), {
          audio: !!masterAudio,
        });
        if (mismatch) throw new Error(mismatch);
      } catch (error) {
        signal?.throwIfAborted();
        refused[id] = error.message.split('\n')[0];
        continue;
      }
      writers[id] = encoder;
      formats.add(id).add(format.container);
      if (encoder !== 'copy') codecs.add(encoder);
      if (audio.encoder) codecs.add(audio.encoder);
      if (format.kind === 'video' && !codecs.has(format.textTrack) && encoders.has(format.textTrack)) {
        // The container's caption track, muxed from the same SRT the server seals.
        const captioned = path.join(folder, `${id}-captions${format.extension}`);
        try {
          await runFfmpeg(
            encodeArgs({
              input: output,
              output: captioned,
              format,
              encoder: 'copy',
              audio: { args: masterAudio ? ['-c:a', 'copy'] : [] },
              subtitles: srt,
            }),
            { ffmpeg, signal, timeoutMs: 60_000 },
          );
          if (!formatMismatch(format, await probeMedia(captioned, ffprobe, { signal }), { textTrack: true }))
            codecs.add(format.textTrack);
        } catch {
          signal?.throwIfAborted();
          // no caption track in this container
        }
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  signal?.throwIfAborted();
  if (sidecar) formats.add(SIDECAR_PROFILE);
  if (
    [...Object.keys(writers)].some(
      (id) => BUNDLED_FORMATS[id].kind === 'video' && codecs.has(BUNDLED_FORMATS[id].textTrack),
    )
  ) {
    formats.add(EMBEDDED_PROFILE);
  }
  const refusedList = Object.entries(refused).map(([id, why]) => `${id} (${why})`);
  log(
    `Export formats: ${Object.keys(writers).join(', ')}${refusedList.length > 0 ? `; not offered: ${refusedList.join(', ')}` : ''}`,
  );
  // FL-107: HDR10 and HLG masters, proven on this container's own encoder and decoder.
  let colorPrecision = null;
  if (hdr) {
    const filters = listedNames(await run(['-filters']));
    const masters = await probeHdrMasters({ ffmpeg, ffprobe, encoders, filters, log, signal });
    for (const token of masters.formats) formats.add(token);
    for (const codec of masters.codecs) codecs.add(codec);
    for (const transfer of masters.transfers) writers[hdrEvidenceToken(transfer)] = masters.codecs[0];
    for (const [transfer, why] of Object.entries(masters.refused)) refused[hdrEvidenceToken(transfer, HDR_MASTER_FORMAT)] = why;
    colorPrecision = masters.colorPrecision;
  }
  signal?.throwIfAborted();
  return { codecs: [...codecs], formats: [...formats], writers, refused, colorPrecision };
}
