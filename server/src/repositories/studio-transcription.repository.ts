import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';

/** Local ffmpeg only. The services supply an authorized original and a checked window. */
@Injectable()
export class StudioTranscriptionRepository {
  /**
   * Write `[start, start + duration)` seconds of the first audio stream of `input` as the 16 kHz mono
   * 16-bit PCM WAV Whisper reads. Pictures, subtitles, data and metadata are dropped. Clean up voice
   * (FL-637) reads the same window at 48 kHz, the rate its speech model works at.
   */
  async extractAudio(
    input: string,
    output: string,
    window: { startSeconds: string; durationSeconds: string },
    signal: AbortSignal,
    sampleRate: 16_000 | 48_000 = 16_000,
  ): Promise<void> {
    signal.throwIfAborted();
    const extraction = promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        window.startSeconds,
        '-i',
        input,
        '-t',
        window.durationSeconds,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        '-y',
        output,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const closed = new Promise<void>((resolve) => extraction.child.once('close', () => resolve()));
    const lifetime = superviseMediaProcess(extraction.child, { signal });
    try {
      await extraction;
    } catch (error) {
      throw lifetime.error() ?? error;
    } finally {
      // The caller removes staging on rejection; keep ownership until FFmpeg has actually closed.
      await closed;
    }
    if (lifetime.error()) throw lifetime.error();
    signal.throwIfAborted();
  }

  /**
   * FL-639: write `frames` pictures of `[start, start + duration)` seconds of the first video stream of
   * `input`, `fps` a second, scaled to `width` x `height` and upright, as `folder/00001.jpg` onwards.
   * Sound, subtitles, data and metadata are dropped.
   */
  async extractFrames(
    input: string,
    folder: string,
    window: { startSeconds: string; durationSeconds: string },
    options: { fps: number; frames: number; width: number; height: number },
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const extraction = promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        window.startSeconds,
        '-i',
        input,
        '-t',
        window.durationSeconds,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-vf',
        `fps=${options.fps.toFixed(6)},scale=${options.width}:${options.height}:flags=bicubic,setsar=1`,
        '-frames:v',
        String(options.frames),
        '-q:v',
        '3',
        '-f',
        'image2',
        '-y',
        join(folder, '%05d.jpg'),
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const closed = new Promise<void>((resolve) => extraction.child.once('close', () => resolve()));
    const lifetime = superviseMediaProcess(extraction.child, { signal });
    try {
      await extraction;
    } catch (error) {
      throw lifetime.error() ?? error;
    } finally {
      await closed;
    }
    if (lifetime.error()) throw lifetime.error();
    signal.throwIfAborted();
  }
}
