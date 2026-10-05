import { ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DARKTABLE_TIMEOUT_MS,
  prepareNativeHistory,
  renderDarktable,
  translateDarktableExposure,
  verifyDarktableVersion,
} from 'src/utils/darktable-renderer.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  metadata: vi.fn(),
  stats: vi.fn(),
  autoClose: true,
  onSpawn: undefined as (() => void) | undefined,
  children: [] as Array<{ emit: (event: string) => boolean; kill: ReturnType<typeof vi.fn> }>,
}));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    execFile: Object.assign(vi.fn(), {
      [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn().mockReturnValue(true) });
        mocks.children.push(child);
        mocks.onSpawn?.();
        const execution = Promise.try(() => mocks.exec(...args));
        const close = () => {
          if (mocks.autoClose) {
            child.emit('close');
          }
        };
        void execution.then(close).catch(close);
        return Object.assign(execution, { child });
      },
    }),
  };
});
vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.metadata, stats: mocks.stats }) }));

const recipe = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1 };

/** An explicit unit-test database double, not evidence of a native camera history. */
function historyDouble(file: string) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE images(id INTEGER, history_end INTEGER); INSERT INTO images VALUES(1, 1)');
  db.exec(
    'CREATE TABLE history(imgid INTEGER, num INTEGER, operation TEXT, module INTEGER, op_params BLOB, enabled INTEGER, multi_priority INTEGER)',
  );
  db.prepare('INSERT INTO history VALUES(1, 0, ?, 7, ?, 1, 0)').run('exposure', Buffer.alloc(28));
  db.close();
}

