/* eslint-disable no-restricted-imports -- Offline recovery runs directly under Node without application aliases. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BUDDY_ID, BUDDY_UUID } from './buddy-backup-crypto.ts';
import { createBuddyDirectory, flushBuddyDirectory, writeBuddyFile } from './buddy-backup-vault.ts';
import type { CloudBackupManifestFile } from './cloud-backup.ts';
import type { BuddyManifest } from '../services/buddy-backup-capture.service.ts';

export type BuddyRecovery = {
  version: 1;
  scope: 'settings' | 'server';
  mode: 'keep' | 'replace';
  manifest: BuddyManifest;
  files: CloudBackupManifestFile[];
};
type Publication = {
  target: string;
  sha256: string;
  size: number;
  previous: string | null;
  previousSize: number;
  rollback: string;
};
type Journal = { version: 2; state: 'publishing' | 'files-ready' | 'database-ready' | 'complete' | 'rolled-back' };

export const buddyInside = (root: string, path: string) => {
  const child = relative(resolve(root), resolve(path));
  return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};

export const buddyFileHash = async (
  path: string,
  options: { signal?: AbortSignal; progress?: (bytes: number) => void } = {},
) => {
  options.signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Buddy recovery requires regular files');
    const hash = createHash('sha256');
    for await (const bytes of file.createReadStream({ autoClose: false, signal: options.signal })) {
      hash.update(bytes);
      options.progress?.(bytes.length);
    }
    options.signal?.throwIfAborted();
    const after = await file.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Buddy recovery file changed during verification');
    return { sha256: hash.digest('hex'), size: Number(after.size) };
  } finally {
    await file.close();
  }
};

const assertRecoveryCredentialPath = async (target: string) => {
  for (const key of ['DB_URL', 'DB_HOSTNAME', 'DB_DATABASE_NAME', 'DB_USERNAME', 'DB_PASSWORD']) {
    const source = process.env[`${key}_FILE`];
    if (!source) continue;
    const canonical = await realpath(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(source);
      throw new Error('Cannot verify local database credential file');
    });
    if (resolve(source) === target || canonical === target)
      throw new Error('Recovery cannot replace a local database credential file');
  }
};

/** Never follow a symlink in a publication path, including one inside an otherwise approved mount. */
export const buddyRecoveryTarget = async (target: string, roots: string[], configuration: string[]) => {
  if (!isAbsolute(target) || resolve(target) !== target || target.includes('\0'))
    throw new Error('Invalid recovery path');
  await assertRecoveryCredentialPath(target);
  const root = roots.filter((root) => buddyInside(root, target)).sort((a, b) => b.length - a.length)[0];
  if (!root && !configuration.includes(target))
    throw new Error('Recovery requires the original configured storage mounts');
  const anchor = root ?? dirname(target);
  if ((await realpath(anchor)) !== resolve(anchor)) throw new Error('Recovery mount must not be a symlink');
  for (let path = target; path !== anchor; path = dirname(path)) {
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (entry?.isSymbolicLink() || (path !== target && entry && !entry.isDirectory()))
      throw new Error('Unsafe recovery path');
  }
};

