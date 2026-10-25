import { constants } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const prefix = '.frameleaf-native-';
const checks = new Set<string>();
const flush = async (folder: string) => {
  const directory = await open(folder, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

async function inspect(folder: string) {
  try {
    if (!(await lstat(folder)).isDirectory()) return false;
    let count = 0;
    for await (const entry of await opendir(folder, { bufferSize: 8 })) {
      if (++count > 2048 || entry.name.startsWith(prefix)) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Call under the same ownership lock as admission and actual recursive removal. */
export async function cloudNativeWorkStopped(folder: string) {
  if (checks.has(folder)) return false;
  checks.add(folder);
  const work = inspect(folder).finally(() => checks.delete(folder));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The marker survives database rewind; age, a lost claim, or cancellation never proves native stop. */
export async function beginCloudNativeWork(folder: string) {
  if (!(await cloudNativeWorkStopped(folder))) throw new Error('cloud_ml_native_work_retained');
  // One exclusive filesystem owner also excludes cleanup if the database lock connection is lost.
  const marker = join(folder, `${prefix}owner`);
  const file = await open(marker, 'wx', 0o600);
  let identity: Awaited<ReturnType<typeof file.stat>>;
  try {
    identity = await file.stat();
    await file.sync();
  } finally {
    await file.close();
  }
  await flush(folder);
  let closed = false;
  const close = async () => {
    if (closed) return;
    const stat = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!stat) {
      closed = true;
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 0 || stat.dev !== identity.dev || stat.ino !== identity.ino)
      throw new Error('cloud_ml_native_work_retained');
    await rm(marker);
    await flush(folder);
    closed = true;
  };
  return Object.assign(close, {
    owns: async () => {
      if (closed) return false;
      const stat = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      return (
        !!stat &&
        stat.isFile() &&
        stat.nlink === 1 &&
        stat.size === 0 &&
        stat.dev === identity.dev &&
        stat.ino === identity.ino
      );
    },
  });
}
