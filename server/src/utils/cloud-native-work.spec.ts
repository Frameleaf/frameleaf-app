import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginCloudNativeWork, cloudNativeWorkStopped } from 'src/utils/cloud-native-work.js';

vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...fs, lstat: vi.fn(fs.lstat) };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cloud-native-work-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('retains native ownership across fresh checks until its actual owner reports settlement', async () => {
  await writeFile(join(root, 'output.mp4'), 'unfinished');
  const close = await beginCloudNativeWork(root);
  expect(await cloudNativeWorkStopped(root)).toBe(false);
  await expect(beginCloudNativeWork(root)).rejects.toThrow('cloud_ml_native_work_retained');
  expect(await readFile(join(root, 'output.mp4'), 'utf8')).toBe('unfinished');
  await close();
  await close();
  expect(await close.owns()).toBe(false);
  expect(await cloudNativeWorkStopped(root)).toBe(true);
  await (
    await beginCloudNativeWork(root)
  )();
});

it.each(['old', 'malformed', 'directory', 'symlink'] as const)('retains an unknown %s marker', async (kind) => {
  const marker = join(root, `.frameleaf-native-${kind === 'old' ? randomUUID() : kind}`);
  if (kind === 'symlink') await symlink(join(root, 'missing'), marker);
  else if (kind === 'directory') {
    await mkdir(marker);
  } else await writeFile(marker, '');
  expect(await cloudNativeWorkStopped(root)).toBe(false);
  await expect(beginCloudNativeWork(root)).rejects.toThrow('cloud_ml_native_work_retained');
  expect(await lstat(marker)).toBeTruthy();
});

it('refuses a symlink work directory and leaves its target untouched', async () => {
  const link = `${root}-link`;
  await symlink(root, link);
  try {
    expect(await cloudNativeWorkStopped(link)).toBe(false);
    await expect(beginCloudNativeWork(link)).rejects.toThrow('cloud_ml_native_work_retained');
  } finally {
    await rm(link);
  }
});

it('allows cleanup of an already absent directory but cannot start native work in it', async () => {
  const missing = join(root, 'missing');
  expect(await cloudNativeWorkStopped(missing)).toBe(true);
  await expect(beginCloudNativeWork(missing)).rejects.toThrow();
});

it('admits only one filesystem owner even without a shared database lock', async () => {
  vi.resetModules();
  const otherProcess = await import('src/utils/cloud-native-work.js');
  const attempts = await Promise.allSettled([beginCloudNativeWork(root), otherProcess.beginCloudNativeWork(root)]);
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  expect(await cloudNativeWorkStopped(root)).toBe(false);
  for (const attempt of attempts) if (attempt.status === 'fulfilled') await attempt.value();
  expect(await cloudNativeWorkStopped(root)).toBe(true);
});

it('never lets an old owner retire a replaced ownership marker', async () => {
  const close = await beginCloudNativeWork(root);
  expect(await close.owns()).toBe(true);
  const marker = join(root, '.frameleaf-native-owner');
  await rename(marker, join(root, 'old-marker'));
  await writeFile(marker, '');
  expect(await close.owns()).toBe(false);
  await expect(close()).rejects.toThrow('cloud_ml_native_work_retained');
  expect(await cloudNativeWorkStopped(root)).toBe(false);
});

it('closes a cleanup owner after its guarded recursive removal', async () => {
  const close = await beginCloudNativeWork(root);
  await rm(root, { recursive: true });
  await close();
  expect(await cloudNativeWorkStopped(root)).toBe(true);
});

it('bounds stalled checks without duplicate reads, filesystem mutation, or late acceptance', async () => {
  const stalled = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  vi.useFakeTimers();
  const probe = vi
    .mocked(lstat)
    .mockClear()
    .mockImplementationOnce(async () => {
      entered.resolve();
      await stalled.promise;
      throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    });
  try {
    const first = cloudNativeWorkStopped(root);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe(false);
    expect(await cloudNativeWorkStopped(root)).toBe(false);
    await expect(beginCloudNativeWork(root)).rejects.toThrow('cloud_ml_native_work_retained');
    expect(probe).toHaveBeenCalledTimes(1);
    stalled.resolve();
    vi.useRealTimers();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await cloudNativeWorkStopped(root)).toBe(true);
  } finally {
    stalled.resolve();
    vi.useRealTimers();
    probe.mockRestore();
  }
});
