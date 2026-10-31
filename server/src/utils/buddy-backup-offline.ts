/* eslint-disable no-restricted-imports -- Offline recovery runs directly under Node without application aliases. */
import { copyFile, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUDDY_ID, BUDDY_UUID, parseBuddyKeyring } from './buddy-backup-crypto.ts';
import { BuddyBackupReader } from './buddy-backup-reader.ts';
import { buddyFileHash } from './buddy-backup-recovery.ts';
import { BuddyVault, createBuddyDirectory, flushBuddyDirectory, writeBuddyFile } from './buddy-backup-vault.ts';
import { prepareBuddyBootBinding, revokeBuddyBootBinding } from './buddy-boot-binding.ts';

export const BUDDY_OFFLINE_USAGE =
  'Usage: frameleaf-admin buddy-backup recover|export --vault /vault/UUID --output /empty-directory [--kit /recovery-kit.json] [--snapshot UUID]';

/** FL-509: a failure whose message names no path, key or vault content, so the owner may see it. */
export class BuddyOfflineError extends Error {
  name = 'BuddyOfflineError';
}

const FILE_ERRORS: Record<string, string> = {
  ENOENT: 'A file or directory given to the command does not exist',
  ENOTDIR: 'A path given to the command is not a directory',
  EISDIR: 'A file given to the command is a directory',
  EACCES: 'Permission denied for a file or directory given to the command',
  EPERM: 'Permission denied for a file or directory given to the command',
  ENOSPC: 'The output disk is full',
};

/** What the owner sees when an offline export or recovery fails: never paths, keys or parser excerpts. */
export const buddyOfflineFailureMessage = (error: unknown): string => {
  if (error instanceof BuddyOfflineError) {
    return error.message;
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code.startsWith('ERR_PARSE_ARGS_')) {
    return 'Unknown or incomplete option';
  }
  if (code) {
    return FILE_ERRORS[code] ?? 'A file or directory given to the command could not be used';
  }
  // The Buddy vault, reader and crypto utilities throw plain Errors with fixed wording. Anything else
  // (parser, schema or library errors) can quote paths or vault content, so it stays generic.
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
    return error.message;
  }
  return 'The vault or recovery kit could not be read or verified';
};

/**
 * Runs the offline command and reports its own safe messages (FL-509). Boot-binding failures stay generic
 * and are rethrown, since they deliberately hide private values.
 */
export const runBuddyBackupCommand = async (args: string[]) => {
  try {
    await buddyBackupCommand(args);
  } catch (error) {
    if (args[0] === 'binding-prepare' || args[0] === 'binding-revoke') {
      throw error;
    }
    const message = buddyOfflineFailureMessage(error);
    console.error(message);
    if (message !== BUDDY_OFFLINE_USAGE) {
      console.error(BUDDY_OFFLINE_USAGE);
    }
    process.exitCode = 1;
  }
};