describe('pinned darktable adapter', () => {
  let directory: string;
  let input: string;
  let nativeDirectory: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.autoClose = true;
    mocks.onSpawn = undefined;
    mocks.children.length = 0;
    directory = await mkdtemp(join(tmpdir(), 'darktable-test-'));
    input = join(directory, 'source.CR2');
    await writeFile(input, 'unit-test original');
    nativeDirectory = undefined;
    mocks.metadata.mockResolvedValue({
      format: 'png',
      bitsPerSample: 16,
      width: 10,
      height: 8,
      icc: Buffer.from('profile'),
    });
    mocks.stats.mockResolvedValue({});
    mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === '--version') {
        return { stdout: 'darktable 5.6.1\n', stderr: '' };
      }
      nativeDirectory = dirname(args[0]);
      if (args[1].endsWith('bootstrap.png')) {
        historyDouble(args[args.indexOf('--library') + 1]);
      }
      await writeFile(args[1], 'unit-test output');
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['5.6.0', '5.6.10', '5.6.1+4', '5.8.0'])('rejects engine drift: %s', (version) => {
    expect(() => verifyDarktableVersion(`darktable ${version}\n`)).toThrow('requires darktable 5.6.1');
  });

  it('maps EV to the verified native v7 layout without changing other native defaults', () => {
    const params = Buffer.alloc(28);
    params.writeFloatLE(50, 12);
    params.writeFloatLE(-4, 16);
    params.writeInt32LE(1, 20);
    params.writeInt32LE(1, 24);
    const translated = translateDarktableExposure(params, -1.25);
    expect(translated.readFloatLE(8)).toBe(-1.25);
    expect(translated.subarray(12, 20)).toEqual(params.subarray(12, 20));
    expect(translated.readInt32LE(20)).toBe(0);
    expect(translated.readInt32LE(24)).toBe(0);
    expect(params.readFloatLE(8)).toBe(0);
    expect(() => translateDarktableExposure(Buffer.alloc(24), 1)).toThrow();
    expect(() => translateDarktableExposure(params, NaN)).toThrow();
  });

  it('rejects unexpected native module versions before modifying history', () => {
    const file = join(directory, 'library.db');
    historyDouble(file);
    const db = new DatabaseSync(file);
    db.exec('UPDATE history SET module = 8');
    db.close();
    expect(() => prepareNativeHistory(file, 1)).toThrow('Unsupported native exposure history');
  });

  it.each([{ ...recipe, contrast: 5 }, { ...recipe, exposureEV: 19 }, { ...recipe, exposureEV: NaN }, { version: 1 }])(
    'rejects unsupported recipes before starting an engine: %j',
    async (value) => {
      await expect(renderDarktable(input, value)).rejects.toThrow();
      expect(mocks.exec).not.toHaveBeenCalled();
    },
  );

  it('uses isolated original/history, pinned color policy, and fully validates output before cleanup', async () => {
    const result = await renderDarktable(input, recipe);
    expect(result.toString()).toBe('unit-test output');
    expect(await readFile(input, 'utf8')).toBe('unit-test original');
    expect(mocks.exec).toHaveBeenCalledTimes(3);
    const args = mocks.exec.mock.calls[2][1] as string[];
    expect(args[0]).not.toBe(input);
    expect(args).toEqual(
      expect.arrayContaining(['SRGB', 'RELATIVE_COLORIMETRIC', '--disable-opencl', 'write_sidecar_files=never']),
    );
    expect(mocks.stats).toHaveBeenCalledOnce();
    await expect(readFile(join(nativeDirectory!, 'developed.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([undefined, '8'])(
    'limits all three native children without changing the inherited parent limit %s',
    async (inheritedLimit) => {
      vi.stubEnv('OMP_THREAD_LIMIT', inheritedLimit);
      vi.stubEnv('FRAMELEAF_NATIVE_ENV_TEST', 'preserved');
      const execute = mocks.exec.getMockImplementation()!;
      const parentLimits: Array<string | undefined> = [];
      mocks.exec.mockImplementation((...args) => {
        parentLimits.push(process.env.OMP_THREAD_LIMIT);
        return execute(...args);
      });
      try {
        await renderDarktable(input, recipe);
        expect(mocks.exec).toHaveBeenCalledTimes(3);
        expect(mocks.exec.mock.calls[0][1]).toEqual(['--version']);
        expect(mocks.exec.mock.calls[1][1][1]).toMatch(/bootstrap\.png$/);
        expect(mocks.exec.mock.calls[2][1][1]).toMatch(/developed\.png$/);
        expect(parentLimits).toEqual([inheritedLimit, inheritedLimit, inheritedLimit]);
        expect(process.env.OMP_THREAD_LIMIT).toBe(inheritedLimit);
        for (const call of mocks.exec.mock.calls) {
          const environment = call[2].env as NodeJS.ProcessEnv | undefined;
          expect(environment?.OMP_THREAD_LIMIT).toBe('1');
          expect(environment).not.toBe(process.env);
          expect(environment?.FRAMELEAF_NATIVE_ENV_TEST).toBe('preserved');
          // Check every inherited field without printing environment values on failure.
          expect(
            Object.entries(process.env).every(
              ([key, value]) => key === 'OMP_THREAD_LIMIT' || environment?.[key] === value,
            ),
          ).toBe(true);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('does not invoke native rendering after a version mismatch', async () => {
    mocks.exec.mockResolvedValue({ stdout: 'darktable 5.4.1\n' });
    await expect(renderDarktable(input, recipe)).rejects.toThrow('requires darktable 5.6.1');
    expect(mocks.exec).toHaveBeenCalledOnce();
  });

  it('refuses truncated native output and cleans up', async () => {
    mocks.stats.mockRejectedValue(new Error('truncated PNG'));
    await expect(renderDarktable(input, recipe)).rejects.toThrow('truncated PNG');
    await expect(readFile(join(nativeDirectory!, 'developed.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explicitly kills the native child with SIGKILL on caller cancellation', async () => {
    const controller = new AbortController();
    mocks.exec.mockImplementation((_command, _args, options) => {
      expect(options.killSignal).toBe('SIGKILL');
      controller.abort(new Error('cancelled'));
      options.signal.throwIfAborted();
    });
    await expect(renderDarktable(input, recipe, controller.signal)).rejects.toThrow('cancelled');
    expect(mocks.children.at(0)!.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('does not spawn a child for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(renderDarktable(input, recipe, controller.signal)).rejects.toThrow('already cancelled');
    expect(mocks.children).toHaveLength(0);
  });

  it('kills a child when cancellation races with process creation', async () => {
    const controller = new AbortController();
    mocks.onSpawn = () => controller.abort(new Error('cancelled during spawn'));
    mocks.exec.mockImplementation((_command, _args, options) => options.signal.throwIfAborted());
    await expect(renderDarktable(input, recipe, controller.signal)).rejects.toThrow('cancelled during spawn');
    expect(mocks.children.at(0)!.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('removes abort listeners after close so later cancellation does not signal completed children', async () => {
    const controller = new AbortController();
    await renderDarktable(input, recipe, controller.signal);
    controller.abort();
    for (const child of mocks.children) {
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it('sets one deadline for detection plus both native invocations', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await renderDarktable(input, recipe);
      expect(timeout).toHaveBeenCalledWith(DARKTABLE_TIMEOUT_MS);
      const signals = mocks.exec.mock.calls.map((call) => call[2].signal);
      expect(signals[1]).toBe(signals[0]);
      expect(signals[2]).toBe(signals[0]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('propagates a deadline during native processing and removes partial output', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    mocks.exec.mockImplementation(async (_command, args, options) => {
      if (args[0] === '--version') {
        return { stdout: 'darktable 5.6.1\n' };
      }
      nativeDirectory = dirname(args[0]);
      await writeFile(args[1], 'partial output');
      controller.abort(new DOMException('Native deadline exceeded', 'TimeoutError'));
      options.signal.throwIfAborted();
    });
    try {
      await expect(renderDarktable(input, recipe)).rejects.toMatchObject({ name: 'TimeoutError' });
      await expect(readFile(join(nativeDirectory!, 'bootstrap.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mocks.exec).toHaveBeenCalledTimes(2);
      expect(mocks.children.at(-1)!.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    } finally {
      timeout.mockRestore();
    }
  });

  it('refuses overlapping renders before another process starts and admits work after completion', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<{ stdout: string }>();
    mocks.exec.mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    const first = renderDarktable(input, recipe);
    await started.promise;
    try {
      await expect(renderDarktable(input, recipe)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(renderDarktable(input, recipe)).rejects.toBeInstanceOf(ServiceUnavailableException);
      const cancelled = new AbortController();
      cancelled.abort(new Error('already cancelled'));
      await expect(renderDarktable(input, recipe, cancelled.signal)).rejects.toThrow('already cancelled');
      expect(mocks.exec).toHaveBeenCalledOnce();
    } finally {
      release.resolve({ stdout: 'darktable 5.6.1\n' });
      await first;
    }
    await expect(renderDarktable(input, recipe)).resolves.toBeInstanceOf(Buffer);
  });

  it('recovers admission after native failure and cleanup', async () => {
    mocks.exec.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(renderDarktable(input, recipe)).rejects.toThrow('spawn failed');
    mocks.stats.mockRejectedValueOnce(new Error('invalid native output'));
    await expect(renderDarktable(input, recipe)).rejects.toThrow('invalid native output');
    await expect(readFile(join(nativeDirectory!, 'developed.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(renderDarktable(input, recipe)).resolves.toBeInstanceOf(Buffer);
  });

  it('holds admission after cancellation until the child closes, then cleans up and admits work', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const execute = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation((command, args, options) => {
      if (args[0] === '--version') {
        return execute(command, args, options);
      }
      nativeDirectory = dirname(args[0]);
      mocks.autoClose = false;
      started.resolve();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            reject(options.signal.reason);
            aborted.resolve();
          },
          { once: true },
        );
      });
    });
    const first = renderDarktable(input, recipe, controller.signal);
    const failure = expect(first).rejects.toThrow('cancelled');
    await started.promise;
    controller.abort(new Error('cancelled'));
    await aborted.promise;
    try {
      expect(mocks.children.at(-1)!.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(mocks.children.at(0)!.kill).not.toHaveBeenCalled();
      await expect(renderDarktable(input, recipe)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mocks.exec).toHaveBeenCalledTimes(2);
    } finally {
      mocks.children.at(-1)!.emit('close');
      await failure;
      mocks.autoClose = true;
      mocks.exec.mockImplementation(execute);
    }
    await expect(readFile(join(nativeDirectory!, 'original.CR2'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(renderDarktable(input, recipe)).resolves.toBeInstanceOf(Buffer);
  });
});
