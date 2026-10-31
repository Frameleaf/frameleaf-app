import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StudioReverseConformRepository } from 'src/repositories/studio-reverse-conform.repository.js';

describe('reverse probe process ownership', () => {
  let folder: string;
  const repository = new StudioReverseConformRepository();

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'frameleaf-reverse-probe-'));
    const executable = join(folder, 'ffprobe');
    await writeFile(
      executable,
      String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1);
fs.writeFileSync(${JSON.stringify(join(folder, 'arguments.json'))}, JSON.stringify(args));
if (input.endsWith('/blocked')) {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(${JSON.stringify(join(folder, 'child.pid'))}, String(process.pid));
  setInterval(() => {}, 1000);
} else if (input.endsWith('/fail')) {
  process.stderr.write('controlled reverse probe failure');
  process.exitCode = 7;
} else if (args.includes('json')) {
  process.stdout.write(JSON.stringify({streams:[{index:2,codec_type:'video',width:64,height:32,sample_aspect_ratio:'2:1'}],packets:[{pts:0,dts:0,duration:1}]}));
} else {
  process.stdout.write('[STREAM]\nindex=2\ncodec_type=video\nwidth=64\nheight=32\nsample_aspect_ratio=2:1\n[/STREAM]\n[FORMAT]\n[/FORMAT]\n');
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

  it('keeps coded geometry and sample aspect ratio distinct from display width', async () => {
    await expect(repository.probeGeometry(join(folder, 'source with spaces.mp4'), 2)).resolves.toEqual({
      width: 64,
      height: 32,
      sampleAspectRatio: '2:1',
    });
  });

  it('keeps exact preview packet evidence and local protocol bounds', async () => {
    const input = join(folder, 'source with spaces.mp4');
    await expect(repository.previewPackets(input, new AbortController().signal)).resolves.toEqual([
      { pts: 0, dts: 0, duration: 1 },
    ]);
    const args: string[] = JSON.parse(await readFile(join(folder, 'arguments.json'), 'utf8'));
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual([
      '-protocol_whitelist',
      'file,pipe',
    ]);
    expect(args).toContain('packet=pts,dts,duration');
    expect(args.at(-1)).toBe(input);
  });

  it.each(['geometry', 'preview'] as const)('propagates a %s probe failure', async (kind) => {
    const input = join(folder, 'fail');
    await expect(
      kind === 'geometry'
        ? repository.probeGeometry(input, 2)
        : repository.previewPackets(input, new AbortController().signal),
    ).rejects.toThrow('controlled reverse probe failure');
  });

  it.each(['geometry', 'preview', 'source-packets'] as const)(
    'waits for a resistant %s probe to close before rejecting cancellation',
    async (kind) => {
      const abort = new AbortController();
      const reason = new Error('reverse probe cancelled');
      const input = join(folder, 'blocked');
      const outcome = (
        kind === 'geometry'
          ? repository.probeGeometry(input, 2, abort.signal)
          : kind === 'preview'
            ? repository.previewPackets(input, abort.signal)
            : new MediaRepository({ setContext: vi.fn() } as never).probePackets(input, 2, { signal: abort.signal })
      ).catch((error: unknown) => error);
      let pid: number | undefined;
      try {
        await vi.waitFor(async () => {
          pid = Number(await readFile(join(folder, 'child.pid'), 'utf8'));
          expect(pid).toBeGreaterThan(0);
        });
        abort.abort(reason);
        await vi.waitFor(
          () => expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })),
          {
            timeout: 12_000,
          },
        );
        expect(await outcome).toBe(reason);
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The child may already have closed.
          }
        }
        await outcome;
      }
    },
    20_000,
  );
});
