import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type {
  FileIdentity,
  FilePort,
  ImportDeclaration,
  PreparedImport,
  PublicationKey,
} from 'src/utils/studio-import-publication.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { assertSameOwnedInode, syncAncestors } from 'src/utils/studio-import-durability.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

export interface DurabilityAdapter {
  readonly root: string;
  readonly anchor: string;
  requireQualified(root: string): Promise<void>;
  /** Only checked absence/count refusal use PUBLICATION_PATH_ABSENT/PUBLICATION_LINK_COUNT; propagate other errors. */
  capture(path: string, role?: 'stage' | 'linked'): Promise<FileIdentity>;
  hash(path: string, expected: FileIdentity): Promise<string>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  linkExclusive(stage: string, target: string): Promise<void>;
  unlinkExact(path: string, identity: FileIdentity): Promise<void>;
}

const inside = (root: string, path: string) => {
  const below = relative(root, path);
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes('\0') ||
    below === '..' ||
    below.startsWith(`..${sep}`) ||
    isAbsolute(below)
  ) {
    throw new Error('outside_durable_anchor');
  }
};
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const missing = (error: unknown) => errorCode(error) === 'ENOENT';
const absent = (error: unknown) => errorCode(error) === 'PUBLICATION_PATH_ABSENT';
const hasNamespaceIsolation = (value: unknown) => value === true;

export const STUDIO_IMPORT_DURABILITY_ADAPTER = Symbol('StudioImportDurabilityAdapter');

/** Internal port only. Journal locks, authority and reference gates belong to its caller. */
@Injectable()
export class StudioImportFileRepository implements FilePort {
  private durabilityAdapter?: DurabilityAdapter;
  constructor(@Optional() @Inject(STUDIO_IMPORT_DURABILITY_ADAPTER) adapter?: DurabilityAdapter) {
    this.durabilityAdapter = adapter;
  }

  private getAdapter(): DurabilityAdapter {
    return (this.durabilityAdapter ??= new LinuxDurabilityAdapter({
      root: StorageCore.getBaseFolder(StorageFolder.Exports),
      anchor: StorageCore.getBaseFolder(StorageFolder.Exports),
      qualification: () => Promise.reject(new Error('UNQUALIFIED')),
    }));
  }

  async prepare(key: PublicationKey, incoming: string, declaration: ImportDeclaration): Promise<PreparedImport> {
    if (
      [key.ownerId, key.projectId, key.importId, key.publicationId].some((value) => !isStudioUuid(value)) ||
      !/^\.[a-zA-Z0-9]+$/.test(declaration.extension)
    ) {
      throw new Error('invalid_publication_path');
    }
    const folder = join(this.getAdapter().root, key.ownerId, 'studio-imports');
    const stagedPath = incoming;
    const scratchName = basename(incoming);
    if (
      incoming !== join(folder, 'incoming', scratchName) ||
      !scratchName.endsWith('.upload') ||
      !isStudioUuid(scratchName.slice(0, -'.upload'.length))
    )
      throw new Error('invalid_publication_stage');
    const targetPath = join(folder, key.projectId, `${key.importId}${declaration.extension}`);
    await this.getAdapter().requireQualified(dirname(stagedPath));
    const identity = await this.getAdapter().capture(stagedPath);
    const file = { stagedPath, targetPath, identity, declaration };
    this.paths(file);
    await this.verify(stagedPath, file, 'stage');
    await this.getAdapter().syncFile(stagedPath);
    await this.barriers(dirname(stagedPath));
    await this.verify(stagedPath, file, 'stage');
    return file;
  }

