import fs from 'node:fs/promises';
import { StorageRepository } from 'src/repositories/storage.repository.js';
vi.mock('src/repositories/logging.repository.js', () => ({ LoggingRepository: class {} }));
vi.mock('src/dtos/library.dto.js', () => ({}));
vi.mock('src/utils/library-walk.js', () => ({ walkLibraryPaths: () => {} }));
vi.mock('src/utils/mime-types.js', () => ({ mimeTypes: {} }));
vi.mock('archiver', () => ({ default: () => {} }));
vi.mock('chokidar', () => ({ watch: () => {} }));
vi.mock('fast-glob', () => ({ default: () => {} }));

describe('bounded source read ownership', () => {
  const sut = new StorageRepository({ setContext: () => {} } as never);
  it('wipes a partial random-read buffer when the file read rejects', async () => {
    let partial: Buffer | undefined;
    const handle = {
      stat: vi.fn(async () => ({ size: 16 })),
      read: vi.fn(async (buffer: Buffer) => {
        partial = buffer;
        buffer.fill(42);
        throw new Error('read failed');
      }),
      close: vi.fn(async () => {}),
    };
    const open = vi.spyOn(fs, 'open').mockResolvedValue(handle as never);
    try {
      const file = await sut.openForRandomRead('/private/source');
      await expect(file.read(0, 16)).rejects.toThrow('read failed');
      expect(partial).toEqual(Buffer.alloc(16));
      await file.close();
      expect(handle.close).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });
});
