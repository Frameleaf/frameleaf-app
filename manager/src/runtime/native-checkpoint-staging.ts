import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Refusal } from '../contracts.js';
import { NativeCheckpointSchema } from './native.js';
import {
  createNativeRecovery,
  NativeRecovery,
  type NativeRecoveryRecord,
} from './native-recovery.js';

const changed = () => new Refusal('native_checkpoint_changed');
const DiskReceipt = NativeCheckpointSchema.omit({
  protocolVersion: true,
  state: true,
});
const readFlags =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const sameFile = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  b.nlink === 1;

async function directory(path: string): Promise<Stats> {
  const value = await lstat(path);
  if (
    path !== resolve(path) ||
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw changed();
  return value;
}
async function json(path: string): Promise<unknown> {
  const named = await lstat(path);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.size > 4096 ||
    (await realpath(path)) !== path
  )
    throw changed();
  const file = await open(path, readFlags);
  try {
    if (!sameFile(named, await file.stat())) throw changed();
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (
      length !== named.size ||
      !sameFile(named, await file.stat()) ||
      !sameFile(named, await lstat(path))
    )
      throw changed();
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
  } finally {
    await file.close();
  }
}
async function verifyDump(
  path: string,
  expected: { bytes: number; sha256: string },
): Promise<Stats> {
  const named = await lstat(path);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.size !== expected.bytes ||
    (await realpath(path)) !== path
  )
    throw changed();
  const file = await open(path, readFlags);
  try {
    if (!sameFile(named, await file.stat())) throw changed();
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > expected.bytes) throw changed();
      hash.update(chunk);
    }
    if (
      length !== expected.bytes ||
      hash.digest('hex') !== expected.sha256 ||
      !sameFile(named, await file.stat()) ||
      !sameFile(named, await lstat(path))
    )
      throw changed();
    return named;
  } finally {
    await file.close();
  }
}

export async function stageNativeCheckpoint(
  managerDirectory: string,
  context: Parameters<typeof createNativeRecovery>[0],
  checkpoint: unknown,
) {
  const recovery = createNativeRecovery(context, checkpoint);
  const owner = join(
    context.installation.state,
    'checkpoints',
    context.operation.id,
  );
  try {
    await directory(context.installation.state);
    await directory(join(context.installation.state, 'checkpoints'));
    const ownerIdentity = await directory(owner);
    if (
      (await readdir(owner)).sort().join(',') !==
      'checkpoint.json,database.dump'
    )
      throw changed();
    const receipt = DiskReceipt.parse(
      await json(join(owner, 'checkpoint.json')),
    );
    if (
      !isDeepStrictEqual(
        createNativeRecovery(context, {
          ...receipt,
          protocolVersion: 1,
          state: 'checkpoint',
        }),
        recovery,
      )
    )
      throw changed();
    const source = join(owner, 'database.dump');
    const sourceIdentity = await verifyDump(source, recovery.checkpoint.dump);
    await directory(managerDirectory);
    const root = join(managerDirectory, 'native-backup-staging');
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const rootIdentity = await directory(root);
    const destination = join(root, context.operation.id);
    const existing = await lstat(destination)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
    if (existing) {
      await verifyNativeBackupDirectory(destination, recovery);
      return { directory: destination, recovery };
    }
    const temporary = join(
      root,
      `.${context.operation.id}.${randomUUID()}.partial`,
    );
    await mkdir(temporary, { mode: 0o700 });
    try {
      const dump = join(temporary, 'database.dump');
      await copyFile(source, dump, constants.COPYFILE_EXCL);
      const copied = await open(
        dump,
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await copied.chmod(0o600);
        await copied.sync();
      } finally {
        await copied.close();
      }
      await verifyDump(dump, recovery.checkpoint.dump);
      if (
        !sameFile(
          sourceIdentity,
          await verifyDump(source, recovery.checkpoint.dump),
        )
      )
        throw changed();
      const record = await open(join(temporary, 'recovery.json'), 'wx', 0o600);
      try {
        await record.writeFile(JSON.stringify(recovery) + '\n');
        await record.sync();
      } finally {
        await record.close();
      }
      const freshOwner = await directory(owner),
        freshRoot = await directory(root);
      if (
        freshOwner.dev !== ownerIdentity.dev ||
        freshOwner.ino !== ownerIdentity.ino ||
        freshRoot.dev !== rootIdentity.dev ||
        freshRoot.ino !== rootIdentity.ino ||
        (await readdir(owner)).sort().join(',') !==
          'checkpoint.json,database.dump' ||
        !isDeepStrictEqual(
          DiskReceipt.parse(await json(join(owner, 'checkpoint.json'))),
          receipt,
        )
      )
        throw changed();
      // The owner retains its durable dump until encryption is journaled; lost staging can be rebuilt on Windows.
      if (process.platform !== 'win32') {
        const handle = await open(temporary, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await rename(temporary, destination);
      if (process.platform !== 'win32') {
        const handle = await open(root, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return { directory: destination, recovery };
    } finally {
      // Only this attempt's exclusive scratch is eligible for cleanup; never adopt a foreign partial directory.
      for (const file of ['database.dump', 'recovery.json'])
        await rm(join(temporary, file), { force: true });
      await rmdir(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } catch {
    throw changed();
  }
}

export async function verifyNativeBackupDirectory(
  path: string,
  expected: NativeRecoveryRecord,
): Promise<void> {
  try {
    const recovery = NativeRecovery.parse(expected);
    await directory(path);
    if (
      (await readdir(path)).sort().join(',') !==
        'database.dump,recovery.json' ||
      !isDeepStrictEqual(
        NativeRecovery.parse(await json(join(path, 'recovery.json'))),
        recovery,
      )
    )
      throw changed();
    await verifyDump(join(path, 'database.dump'), recovery.checkpoint.dump);
  } catch {
    throw changed();
  }
}