/** No database, Cloud credentials, original server, or running application is required. */
export const buddyBackupCommand = async (args: string[]) => {
  if (args[0] === 'binding-prepare' || args[0] === 'binding-revoke') {
    try {
      const prepare = args[0] === 'binding-prepare';
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        strict: true,
        allowPositionals: false,
        options: {
          binding: { type: 'string' },
          ...(prepare && {
            recovery: { type: 'string' },
            keys: { type: 'string' },
            'worker-service': { type: 'string' },
            'mount-profile': { type: 'string' },
          }),
        },
      });
      if (positionals.length > 0 || typeof values.binding !== 'string')
        throw new Error('Invalid replacement-local Buddy boot authority');
      if (prepare) {
        if (typeof values.recovery !== 'string' || typeof values.keys !== 'string')
          throw new Error('Invalid replacement-local Buddy boot authority');
        await prepareBuddyBootBinding(
          values.binding,
          values.recovery,
          values.keys.split(','),
          values['worker-service'] as string | undefined,
          values['mount-profile'] as string | undefined,
        );
      } else await revokeBuddyBootBinding(values.binding);
      return;
    } catch {
      throw new Error('Invalid replacement-local Buddy boot authority');
    }
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      vault: { type: 'string' },
      output: { type: 'string' },
      kit: { type: 'string' },
      snapshot: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !['recover', 'export'].includes(positionals[0]) || !values.vault || !values.output)
    throw new BuddyOfflineError(BUDDY_OFFLINE_USAGE);
  const vaultPath = resolve(values.vault);
  const vaultId = basename(vaultPath);
  if (!BUDDY_UUID.test(vaultId) || (values.snapshot && !BUDDY_UUID.test(values.snapshot)))
    throw new BuddyOfflineError('Invalid vault or snapshot identifier');
  const vault = new BuddyVault(dirname(vaultPath), vaultId);
  const snapshots = await vault.snapshots();
  if (snapshots.length === 0) throw new BuddyOfflineError('No complete snapshots in this vault');
  if (values.snapshot && snapshots.every((snapshot) => snapshot.id !== values.snapshot))
    throw new BuddyOfflineError('Snapshot is not in this vault');
  const output = resolve(values.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (!(await lstat(output)).isDirectory() || (await readdir(output)).length > 0)
    throw new BuddyOfflineError('Recovery output must be an empty regular directory');
  if (positionals[0] === 'export') {
    const copied = new Set<string>();
    // Immutable snapshots and objects make this consistent without copying the host's mutable catalog.
    for (const snapshot of snapshots) {
      if (values.snapshot && snapshot.id !== values.snapshot) continue;
      const envelope = await vault.snapshot(snapshot.id);
      const destination = join(output, vaultId);
      for (const receipt of envelope.snapshot.objects) {
        if (copied.has(receipt.id)) continue;
        const bytes = await vault.read(receipt.id);
        if (BuddyVault.receipt(receipt.id, bytes).digest !== receipt.digest || bytes.length !== receipt.bytes)
          throw new BuddyOfflineError('Vault export failed ciphertext verification');
        await writeBuddyFile(join(destination, 'objects', receipt.id.slice(0, 2), receipt.id), bytes, true);
        copied.add(receipt.id);
      }
      // Includes the pinned signer at commit, so catalog reconstruction can verify historical keys.
      await createBuddyDirectory(join(destination, 'snapshots'));
      const source = join(vaultPath, 'snapshots', snapshot.id);
      const target = join(destination, 'snapshots', snapshot.id);
      await copyFile(source, target);
      const handle = await open(target, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await flushBuddyDirectory(dirname(target));
    }
    await writeBuddyFile(join(output, 'export-complete.json'), JSON.stringify({ version: 1, vaultId }));
    return;
  }
  if (!values.kit) throw new BuddyOfflineError('A recovery kit file is required');
  const kitFile = await open(resolve(values.kit), 'r');
  let kit: unknown;
  try {
    if ((await kitFile.stat()).size > 64 * 1024) throw new BuddyOfflineError('Recovery kit exceeds its limit');
    // eslint-disable-next-line unicorn/consistent-json-file-read -- FileHandle.readFile takes encoding as its first argument.
    const content = await kitFile.readFile('utf8');
    try {
      kit = JSON.parse(content);
    } catch {
      // A parser message can quote the kit's key material.
      throw new BuddyOfflineError('Invalid Buddy recovery kit');
    }
  } finally {
    await kitFile.close();
  }
  let ring: ReturnType<typeof parseBuddyKeyring>;
  try {
    ring = parseBuddyKeyring(kit, vaultId);
  } catch {
    throw new BuddyOfflineError('Invalid Buddy recovery kit for this vault');
  }
  const envelope = await vault.snapshot(values.snapshot ?? snapshots[0].id);
  const reader = new BuddyBackupReader(ring, envelope, (id) => vault.read(id));
  const manifest = await reader.manifest();
  const database = manifest.library.database;
  const directory = database ? join(output, 'recovery', envelope.snapshot.id) : output;
  if (manifest.bootConfiguration !== undefined) {
    const { stageBuddyBootConfiguration } = await import('./buddy-boot-configuration.ts');
    await stageBuddyBootConfiguration(directory, envelope.snapshot.id, manifest.bootConfiguration);
  }
  // Untrusted original paths are metadata only; offline recovery writes to this empty directory.
  for (const [sha256, content] of Object.entries(manifest.contents)) {
    const target = join(directory, 'objects', sha256);
    await reader.download(manifest, sha256, target);
    const evidence = await buddyFileHash(target);
    if (evidence.sha256 !== sha256 || evidence.size !== content.bytes)
      throw new BuddyOfflineError('Offline recovery failed verification');
  }
  if (database) {
    const files = [
      ...Object.values(manifest.library.assets).flatMap((asset) => asset.files),
      ...Object.values(manifest.library.profiles),
      ...manifest.dependencies,
      ...manifest.configurationFiles,
    ];
    if (files.length > 1_000_000) throw new BuddyOfflineError('Offline recovery file inventory exceeds its limit');
    for (const file of files) {
      if (
        typeof file.path !== 'string' ||
        !BUDDY_ID.test(file.sha256) ||
        !Number.isSafeInteger(file.size) ||
        // eslint-disable-next-line unicorn/no-impossible-length-comparison -- This is untrusted JSON, not a Map or Set.
        file.size < 0
      )
        throw new BuddyOfflineError('Invalid offline recovery file');
      const evidence = await buddyFileHash(join(directory, 'objects', file.sha256));
      if (evidence.sha256 !== file.sha256 || evidence.size !== file.size)
        throw new BuddyOfflineError('Offline recovery file failed verification');
    }
    const databasePath = join(directory, 'database.sql.gz');
    await reader.download(manifest, database.sha256, databasePath);
    const evidence = await buddyFileHash(databasePath);
    if (evidence.sha256 !== database.sha256 || evidence.size !== database.size)
      throw new BuddyOfflineError('Offline recovery database failed verification');
    // Staging grants no publication authority: maintenance still requires explicit mounts,
    // configuration allowlists and a live fence, and keep mode preserves current content.
    await writeBuddyFile(
      join(directory, 'prepared.json'),
      JSON.stringify({ version: 1, scope: 'server', mode: 'keep', manifest, files }),
    );
  }
  await writeBuddyFile(join(output, 'manifest.json'), JSON.stringify(manifest));
  await writeBuddyFile(
    join(output, 'recovery-complete.json'),
    JSON.stringify({
      version: 1,
      vaultId,
      snapshotId: envelope.snapshot.id,
      databaseObject: manifest.library.database?.sha256 ?? null,
    }),
  );
};
