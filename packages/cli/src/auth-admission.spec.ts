import { getMyUser, init } from '@frameleaf/sdk';
import { readFile } from 'node:fs/promises';
import { connect, readAuthFile } from 'src/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getMyUser: vi.fn(),
  init: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(getMyUser).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('connection refused');
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('discovery unavailable')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CLI auth admission', () => {
  it.each(['', 'null', '[]', 'url: https://example.test', 'url: 123\nkey: key', 'url: https://example.test\nkey: ""'])(
    'rejects malformed auth document %j',
    async (document) => {
      vi.mocked(readFile).mockResolvedValue(Buffer.from(document));
      await expect(readAuthFile('/fixture')).rejects.toThrow('Invalid authentication file');
    },
  );

  it.each(['url: https://example.test\nkey: fixture-key', 'instanceUrl: https://example.test\napiKey: fixture-key'])(
    'loads current and legacy auth documents',
    async (document) => {
      vi.mocked(readFile).mockResolvedValue(Buffer.from(document));
      await expect(readAuthFile('/fixture')).resolves.toEqual({ url: 'https://example.test', key: 'fixture-key' });
    },
  );

  it('propagates filesystem errors', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.mocked(readFile).mockRejectedValue(error);
    await expect(readAuthFile('/fixture')).rejects.toBe(error);
  });

  it('does not admit a connection when user lookup fails outside the HTTP error lane', async () => {
    vi.mocked(getMyUser).mockRejectedValue(new Error('network unavailable'));
    await expect(connect('https://example.test', 'fixture-key')).rejects.toThrow('connection refused');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('retains discovery fallback when direct authentication succeeds', async () => {
    vi.mocked(getMyUser).mockResolvedValue({} as Awaited<ReturnType<typeof getMyUser>>);
    await expect(connect('https://example.test', 'fixture-key')).resolves.toEqual({
      url: 'https://example.test',
      key: 'fixture-key',
    });
    expect(init).toHaveBeenCalledWith({ baseUrl: 'https://example.test', apiKey: 'fixture-key' });
  });
});
