import { isAbsolute, posix, win32 } from 'node:path';
import { EnvSchema } from 'src/utils/environment-schema.js';

vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, isAbsolute: vi.fn(actual.isAbsolute) };
});

const keys = [
  'FRAMELEAF_MEDIA_LOCATION',
  'FRAMELEAF_PLUGINS_INSTALL_FOLDER',
  'FRAMELEAF_STUDIO_WORKER_TRUST_DIR',
  'FRAMELEAF_IMPORT_ROOTS',
] as const;

describe('native environment paths', () => {
  afterEach(() => vi.mocked(isAbsolute).mockReset());

  it.each(keys)('accepts Windows absolute paths for %s on Windows', (key) => {
    vi.mocked(isAbsolute).mockImplementation(win32.isAbsolute);
    for (const value of [
      String.raw`C:\Frameleaf Data`,
      'C:/Frameleaf/media',
      String.raw`\\server\share\media`,
      String.raw`\\.\GLOBALROOT\Device\HarddiskVolume5\Frameleaf\media`,
    ]) {
      expect(EnvSchema.safeParse({ [key]: value }).success, value).toBe(true);
    }
  });

  it.each(keys)('keeps POSIX path semantics for %s on POSIX', (key) => {
    vi.mocked(isAbsolute).mockImplementation(posix.isAbsolute);
    expect(EnvSchema.safeParse({ [key]: '/var/lib/frameleaf' }).success).toBe(true);
    expect(EnvSchema.safeParse({ [key]: String.raw`C:\Frameleaf` }).success).toBe(false);
  });

  it.each(keys)('rejects relative paths for %s on both platforms', (key) => {
    for (const platformPath of [posix, win32]) {
      vi.mocked(isAbsolute).mockImplementation(platformPath.isAbsolute);
      for (const value of ['relative/media', './media', 'C:media', 'file:///media']) {
        expect(EnvSchema.safeParse({ [key]: value }).success, value).toBe(false);
      }
    }
  });
});
