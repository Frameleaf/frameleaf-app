import { validateSource } from './preflight-validators.mjs';

export function probeSource(ffprobe, ffmpeg, source, run) {
  const raw = run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,color_primaries,color_transfer,color_space',
    '-of', 'json', source.path,
  ]);
  const errors = validateSource(JSON.parse(raw).streams?.[0], source.transfer);
  if (errors.length) return { name: 'source profile and decode', ok: false, detail: errors.join('; ') };
  run(ffmpeg, ['-v', 'error', '-i', source.path, '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'format=gbrpf32le', '-abort_on', 'empty_output', '-f', 'null', '-']);
  return {
    name: 'source profile and decode', ok: true,
    detail: 'one frame decoded through float conversion; edited pixels and 10-bit output unqualified',
  };
}
