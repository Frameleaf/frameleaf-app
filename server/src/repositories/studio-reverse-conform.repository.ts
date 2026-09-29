import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
        '-map_chapters',
        '-1',
        ...(source.audioIndex === null
          ? ['-an']
          : ['-map', `0:${source.audioIndex}`, '-af', 'areverse,asetpts=PTS-STARTPTS', '-c:a', 'pcm_f32le']),
      ])
      .format('matroska')
      .output(output);
    return this.execute(command, source.frames, signal, progress);
  }

  /** A lossy browser preview only; the FFV1/PCM master is never replaced. */
  preview(
    input: string,
    output: string,
    source: StudioReverseSource,
    signal: AbortSignal,
    progress: (frames: number) => void,
  ): Promise<void> {
    const { num, den } = source.frameRate;
    const command = ffmpeg(input, { niceness: 10 })
      .inputOptions(['-noautorotate', '-protocol_whitelist', 'file,pipe'])
      .outputOptions([
        '-map',
        '0:v:0',
        // Reconstruct the admitted CFR clock after Matroska's millisecond quantisation.
        '-vf',
        `setpts=N*${den}/(${num}*TB)`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-profile:v',
        'main',
        '-level:v',
        '3.2',
        '-bf',
        '0',
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
        '-enc_time_base:v',
        `${den}/${num}`,
        '-video_track_timescale',
        String(num),
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-movflags',
        '+faststart',
        ...(source.audioIndex === null
          ? ['-an']
          : [
              '-map',
              '0:a:0',
              '-af',
              'asetpts=N/SR/TB',
              '-c:a',
              'aac',
              '-profile:a',
              'aac_low',
              '-b:a',
              '192k',
              '-ar',
              String(source.sampleRate),
              '-ac',
              String(source.channels),
            ]),
      ])
      .format('mp4')
      .output(output);
    return this.execute(command, source.frames, signal, progress);
  }

  /** Bounded packet evidence; validation checks every presentation/decode timestamp. */
  async previewPackets(input: string, signal: AbortSignal): Promise<unknown> {
    const { stdout } = await promisify(execFile)(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts,dts,duration',
        '-of',
        'json',
        input,
      ],
      { signal, timeout: 30_000, maxBuffer: 256 * 1024 },
    );
    return JSON.parse(stdout).packets;
  }

  private execute(
    command: ffmpeg.FfmpegCommand,
    frames: number,
    signal: AbortSignal,
    progress: (frames: number) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
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
        .on('progress', ({ frames: completed }: { frames: number }) =>
          progress(Math.min(frames, Math.max(0, completed))),
        )
        .on('error', (error: Error) => finish(error))
        .on('end', () => finish())
        .run();
    });
  }
}
