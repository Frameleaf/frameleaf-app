import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioTranscriptionRepository } from 'src/repositories/studio-transcription.repository.js';

describe('Studio audio extraction process ownership', () => {
  let folder: string;
  const repository = new StudioTranscriptionRepository();
  const window = { startSeconds: '1.25', durationSeconds: '2.5' };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'frameleaf-transcription-process-'));
    const executable = join(folder, 'ffmpeg');
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const output = args.at(-1);
if (input === 'hang') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(output, String(process.pid));
  setInterval(() => {}, 1000);
} else if (input === 'fail') {
  process.stderr.write('controlled extraction failure');
  process.exitCode = 7;
} else {
  fs.writeFileSync(output, JSON.stringify(args));
}
`,
    );
    await chmod(executable, 0o700);
    vi.stubEnv('PATH', `${folder}:${process.env.PATH}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(folder, { recursive: true, force: true });
  });

  it('keeps the checked window and local-only PCM extraction arguments', async () => {
    const output = join(folder, 'audio.wav');
    await repository.extractAudio('source with spaces.mp4', output, window, new AbortController().signal);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual([
      '-v',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      'file,pipe',
      '-ss',
      '1.25',
      '-i',
      'source with spaces.mp4',
      '-t',
      '2.5',
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
    ]);
  });

  it('preserves an extraction failure instead of accepting an unusable output', async () => {
    await expect(
      repository.extractAudio('fail', join(folder, 'audio.wav'), window, new AbortController().signal),
    ).rejects.toThrow('controlled extraction failure');
  });

  it('waits for an unresponsive child to be gone before rejecting cancellation', async () => {
    const output = join(folder, 'audio.wav');
    const abort = new AbortController();
    const reason = new Error('cancelled extraction');
    let pid: number | undefined;
    const outcome = repository.extractAudio('hang', output, window, abort.signal).catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => {
        pid = Number(await readFile(output, 'utf8'));
        expect(pid).toBeGreaterThan(0);
      });
      abort.abort(reason);
      const error = await outcome;
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      expect(error).toBe(reason);
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })));
      }
      await outcome;
    }
  }, 20_000);
});
