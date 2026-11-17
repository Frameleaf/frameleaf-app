import { mkdtemp, link, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectExistsError, dirStore } from '../src/index.js';

// A drive that cannot make hard links, and failures that only a real fault would cause, are played here.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir) };
});
const failure = (code: string) => Object.assign(new Error(code), { code });

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'backup-core-fallback-'));
});
afterEach(async () => {
  vi.mocked(link).mockRestore();
  vi.mocked(stat).mockRestore();
  vi.mocked(readdir).mockRestore();
  await rm(work, { recursive: true, force: true });
});

describe('storage on a drive that cannot make links', () => {
  it('still stores, and still never replaces an object', async () => {
    vi.mocked(link).mockRejectedValue(failure('EPERM'));
    const store = dirStore(work);
    await store.put('p/aa', Buffer.from('first'));
    await expect(store.put('p/aa', Buffer.from('second'))).rejects.toBeInstanceOf(ObjectExistsError);
    expect((await store.get('p/aa')).toString()).toBe('first');
    expect((await store.list('')).map((object) => object.key)).toEqual(['p/aa']);
  });

  it('stores nothing when it cannot tell whether the name is free', async () => {
    vi.mocked(link).mockRejectedValue(failure('EPERM'));
    vi.mocked(stat).mockRejectedValueOnce(failure('EACCES'));
    const store = dirStore(work);
    await expect(store.put('p/aa', Buffer.from('first'))).rejects.toMatchObject({ code: 'EACCES' });
    expect(await store.list('')).toEqual([]);
  });

  it('does not fall back for a failure that is not about links', async () => {
    vi.mocked(link).mockRejectedValue(failure('EIO'));
    const store = dirStore(work);
    await expect(store.put('p/aa', Buffer.from('first'))).rejects.toMatchObject({ code: 'EIO' });
    expect(await store.list('')).toEqual([]);
  });
});

describe('listing storage', () => {
  it('fails when a folder inside goes missing mid-walk, instead of reading as empty', async () => {
    const store = dirStore(work);
    await store.put('p/aa', Buffer.from('first'));
    vi.mocked(readdir).mockRejectedValueOnce(failure('ENOENT'));
    await expect(store.list('')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.list('')).map((object) => object.key)).toEqual(['p/aa']);
  });
});
