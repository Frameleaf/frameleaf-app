import { chmod, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaSessionRepository } from 'src/repositories/media-session.repository.js';

describe(MediaSessionRepository.name, () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-session-key-'));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  it('shares a private persisted key across repository instances and refuses broad permissions', async () => {
    const session = { domains: ['example.org'], password: 'fixture-only' };
    const [a, b] = await Promise.all([
      new MediaSessionRepository().encrypt('owner', 'a', session),
      new MediaSessionRepository().encrypt('owner', 'b', session),
    ]);
    expect(await new MediaSessionRepository().decrypt('owner', 'a', a)).toEqual(session);
    expect(await new MediaSessionRepository().decrypt('owner', 'b', b)).toEqual(session);
    const key = join(directory, '.frameleaf-media', 'session.key');
    expect((await stat(key)).mode & 0o777).toBe(0o600);
    await chmod(key, 0o644);
    await expect(new MediaSessionRepository().decrypt('owner', 'a', a)).rejects.toThrow('0600');
  });
  it('refuses a symlink credential directory', async () => {
    await symlink(tmpdir(), join(directory, '.frameleaf-media'));
    await expect(new MediaSessionRepository().encrypt('owner', 'a', { domains: ['example.org'] })).rejects.toThrow();
  });
});