export const readBuddyRecovery = async (root: string, id: string): Promise<BuddyRecovery> => {
  if (!BUDDY_UUID.test(id)) throw new Error('Invalid recovery identifier');
  const file = await open(join(root, 'recovery', id, 'prepared.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let plan: BuddyRecovery;
  try {
    if ((await file.stat()).size > 1024 ** 3) throw new Error('Recovery manifest exceeds its limit');
    // eslint-disable-next-line unicorn/consistent-json-file-read -- FileHandle.readFile takes encoding as its first argument.
    const content = await file.readFile('utf8');
    plan = JSON.parse(content);
  } finally {
    await file.close();
  }
  if (
    plan.version !== 1 ||
    !['server', 'settings'].includes(plan.scope) ||
    !['keep', 'replace'].includes(plan.mode) ||
    plan.manifest?.version !== 1 ||
    !Array.isArray(plan.files) ||
    plan.files.length > 1_000_000 ||
    plan.files.some(
      (file) =>
        typeof file.path !== 'string' ||
        !BUDDY_ID.test(file.sha256) ||
        !Number.isSafeInteger(file.size) ||
        // eslint-disable-next-line unicorn/no-impossible-length-comparison -- This is untrusted JSON, not a Map or Set.
        file.size < 0,
    )
  )
    throw new Error('Invalid prepared recovery');
  return plan;
};

/** Maintenance is the publication barrier. Journal before every rename; keep rollback copies after success. */
export class BuddyRecoveryFiles {
  readonly directory: string;
  readonly id: string;
  private journal: Journal = { version: 2, state: 'publishing' };
  private readonly assert: () => Promise<void>;
  constructor(root: string, id: string, assert: () => Promise<void> = async () => {}) {
    if (!BUDDY_UUID.test(id)) throw new Error('Invalid recovery identifier');
    this.id = id;
    this.directory = join(root, 'recovery', id);
    this.assert = assert;
  }
  async load() {
    try {
      this.journal = JSON.parse(await readFile(join(this.directory, 'publication.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      this.journal.version !== 2 ||
      !['publishing', 'files-ready', 'database-ready', 'complete', 'rolled-back'].includes(this.journal.state)
    )
      throw new Error('Invalid recovery journal');
    return this.journal.state;
  }
  async state(state: Journal['state']) {
    await this.assert();
    this.journal.state = state;
    await writeBuddyFile(join(this.directory, 'publication.json'), JSON.stringify(this.journal), false, this.assert);
  }
  private entryPath(target: string) {
    const id = createHash('sha256').update(target).digest('hex');
    return join(this.directory, 'publications', id.slice(0, 2), id);
  }
  async verify(plan: BuddyRecovery, roots: string[], configuration: string[]) {
    for (const file of plan.files) {
      await this.assert();
      await buddyRecoveryTarget(file.path, roots, configuration);
      const evidence = await buddyFileHash(file.path);
      if (evidence.sha256 !== file.sha256 || evidence.size !== file.size)
        throw new Error('Recovered library failed its integrity check');
    }
  }
  async publish(plan: BuddyRecovery, roots: string[], configuration: string[]) {
    if (['database-ready', 'complete'].includes(await this.load())) return this.verify(plan, roots, configuration);
    if (this.journal.state === 'rolled-back') throw new Error('Stage a new recovery after rollback');
    const paths = new Map<string, CloudBackupManifestFile>();
    for (const file of plan.files) {
      const previous = paths.get(file.path);
      if (previous && (previous.sha256 !== file.sha256 || previous.size !== file.size))
        throw new Error('Conflicting recovery paths');
      paths.set(file.path, file);
    }
    const files = paths.values().toArray();
    // Verify the entire plan before the first write; unavailable mounts never produce partial success.
    for (const file of files) {
      await this.assert();
      await buddyRecoveryTarget(file.path, roots, configuration);
      await assertRecoveryCredentialPath(`${file.path}.buddy-rollback-${this.id}`);
      const evidence = await buddyFileHash(join(this.directory, 'objects', file.sha256));
      if (evidence.sha256 !== file.sha256 || evidence.size !== file.size)
        throw new Error('Staged recovery failed verification');
      const exists = await lstat(file.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (exists && plan.mode !== 'replace') {
        const current = await buddyFileHash(file.path);
        if (current.sha256 !== file.sha256 || current.size !== file.size)
          throw new Error('A recovery target has newer content. Choose overwrite to preserve it in a rollback copy.');
      }
    }
    for (const file of files) {
      await this.assert();
      await buddyRecoveryTarget(file.path, roots, configuration);
      const current = await lstat(file.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      const evidence = current ? await buddyFileHash(file.path) : null;
      if (evidence?.sha256 === file.sha256 && evidence.size === file.size) continue;
      if (current && plan.mode !== 'replace')
        throw new Error('A recovery target has newer content. Choose overwrite to preserve it in a rollback copy.');
      let entry: Publication | null = null;
      try {
        entry = JSON.parse(await readFile(this.entryPath(file.path), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        entry &&
        (entry.target !== file.path ||
          entry.sha256 !== file.sha256 ||
          entry.size !== file.size ||
          entry.rollback !== `${file.path}.buddy-rollback-${this.id}`)
      )
        throw new Error('Recovery journal differs from its plan');
      if (!entry) {
        entry = {
          target: file.path,
          sha256: file.sha256,
          size: file.size,
          previous: evidence?.sha256 ?? null,
          previousSize: evidence?.size ?? 0,
          rollback: `${file.path}.buddy-rollback-${this.id}`,
        };
        // One immutable preimage per target: bounded writes, constant-time lookup on resume.
        await writeBuddyFile(this.entryPath(file.path), JSON.stringify(entry), true, this.assert);
      }
      if (entry.previous) {
        const backup = await lstat(entry.rollback).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (backup) {
          const prior = await buddyFileHash(entry.rollback);
          if (prior.sha256 !== entry.previous || prior.size !== entry.previousSize || current)
            throw new Error('Recovery rollback copy or target changed');
        } else {
          if (evidence?.sha256 !== entry.previous || evidence.size !== entry.previousSize)
            throw new Error('Recovery target changed after confirmation');
          await this.assert();
          await rename(file.path, entry.rollback);
          await flushBuddyDirectory(dirname(file.path));
        }
      }
      await createBuddyDirectory(dirname(file.path));
      const temporary = `${file.path}.buddy-${randomUUID()}`;
      try {
        const source = await open(
          join(this.directory, 'objects', file.sha256),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const output = await open(temporary, 'wx', 0o600);
          try {
            for await (const chunk of source.createReadStream({ autoClose: false })) {
              await this.assert();
              await output.writeFile(chunk);
            }
            await output.sync();
          } finally {
            await output.close();
          }
        } finally {
          await source.close();
        }
        const copied = await buddyFileHash(temporary);
        if (copied.sha256 !== file.sha256 || copied.size !== file.size)
          throw new Error('Recovery copy failed verification');
        if (await lstat(file.path).catch(() => null)) throw new Error('Recovery target appeared during publication');
        await this.assert();
        await rename(temporary, file.path);
        await flushBuddyDirectory(dirname(file.path));
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await this.state('files-ready');
  }
  async rollback(roots: string[], configuration: string[]) {
    await this.load();
    if (['database-ready', 'complete'].includes(this.journal.state))
      throw new Error('The restored database requires these files; finish recovery in maintenance mode');
    const directory = join(this.directory, 'publications');
    const shards = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    for (const shard of shards) {
      if (!/^[a-f0-9]{2}$/.test(shard)) throw new Error('Invalid recovery journal directory');
      for (const name of await readdir(join(directory, shard))) {
        if (/^\.tmp-[0-9a-f-]{36}$/.test(name)) continue;
        if (!BUDDY_ID.test(name) || !name.startsWith(shard)) throw new Error('Invalid recovery journal entry');
        const entry: Publication = JSON.parse(await readFile(join(directory, shard, name), 'utf8'));
        if (
          this.entryPath(entry.target) !== join(directory, shard, name) ||
          entry.rollback !== `${entry.target}.buddy-rollback-${this.id}` ||
          !BUDDY_ID.test(entry.sha256) ||
          (entry.previous !== null && !BUDDY_ID.test(entry.previous))
        )
          throw new Error('Invalid recovery journal entry');
        await this.assert();
        await buddyRecoveryTarget(entry.target, roots, configuration);
        await assertRecoveryCredentialPath(entry.rollback);
        const current = await lstat(entry.target).catch(() => null);
        if (current) {
          const evidence = await buddyFileHash(entry.target);
          if (evidence.sha256 === entry.previous) continue;
          if (evidence.sha256 !== entry.sha256 || evidence.size !== entry.size)
            throw new Error('Recovery target changed; automatic rollback stopped');
          await this.assert();
          await rm(entry.target);
          await flushBuddyDirectory(dirname(entry.target));
        }
        if (entry.previous) {
          const evidence = await buddyFileHash(entry.rollback);
          if (evidence.sha256 !== entry.previous || evidence.size !== entry.previousSize)
            throw new Error('Recovery rollback copy failed verification');
          await this.assert();
          await rename(entry.rollback, entry.target);
          await flushBuddyDirectory(dirname(entry.target));
        }
      }
    }
    await this.state('rolled-back');
  }
}
