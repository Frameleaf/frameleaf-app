import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { StudioReverseGeometry, StudioReverseSource } from 'src/utils/studio-reverse-conform.js';

/** Local ffmpeg only. The service supplies authorized paths and a bounded, probed source. */
@Injectable()
export class StudioReverseConformRepository {
  /** Coded dimensions bound decoder memory; MediaRepository's width describes display geometry. */
  probeGeometry(input: string, streamIndex: number): Promise<StudioReverseGeometry> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line import-x/no-named-as-default-member
      ffmpeg.ffprobe(input, ['-protocol_whitelist', 'file,pipe'], (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        const stream = data.streams.find((entry) => entry.index === streamIndex && entry.codec_type === 'video');
        resolve({
          width: Number(stream?.width),
          height: Number(stream?.height),
          sampleAspectRatio: stream?.sample_aspect_ratio,
        });
      });
    });
  }

  reverse(
    input: string,
    output: string,
    source: StudioReverseSource,
    signal: AbortSignal,
    progress: (frames: number) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const command = ffmpeg(input, { niceness: 10 })
        .inputOptions(['-noautorotate', '-protocol_whitelist', 'file,pipe'])
        .outputOptions([
          '-map',
          `0:${source.videoIndex}`,
          '-vf',
          'reverse,setpts=PTS-STARTPTS',
          '-c:v',
          'ffv1',
          '-level',
          '3',
          '-threads',
          '1',
          '-pix_fmt',
          'yuv420p',
          '-color_primaries',
          'bt709',
          '-color_trc',
          'bt709',
          '-colorspace',
          'bt709',
          '-color_range',
          'tv',
          '-fps_mode',
          'passthrough',
          '-map_metadata',
          '-1',
          ...(source.audioIndex === null
            ? ['-an']
            : ['-map', `0:${source.audioIndex}`, '-af', 'areverse,asetpts=PTS-STARTPTS', '-c:a', 'pcm_f32le']),
        ])
        .format('matroska')
        .output(output);
      const abort = () => command.kill('SIGKILL');
      const finish = (error?: Error) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          reject(signal.reason);
        } else if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      command
        .on('start', () => {
          if (signal.aborted) {
            abort();
          }
        })
        .on('progress', ({ frames }: { frames: number }) => progress(Math.min(source.frames, Math.max(0, frames))))
        .on('error', (error: Error) => finish(error))
        .on('end', () => finish())
        .run();
    });
  }
}
