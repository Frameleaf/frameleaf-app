import { getSupportedMediaTypes } from '@frameleaf/sdk';
import { watch } from 'chokidar';
import { EventEmitter } from 'node:events';
import { startWatch } from 'src/commands/asset';
import { Batcher } from 'src/utils';

vi.mock('chokidar', () => ({ watch: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getSupportedMediaTypes: vi.fn(),
}));

it('admits the same filenames synchronously without changing watcher timing', async () => {
  const before = process.listeners('SIGINT');
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  vi.mocked(watch).mockReturnValue(watcher as never);
  vi.mocked(getSupportedMediaTypes).mockResolvedValue({ image: ['.jpg', '.png'], video: ['.mp4'], sidecar: [] });
  const add = vi.spyOn(Batcher.prototype, 'add');
  try {
    await startWatch(['/synthetic'], { concurrency: 1, progress: true }, { debounceTimeMs: 0 });
    const onFile = watcher.listeners('add')[0];
    expect(watcher.listeners('change')[0]).toBe(onFile);
    for (const [path, admitted] of [
      ['plain.jpg', true],
      ['many.dots/PHOTO.JPG', true],
      ['.jpg', true],
      ['jpg', true],
      ['/synthetic/jpg', false],
      ['trailing.', false],
      ['', false],
      ['clip.MP4', true],
      ['sidecar.xmp', false],
    ] as const) {
      add.mockClear();
      expect(onFile(path)).toBeUndefined();
      expect(add).toHaveBeenCalledTimes(admitted ? 1 : 0);
      if (admitted) expect(add).toHaveBeenCalledWith(path);
    }
    add.mockClear();
    expect(onFile('directory.jpg', { isDirectory: () => true })).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledWith(
      ['/synthetic'],
      expect.objectContaining({
        ignoreInitial: true,
        alwaysStat: true,
        awaitWriteFinish: true,
        depth: 1,
        persistent: true,
      }),
    );
  } finally {
    add.mockRestore();
    for (const listener of process.listeners('SIGINT')) {
      if (!before.includes(listener)) process.off('SIGINT', listener);
    }
  }
});
