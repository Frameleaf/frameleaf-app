import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';

/** Local ffmpeg only. The service supplies an authorized original and a checked window. */
@Injectable()
export class StudioStabiliseRepository {
  /**
   * Decode `[start, start + duration)` seconds of the first video stream of `input` as small 8-bit grey
   * pictures at `rate` frames a second and hand each to `onFrame` in order, without keeping them.
   * Audio, subtitles, data and metadata are never read.
   */
  async readGreyFrames(
    input: string,
    options: { startSeconds: number; durationSeconds: number; rate: number; width: number; height: number },
    signal: AbortSignal,
    onFrame: (frame: Uint8Array) => void,
  ): Promise<number> {
    signal.throwIfAborted();
    const frameBytes = options.width * options.height;
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        options.startSeconds.toFixed(6),
        '-i',
        input,
        '-t',
        options.durationSeconds.toFixed(6),
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        `fps=${options.rate},scale=${options.width}:${options.height}:flags=area,format=gray`,
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let frames = 0;
    const lifetime = superviseMediaProcess(child, { signal, progress: () => {} });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    let pending: Buffer = Buffer.alloc(0);
    let stderr = '';
    let failure: unknown;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) {
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      try {
        while (pending.length >= frameBytes) {
          onFrame(new Uint8Array(pending.subarray(0, frameBytes)));
          pending = pending.subarray(frameBytes);
          frames++;
          // Each decoded frame is progress, so only a stalled decode hits the idle limit.
          lifetime.progress(1);
        }
      } catch (error) {
        failure = error;
        child.kill('SIGTERM');
      }
    });
    const code = await closed;
    if (failure) {
      throw failure;
    }
    if (lifetime.error()) {
      throw lifetime.error();
    }
    signal.throwIfAborted();
    if (code !== 0) {
      throw new Error(`ffmpeg could not read the video (${code}): ${stderr.trim()}`);
    }
    return frames;
  }
}
