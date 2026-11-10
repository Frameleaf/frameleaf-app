import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPPED, runConverter, stillConverters } from 'src/utils/still-converters.js';

describe('stillConverters (FL-1356)', () => {
  it.each([
    ['old.JPG', ['djpeg', 'ffmpeg']],
    ['old.jfi', ['djpeg', 'ffmpeg']],
    ['stereo.jps', ['djpeg', 'ffmpeg']],
    ['windows.wdp', ['jxrlib', 'ffmpeg']],
    ['scan.cin', ['magick', 'ffmpeg']],
    ['clip.PCT', ['magick', 'ffmpeg']],
    ['photo.png', ['ffmpeg']],
    ['photo.heic', ['ffmpeg']],
  ])('%s is offered to %j, in that order', (filename, rungs) => {
    expect(stillConverters(filename).map(({ rung }) => rung)).toEqual(rungs);
  });

  it('stops a converter whose output outgrows the limit, and lets a small one finish', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-converter-'));
    try {
      const write = (kibibytes: number) =>
        runConverter(
          'dd',
          ['if=/dev/zero', `of=${join(directory, `${kibibytes}.bin`)}`, 'bs=1024', `count=${kibibytes}`],
          undefined,
          64 * 1024,
        );
      await expect(write(16)).resolves.toBeUndefined();
      await expect(write(1024)).rejects.toThrow();
      // a shell counts the limit in 512-byte or 1024-byte blocks, so the cap is at most twice the figure
      expect((await stat(join(directory, '1024.bin'))).size).toBeLessThanOrEqual(2 * 64 * 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lowers the file-size limit to the cap, and leaves a limit that is already lower alone', () => {
    // the wrapper's own script, run under a soft limit set first; the "converter" prints the limit it got
    const limitUnder = (soft: string, cap: string) =>
      execFileSync('sh', ['-c', `ulimit -S -f ${soft}; ${CAPPED}`, cap, 'sh', '-c', 'ulimit -f'], {
        encoding: 'utf8',
      }).trim();
    expect(limitUnder('50', '100')).toBe('50');
    expect(limitUnder('200', '100')).toBe('100');
  });

  it('reports a decoder that is not installed as a failure of that rung only', async () => {
    vi.stubEnv('PATH', '/nonexistent');
    try {
      const [{ convert }] = stillConverters('photo.png');
      await expect(convert('/nonexistent/in.png', '/nonexistent/out.png')).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
