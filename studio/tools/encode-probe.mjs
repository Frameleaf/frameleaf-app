import { sourceTimeline, validateSource } from './preflight-validators.mjs';

export function probeSource(ffprobe, ffmpeg, source, run) {
  const raw = run(ffprobe, [
    '-v', 'error', '-select_streams', 'v',
    '-show_frames',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,color_primaries,color_transfer,color_space,time_base:stream_side_data=side_data_type:frame=pts,pix_fmt,color_primaries,color_transfer,color_space:frame_side_data=side_data_type',
    '-of', 'json', source.path,
  ], { rejectStderr: true });
  const { streams, frames } = JSON.parse(raw);
  if (!Array.isArray(streams) || streams.length !== 1) {
    return { name: 'source profile and decode', ok: false, detail: 'source must contain exactly one video stream; multiple video streams are unqualified' };
  }
  const errors = validateSource(streams?.[0], source.transfer, frames);
  if (errors.length) return { name: 'source profile and decode', ok: false, detail: errors.join('; ') };
  const timeline = sourceTimeline(streams[0].time_base, frames);
  run(ffmpeg, ['-v', 'error', '-i', source.path, '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'format=gbrpf32le', '-abort_on', 'empty_output', '-f', 'null', '-'], { rejectStderr: true });
  return {
    name: 'source profile and decode', ok: true,
    timeline,
    detail: 'one frame decoded through float conversion; edited pixels and 10-bit output unqualified',
  };
}