  async publish(file: PreparedImport): Promise<void> {
    this.paths(file);
    await this.getAdapter().requireQualified(dirname(file.targetPath));
    await this.verify(file.stagedPath, file, 'linked');
    // Qualification attests active namespace isolation; mkdir alone is never that fence.
    await fs.mkdir(dirname(file.targetPath), { recursive: true, mode: 0o700 });
    await this.getAdapter().requireQualified(dirname(file.targetPath));
    try {
      await this.getAdapter().linkExclusive(file.stagedPath, file.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.verify(file.stagedPath, file, 'linked');
    await this.verify(file.targetPath, file, 'linked');
    await this.getAdapter().syncFile(file.targetPath);
    await this.barriers(dirname(file.targetPath));
    await this.verify(file.stagedPath, file, 'linked');
    await this.verify(file.targetPath, file, 'linked');
  }

  async release(file: PreparedImport, role: 'stage' | 'aborted'): Promise<void> {
    this.paths(file);
    if (role !== 'stage' && role !== 'aborted') throw new Error('invalid_publication_role');
    await this.getAdapter().requireQualified(this.getAdapter().root);
    // Task 6 must count references for each exact role under its common path locks first.
    for (const path of role === 'stage' ? [file.stagedPath] : [file.targetPath, file.stagedPath]) {
      try {
        await this.getAdapter().capture(path);
      } catch (error) {
        if (errorCode(error) === 'PUBLICATION_LINK_COUNT') {
          // Two links are owned only when they are this exact intent's stage/target pair.
          await this.verify(file.stagedPath, file, 'linked');
          await this.verify(file.targetPath, file, 'linked');
        } else if (!absent(error)) {
          throw error;
        }
      }
      try {
        await this.verify(path, file, 'linked');
      } catch (error) {
        if (!absent(error)) throw error;
      }
      await this.getAdapter().unlinkExact(path, file.identity);
      await this.barriers(dirname(path));
      try {
        await this.getAdapter().capture(path);
        throw new Error('publication_identity_changed');
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
  }

  private paths(file: PreparedImport) {
    inside(this.getAdapter().anchor, this.getAdapter().root);
    inside(this.getAdapter().root, file.stagedPath);
    inside(this.getAdapter().root, file.targetPath);
    const size = file.identity.size;
    const stage = relative(this.getAdapter().root, file.stagedPath).split(sep);
    const target = relative(this.getAdapter().root, file.targetPath).split(sep);
    if (
      stage.length !== 4 ||
      target.length !== 4 ||
      !isStudioUuid(stage[0]) ||
      stage[0] !== target[0] ||
      stage[1] !== 'studio-imports' ||
      target[1] !== 'studio-imports' ||
      stage[2] !== 'incoming' ||
      !isStudioUuid(stage[3].replace(/\.upload$/, '')) ||
      !stage[3].endsWith('.upload') ||
      !isStudioUuid(target[2]) ||
      !/^\.[a-zA-Z0-9]+$/.test(file.declaration.extension) ||
      !isStudioUuid(target[3].slice(0, -file.declaration.extension.length)) ||
      !target[3].endsWith(file.declaration.extension) ||
      !Number.isSafeInteger(file.identity.size) ||
      size < 0 ||
      file.identity.size !== file.declaration.sizeBytes ||
      !/^[a-f0-9]{64}$/.test(file.declaration.checksum) ||
      (file.declaration.processingProvenance &&
        file.declaration.processingProvenance.outputSha256 !== file.declaration.checksum)
    ) {
      throw new Error('invalid_publication_file');
    }
  }

  private async verify(path: string, file: PreparedImport, role: 'stage' | 'linked') {
    assertSameOwnedInode(file.identity, await this.getAdapter().capture(path, role));
    if ((await this.getAdapter().hash(path, file.identity)) !== file.declaration.checksum)
      throw new Error('publication_hash_changed');
    assertSameOwnedInode(file.identity, await this.getAdapter().capture(path, role));
  }

  private barriers(path: string) {
    return syncAncestors(path, this.getAdapter().anchor, (directory) => this.getAdapter().syncDirectory(directory));
  }
}

export type LinuxDurabilityQualification = {
  root: string;
  anchor: string;
  rootIdentity: FileIdentity;
  anchorIdentity: FileIdentity;
  rootMountId: string;
  anchorMountId: string;
  evidenceId: string;
  /** Authority must maintain this isolation for the entire journal-owned intent lifetime. */
  namespaceIsolated: true;
};
export type LinuxDurabilityOptions = {
  root: string;
  anchor: string;
  /** Validates current version/configuration and dated stable-storage evidence; never an administrator toggle. */
  qualification: () => Promise<LinuxDurabilityQualification>;
};
type CheckedDirectory = { path: string; handle: FileHandle; stat: BigIntStats; mount: string };
const identity = (stat: BigIntStats): FileIdentity => {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('publication_identity_changed');
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) };
};
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && b.isDirectory();
const sameVersion = (a: BigIntStats, b: BigIntStats) => {
  assertSameOwnedInode(identity(a), identity(b));
  if (a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs || a.nlink !== b.nlink)
    throw new Error('publication_identity_changed');
};
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

/** Linux primitives only: syscall success is never a deployment qualification record. */
export class LinuxDurabilityAdapter implements DurabilityAdapter {
  readonly root: string;
  readonly anchor: string;
  private readonly sealed = new Map<string, { dev: bigint; ino: bigint; mount: string }>();

  constructor(private readonly options?: LinuxDurabilityOptions) {
    this.root = options?.root ?? '';
    this.anchor = options?.anchor ?? '';
  }

  async requireQualified(path: string): Promise<void> {
    const record = await this.record();
    inside(this.anchor, path);
    const chain = await this.directories(path, record, true);
    try {
      await this.checkDirectories(chain, record);
    } finally {
      await this.close(chain);
    }
  }

  async capture(path: string, role: 'stage' | 'linked' = 'stage'): Promise<FileIdentity> {
    return this.file(path, role, (_handle, stat) => Promise.resolve(identity(stat)));
  }

  async hash(path: string, expected: FileIdentity): Promise<string> {
    return this.file(path, 'linked', async (handle, stat) => {
      assertSameOwnedInode(expected, identity(stat));
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      return hash.digest('hex');
    });
  }

  async syncFile(path: string): Promise<void> {
    await this.file(path, 'linked', (handle) => handle.sync());
  }

  async syncDirectory(path: string): Promise<void> {
    const record = await this.record();
    inside(this.anchor, path);
    // Aborted prepare may have no target hierarchy: flush its nearest existing parent instead.
    const chain = await this.directories(path, record, true);
    try {
      await chain.at(-1)!.handle.sync();
      await this.checkDirectories(chain, record);
    } finally {
      await this.close(chain);
    }
  }

  async linkExclusive(stage: string, target: string): Promise<void> {
    const record = await this.record();
    inside(this.root, stage);
    inside(this.root, target);
    const source = await this.directories(dirname(stage), record);
    let destination: CheckedDirectory[] = [];
    try {
      destination = await this.directories(dirname(target), record);
      const from = `${fdPath(source.at(-1)!.handle)}/${basename(stage)}`;
      const to = `${fdPath(destination.at(-1)!.handle)}/${basename(target)}`;
      const handle = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat({ bigint: true });
        this.regular(before, 'linked');
        if ((await this.mount(handle)) !== record.rootMountId) throw new Error('publication_mount_changed');
        if (before.nlink !== 1n) {
          try {
            await fs.lstat(to, { bigint: true });
          } catch (error) {
            if (missing(error)) throw new Error('publication_identity_changed', { cause: error });
            throw error;
          }
        }
        assertSameOwnedInode(identity(before), identity(await fs.lstat(from, { bigint: true })));
        await this.checkDirectories(source, record);
        await this.checkDirectories(destination, record);
        await fs.link(from, to);
        const after = await handle.stat({ bigint: true });
        this.regular(after, 'linked');
        if (after.nlink !== 2n) throw new Error('publication_identity_changed');
        assertSameOwnedInode(identity(before), identity(after));
        assertSameOwnedInode(identity(before), identity(await fs.lstat(to, { bigint: true })));
        await this.checkDirectories(source, record);
        await this.checkDirectories(destination, record);
      } finally {
        await handle.close();
      }
    } finally {
      try {
        await this.close(destination);
      } finally {
        await this.close(source);
      }
    }
  }

  async unlinkExact(path: string, expected: FileIdentity): Promise<void> {
    const record = await this.record();
    inside(this.root, path);
    const chain = await this.directories(dirname(path), record, true);
    try {
      if (chain.at(-1)!.path !== dirname(path)) return;
      const checked = `${fdPath(chain.at(-1)!.handle)}/${basename(path)}`;
      let handle: FileHandle;
      try {
        handle = await fs.open(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (missing(error)) {
          await this.checkDirectories(chain, record);
          return;
        }
        throw error;
      }
      try {
        const stat = await handle.stat({ bigint: true });
        this.regular(stat, 'linked');
        assertSameOwnedInode(expected, identity(stat));
        if ((await this.mount(handle)) !== record.rootMountId) throw new Error('publication_mount_changed');
        const current = await fs.lstat(checked, { bigint: true });
        this.regular(current, 'linked');
        sameVersion(stat, current);
        await this.checkDirectories(chain, record);
        // Node has no conditional unlink; active qualified namespace isolation is mandatory.
        await fs.unlink(checked);
        await this.checkDirectories(chain, record);
        try {
          await fs.lstat(checked, { bigint: true });
          throw new Error('publication_identity_changed');
        } catch (error) {
          if (!missing(error)) throw error;
        }
      } finally {
        await handle.close();
      }
    } finally {
      await this.close(chain);
    }
  }

  private async record(): Promise<LinuxDurabilityQualification> {
    if (!this.options || platform() !== 'linux') throw new Error('UNQUALIFIED');
    inside(this.anchor, this.root);
    const record = await this.options.qualification();
    if (
      record.root !== this.root ||
      record.anchor !== this.anchor ||
      !hasNamespaceIsolation(record.namespaceIsolated) ||
      !record.evidenceId ||
      !record.rootMountId ||
      !record.anchorMountId
    )
      throw new Error('UNQUALIFIED');
    return record;
  }

  private regular(stat: BigIntStats, role: 'stage' | 'linked') {
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n)
      throw new Error('publication_identity_changed');
    if (role === 'stage' ? stat.nlink !== 1n : stat.nlink < 1n || stat.nlink > 2n) {
      throw Object.assign(new Error('publication_identity_changed'), { code: 'PUBLICATION_LINK_COUNT' });
    }
  }

  private async mount(handle: FileHandle): Promise<string> {
    const value = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const mount = /^mnt_id:\s+(\d+)$/m.exec(value)?.[1];
    if (!mount) throw new Error('publication_mount_changed');
    return mount;
  }

  private async directories(path: string, record: LinuxDurabilityQualification, allowMissing = false) {
    const chain: CheckedDirectory[] = [];
    try {
      for (const part of ['/', ...path.slice(1).split('/').filter(Boolean)]) {
        const previous = chain.at(-1);
        const current = previous ? join(previous.path, part) : '/';
        const checked = previous ? `${fdPath(previous.handle)}/${part}` : '/';
        let handle: FileHandle;
        try {
          handle = await fs.open(checked, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        } catch (error) {
          if (
            allowMissing &&
            missing(error) &&
            !this.sealed.has(current) &&
            current !== this.root &&
            current.startsWith(`${this.root}/`)
          )
            break;
          throw error;
        }
        let entry: CheckedDirectory;
        try {
          entry = { path: current, handle, stat: await handle.stat({ bigint: true }), mount: await this.mount(handle) };
        } catch (error) {
          await handle.close();
          throw error;
        }
        chain.push(entry);
        if (!entry.stat.isDirectory()) throw new Error('publication_identity_changed');
        if (
          (current === this.root || current.startsWith(`${this.root}/`)) &&
          (entry.stat.uid !== BigInt(process.getuid!()) ||
            (entry.stat.mode & 0o022n) !== 0n ||
            entry.mount !== record.rootMountId)
        )
          throw new Error('publication_mount_changed');
        const old = this.sealed.get(current);
        if (old && (old.dev !== entry.stat.dev || old.ino !== entry.stat.ino || old.mount !== entry.mount))
          throw new Error('publication_identity_changed');
        this.sealed.set(current, { dev: entry.stat.dev, ino: entry.stat.ino, mount: entry.mount });
      }
      await this.checkDirectories(chain, record);
      return chain;
    } catch (error) {
      await this.close(chain);
      throw error;
    }
  }

  private async checkDirectories(chain: CheckedDirectory[], record: LinuxDurabilityQualification) {
    for (const [index, entry] of chain.entries()) {
      const handleStat = await entry.handle.stat({ bigint: true });
      const pathStat = await fs.lstat(entry.path, { bigint: true });
      if (
        !sameDirectory(entry.stat, handleStat) ||
        !sameDirectory(entry.stat, pathStat) ||
        (await this.mount(entry.handle)) !== entry.mount
      )
        throw new Error('publication_identity_changed');
      if (
        (entry.path === this.root || entry.path.startsWith(`${this.root}/`)) &&
        (handleStat.uid !== BigInt(process.getuid!()) ||
          pathStat.uid !== handleStat.uid ||
          (handleStat.mode & 0o022n) !== 0n ||
          (pathStat.mode & 0o022n) !== 0n)
      )
        throw new Error('publication_identity_changed');
      const parent = chain[index - 1];
      const reopened = await fs.open(
        parent ? `${fdPath(parent.handle)}/${basename(entry.path)}` : '/',
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      try {
        if (!sameDirectory(entry.stat, await reopened.stat({ bigint: true })))
          throw new Error('publication_identity_changed');
        if ((await this.mount(reopened)) !== entry.mount) throw new Error('publication_mount_changed');
      } finally {
        await reopened.close();
      }
      if (entry.path === this.root || entry.path === this.anchor) {
        const root = entry.path === this.root;
        const expected = root ? record.rootIdentity : record.anchorIdentity;
        if (
          String(handleStat.dev) !== expected.dev ||
          String(handleStat.ino) !== expected.ino ||
          entry.mount !== (root ? record.rootMountId : record.anchorMountId)
        )
          throw new Error('publication_mount_changed');
      }
    }
    if (chain.every((entry) => entry.path !== this.anchor)) throw new Error('outside_durable_anchor');
  }

  private async file<T>(
    path: string,
    role: 'stage' | 'linked',
    operation: (handle: FileHandle, stat: BigIntStats) => Promise<T>,
  ) {
    const record = await this.record();
    inside(this.root, path);
    const chain = await this.directories(dirname(path), record, true);
    try {
      if (chain.at(-1)!.path !== dirname(path)) {
        throw Object.assign(new Error('publication_path_absent'), { code: 'PUBLICATION_PATH_ABSENT' });
      }
      const checked = `${fdPath(chain.at(-1)!.handle)}/${basename(path)}`;
      let handle: FileHandle;
      try {
        handle = await fs.open(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (!missing(error)) throw error;
        await this.checkDirectories(chain, record);
        try {
          await fs.lstat(checked, { bigint: true });
        } catch (error_) {
          if (missing(error_))
            throw Object.assign(new Error('publication_path_absent', { cause: error_ }), {
              code: 'PUBLICATION_PATH_ABSENT',
            });
          throw error_;
        }
        throw new Error('publication_identity_changed', { cause: error });
      }
      try {
        const before = await handle.stat({ bigint: true });
        this.regular(before, role);
        if ((await this.mount(handle)) !== record.rootMountId) throw new Error('publication_mount_changed');
        const result = await operation(handle, before);
        const after = await handle.stat({ bigint: true });
        this.regular(after, role);
        sameVersion(before, after);
        const current = await fs.lstat(path, { bigint: true });
        this.regular(current, role);
        sameVersion(after, current);
        const reopened = await fs.open(
          `${fdPath(chain.at(-1)!.handle)}/${basename(path)}`,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const reopenedStat = await reopened.stat({ bigint: true });
          this.regular(reopenedStat, role);
          sameVersion(after, reopenedStat);
          if ((await this.mount(reopened)) !== record.rootMountId) throw new Error('publication_mount_changed');
        } finally {
          await reopened.close();
        }
        await this.checkDirectories(chain, record);
        if ((await this.mount(handle)) !== record.rootMountId) throw new Error('publication_mount_changed');
        return result;
      } finally {
        await handle.close();
      }
    } finally {
      await this.close(chain);
    }
  }

  private async close(chain: CheckedDirectory[]) {
    const results = await Promise.allSettled(chain.toReversed().map((entry) => entry.handle.close()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
