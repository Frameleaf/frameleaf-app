import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';

/** Local ffmpeg only. The service supplies an authorized original and a checked window. */
@Injectable()
export class StudioTranscriptionRepository {
  /**
   * Write `[start, start + duration)` seconds of the first audio stream of `input` as the 16 kHz mono
   * 16-bit PCM WAV Whisper reads. Pictures, subtitles, data and metadata are dropped.
   */
  async extractAudio(
    input: string,
    output: string,
    window: { startSeconds: string; durationSeconds: string },
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
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-ac',
        '1',
        '-ar',
        '16000',
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
}
