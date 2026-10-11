import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinuxDurabilityQualification } from 'src/repositories/studio-import-file.repository.js';
import { LinuxDurabilityAdapter, StudioImportFileRepository } from 'src/repositories/studio-import-file.repository.js';
import { assertSameOwnedInode } from 'src/utils/studio-import-durability.js';
import { DECLARATION, KEY } from 'test/fixtures/studio-import-retention.js';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ platform: vi.fn(() => 'linux') }));
vi.mock('node:fs/promises', () => native);
vi.mock('node:os', () => runtime);

const root = '/exports';
const owner = join(root, KEY.ownerId);
const incoming = join(owner, 'studio-imports/incoming');
const stage = join(incoming, `${KEY.publicationId}.upload`);
const project = join(owner, 'studio-imports', KEY.projectId);
const target = join(project, `${KEY.importId}.mp4`);
const bytes = Buffer.from('test');
const checksum = createHash('sha256').update(bytes).digest('hex');
const declaration = {
  ...DECLARATION,
  checksum,
  processingProvenance: { ...DECLARATION.processingProvenance, outputSha256: checksum },
};
const error = (code: string) => Object.assign(new Error(code), { code });
type Entry = {
  ino: bigint;
  dev: bigint;
  size: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  kind: 'file' | 'directory' | 'symlink';
  mount: string;
  bytes: Buffer;
};

/** Synthetic syscall/handle simulation only: never Linux, mount or storage qualification evidence. */
function syntheticLinux() {
  const entries = new Map<string, Entry>();
  const handles = new Map<number, { path: string; entry: Entry }>();
  const events: string[] = [];
  let ino = 0n;
  let fd = 10;
  const add = (path: string, kind: Entry['kind'] = 'directory') => {
    const entry = {
      ino: ++ino,
      dev: 1n,
      size: kind === 'file' ? 4n : 0n,
      uid: BigInt(process.getuid!()),
      mode: kind === 'file' ? 0o600n : 0o700n,
      nlink: 1n,
      mtimeNs: 1n,
      ctimeNs: 1n,
      kind,
      mount: '7',
      bytes,
    };
    entries.set(path, entry);
    return entry;
  };
  for (const path of ['/', root, owner, join(owner, 'studio-imports'), incoming]) add(path);
  add(stage, 'file');
  const stat = (entry: Entry) => ({
    ...entry,
    isDirectory: () => entry.kind === 'directory',
    isFile: () => entry.kind === 'file',
  });
  const actual = (path: string) => {
    const match = /^\/proc\/self\/fd\/(\d+)\/(.*)$/.exec(path);
    return match ? join(handles.get(Number(match[1]))!.path, match[2]) : path;
  };
  const get = (path: string) => {
    const entry = entries.get(actual(path));
    if (!entry) throw error('ENOENT');
    return entry;
  };
  const hooks = {
    sync: (_path: string) => {},
    open: (_path: string) => {},
    lstat: (_path: string) => {},
    read: (_path: string) => {},
    linkCode: '',
  };
  native.open.mockImplementation((path: string, flags: number) => {
    path = actual(path);
    hooks.open(path);
    const entry = get(path);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    if (entry.kind === 'symlink') throw error('ELOOP');
    if (flags & constants.O_DIRECTORY && entry.kind !== 'directory') throw error('ENOTDIR');
    const opened = ++fd;
    handles.set(opened, { path, entry });
    return Promise.resolve({
      fd: opened,
      stat: () => Promise.resolve(stat(entry)),
      sync: () => {
        events.push(`sync:${path}`);
        hooks.sync(path);
        return Promise.resolve();
      },
      close: () => {
        handles.delete(opened);
        return Promise.resolve();
      },
      createReadStream: () =>
        (async function* () {
          hooks.read(path);
          await Promise.resolve();
          yield entry.bytes;
        })(),
    });
  });
  native.lstat.mockImplementation((path: string) => {
    path = actual(path);
    hooks.lstat(path);
    return Promise.resolve(stat(get(path)));
  });
  native.readFile.mockImplementation((path: string) => {
    const opened = Number(path.split('/').at(-1));
    return Promise.resolve(`mnt_id:\t${handles.get(opened)!.entry.mount}\n`);
  });
  native.mkdir.mockImplementation((path: string) => {
    events.push(`mkdir:${path}`);
    const missing: string[] = [];
    for (let at = path; !entries.has(at); at = dirname(at)) missing.unshift(at);
    for (const at of missing) add(at);
    return Promise.resolve();
  });
  native.link.mockImplementation((from: string, to: string) => {
    from = actual(from);
    to = actual(to);
    events.push(`link:${to}`);
    if (hooks.linkCode) throw error(hooks.linkCode);
    if (entries.has(to)) throw error('EEXIST');
    const entry = get(from);
    entries.set(to, entry);
    entry.nlink++;
    return Promise.resolve();
  });
  native.unlink.mockImplementation((path: string) => {
    path = actual(path);
    events.push(`unlink:${path}`);
    const entry = get(path);
    entries.delete(path);
    entry.nlink--;
    return Promise.resolve();
  });
  const rootIdentity = { dev: '1', ino: String(entries.get(root)!.ino), size: 0 };
  const qualification = vi.fn((): Promise<LinuxDurabilityQualification> =>
    Promise.resolve({
      root,
      anchor: root,
      rootIdentity,
      anchorIdentity: rootIdentity,
      rootMountId: '7',
      anchorMountId: '7',
      evidenceId: 'SYNTHETIC-NOT-A-QUALIFICATION',
      namespaceIsolated: true,
    }),
  );
  const adapter = new LinuxDurabilityAdapter({ root, anchor: root, qualification });
  const repository = new StudioImportFileRepository(adapter);
  return { adapter, repository, entries, handles, events, hooks, qualification, add };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.platform.mockReturnValue('linux');
});

describe('unqualified deployment refusal', () => {
  it('has no default deployment qualification', async () => {
    await expect(new LinuxDurabilityAdapter().requireQualified(root)).rejects.toThrow('UNQUALIFIED');
    expect(native.open).not.toHaveBeenCalled();
  });
  it.each(['APFS-host-bind', 'shfs', 'ext4', 'ZFS'])(
    'refuses a missing record for %s without filesystem-name admission',
    async () => {
      const fake = syntheticLinux();
      fake.qualification.mockRejectedValue(new Error('UNQUALIFIED'));
      await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('UNQUALIFIED');
      expect(native.open).not.toHaveBeenCalled();
      expect(native.link).not.toHaveBeenCalled();
    },
  );
  it('does not substitute Linux barriers for a native Darwin runtime', async () => {
    const fake = syntheticLinux();
    runtime.platform.mockReturnValue('darwin');
    await expect(fake.adapter.requireQualified(root)).rejects.toThrow('UNQUALIFIED');
    expect(native.open).not.toHaveBeenCalled();
  });
  it.each([false, 'claimed', 1, null])(
    'refuses a record without literal active namespace isolation: %j',
    async (namespaceIsolated) => {
      const fake = syntheticLinux();
      const record = await fake.qualification();
      fake.qualification.mockResolvedValue({
        ...record,
        namespaceIsolated,
      } as unknown as LinuxDurabilityQualification);
      await expect(fake.adapter.requireQualified(root)).rejects.toThrow('UNQUALIFIED');
    },
  );
});

describe('FilePort and Linux primitives with synthetic checked handles', () => {
  it('hashes staged bytes, syncs the complete incoming ancestry, and links only in publish', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    expect(prepared.identity.size).toBe(4);
    expect(prepared.declaration.checksum).toBe(checksum);
    expect(fake.events).toEqual([
      `sync:${stage}`,
      `sync:${incoming}`,
      `sync:${join(owner, 'studio-imports')}`,
      `sync:${owner}`,
      `sync:${root}`,
    ]);
    expect(native.link).not.toHaveBeenCalled();
    fake.events.length = 0;
    await fake.repository.publish(prepared);
    expect(fake.events).toEqual([
      `mkdir:${project}`,
      `link:${target}`,
      `sync:${target}`,
      `sync:${project}`,
      `sync:${join(owner, 'studio-imports')}`,
      `sync:${owner}`,
      `sync:${root}`,
    ]);
    expect(native.link.mock.calls[0].every((path: string) => path.startsWith('/proc/self/fd/'))).toBe(true);
    expect(fake.entries.get(stage)).toBe(fake.entries.get(target));
    expect(fake.handles.size).toBe(0);
  });
  it('rejects noncanonical stage and extension without touching the filesystem', async () => {
    const fake = syntheticLinux();
    await expect(fake.repository.prepare(KEY, `${stage}/../foreign`, declaration)).rejects.toThrow(
      'invalid_publication_stage',
    );
    await expect(fake.repository.prepare(KEY, stage, { ...declaration, extension: '../mp4' })).rejects.toThrow(
      'invalid_publication_path',
    );
    expect(native.open).not.toHaveBeenCalled();
    expect(native.mkdir).not.toHaveBeenCalled();
  });
  it('refuses an outside-root prepared path before mutation', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await expect(fake.repository.publish({ ...prepared, targetPath: '/elsewhere/import.mp4' })).rejects.toThrow(
      'outside_durable_anchor',
    );
    expect(native.mkdir).not.toHaveBeenCalled();
    expect(native.link).not.toHaveBeenCalled();
  });
  it('rejects pre-link multiply linked stages', async () => {
    const fake = syntheticLinux();
    fake.entries.get(stage)!.nlink = 2n;
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('publication_identity_changed');
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('rejects a declaration whose hash does not match the staged bytes', async () => {
    const fake = syntheticLinux();
    await expect(
      fake.repository.prepare(KEY, stage, { ...declaration, checksum: 'ab'.repeat(32), processingProvenance: null }),
    ).rejects.toThrow('publication_hash_changed');
    expect(fake.events).toEqual([]);
    expect(fake.handles.size).toBe(0);
  });
  it('detects staged-byte mutation while hashing', async () => {
    const fake = syntheticLinux();
    fake.hooks.read = () => {
      fake.entries.get(stage)!.mtimeNs++;
    };
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('publication_identity_changed');
    expect(fake.events).toEqual([]);
    expect(fake.handles.size).toBe(0);
  });
  it.each(['EINVAL', 'ENOTSUP', 'EPERM'])(
    'stops before namespace or target publication on file sync %s',
    async (code) => {
      const fake = syntheticLinux();
      fake.hooks.sync = (path) => {
        if (path === stage) throw error(code);
      };
      await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow(code);
      expect(fake.events).toEqual([`sync:${stage}`]);
      expect(native.link).not.toHaveBeenCalled();
      expect(fake.handles.size).toBe(0);
    },
  );
  it('stops new owner ancestry at a failed incoming parent barrier', async () => {
    const fake = syntheticLinux();
    fake.hooks.sync = (path) => {
      if (path === owner) throw new Error('directory_barrier_failed');
    };
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('directory_barrier_failed');
    expect(fake.events).not.toContain(`sync:${root}`);
    expect(native.link).not.toHaveBeenCalled();
  });
  it.each(['EXDEV', 'EINVAL', 'ENOTSUP', 'EPERM'])(
    'refuses exclusive link %s without copy/rename fallback',
    async (code) => {
      const fake = syntheticLinux();
      const prepared = await fake.repository.prepare(KEY, stage, declaration);
      fake.hooks.linkCode = code;
      await expect(fake.repository.publish(prepared)).rejects.toThrow(code);
      expect(fake.entries.has(target)).toBe(false);
      expect(fake.entries.has(stage)).toBe(true);
      expect(native.unlink).not.toHaveBeenCalled();
      expect(fake.handles.size).toBe(0);
    },
  );
  it('never adopts or deletes a same-hash foreign inode at the target', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.add(project);
    const foreign = fake.add(target, 'file');
    await expect(fake.repository.publish(prepared)).rejects.toThrow('publication_identity_changed');
    expect(fake.entries.get(target)).toBe(foreign);
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('reconciles an exact intent inode after an interrupted link and a fresh adapter', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.hooks.sync = (path) => {
      if (path === target) throw error('EIO');
    };
    await expect(fake.repository.publish(prepared)).rejects.toThrow('EIO');
    fake.hooks.sync = () => {};
    const fresh = new StudioImportFileRepository(
      new LinuxDurabilityAdapter({ root, anchor: root, qualification: fake.qualification }),
    );
    await fresh.publish(prepared);
    expect(fake.entries.get(stage)!.nlink).toBe(2n);
    expect(fake.entries.get(stage)).toBe(fake.entries.get(target));
    expect(fake.handles.size).toBe(0);
  });
  it('refuses a two-link stage with an absent target without creating a third link', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.entries.get(stage)!.nlink = 2n;
    await expect(fake.repository.publish(prepared)).rejects.toThrow('publication_identity_changed');
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.entries.has(target)).toBe(false);
  });
  it('rejects symlink directories and leaves the stage intact', async () => {
    const fake = syntheticLinux();
    fake.entries.get(incoming)!.kind = 'symlink';
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('ELOOP');
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('rejects a parent directory replaced during file sync', async () => {
    const fake = syntheticLinux();
    fake.hooks.sync = (path) => {
      if (path === stage) fake.add(incoming);
    };
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('publication_identity_changed');
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('rejects a mount identity changed between prepare and publication', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.entries.get(root)!.mount = '8';
    await expect(fake.repository.publish(prepared)).rejects.toThrow('publication_mount_changed');
    expect(native.mkdir).not.toHaveBeenCalled();
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('detects a same-inode mount rebind during a file barrier', async () => {
    const fake = syntheticLinux();
    fake.hooks.sync = (path) => {
      if (path !== stage) {
        return;
      }

      const prior = fake.entries.get(root)!;
      fake.entries.set(root, { ...prior, mount: '8' });
    };
    await expect(fake.adapter.syncFile(stage)).rejects.toThrow('publication_mount_changed');
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('detects directory permissions becoming public during a file barrier', async () => {
    const fake = syntheticLinux();
    fake.hooks.sync = (path) => {
      if (path === stage) fake.entries.get(owner)!.mode = 0o777n;
    };
    await expect(fake.adapter.syncFile(stage)).rejects.toThrow('publication_identity_changed');
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('rejects a file mount change without mistaking matching dev/ino for mount authority', async () => {
    const fake = syntheticLinux();
    fake.entries.get(stage)!.mount = '8';
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('publication_mount_changed');
    expect(fake.handles.size).toBe(0);
  });
  it('detects a same-inode file mount rebind during a file barrier', async () => {
    const fake = syntheticLinux();
    fake.hooks.sync = (path) => {
      if (path !== stage) {
        return;
      }

      const prior = fake.entries.get(stage)!;
      fake.entries.set(stage, { ...prior, mount: '8' });
    };
    await expect(fake.adapter.syncFile(stage)).rejects.toThrow('publication_mount_changed');
    expect(fake.handles.size).toBe(0);
  });
  it('refuses to unlink through a foreign file mount despite matching inode identity', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.entries.get(stage)!.mount = '8';
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('publication_mount_changed');
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('rejects a stage symlink without following it', async () => {
    const fake = syntheticLinux();
    fake.entries.get(stage)!.kind = 'symlink';
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow('ELOOP');
    expect(fake.handles.size).toBe(0);
  });
  it('rejects writable-by-others private directories', async () => {
    const fake = syntheticLinux();
    fake.entries.get(owner)!.mode = 0o777n;
    await expect(fake.repository.prepare(KEY, stage, declaration)).rejects.toThrow();
    expect(native.link).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('releases only the stage after publication, preserving the ready target', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await fake.repository.publish(prepared);
    fake.events.length = 0;
    await fake.repository.release(prepared, 'stage');
    expect(fake.events).toEqual([
      `unlink:${stage}`,
      `sync:${incoming}`,
      `sync:${join(owner, 'studio-imports')}`,
      `sync:${owner}`,
      `sync:${root}`,
    ]);
    expect(fake.entries.has(stage)).toBe(false);
    expect(fake.entries.get(target)!.nlink).toBe(1n);
    expect(fake.handles.size).toBe(0);
  });
  it('retains cleanup failure after unlink and can retry exact absence with all barriers', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await fake.repository.publish(prepared);
    fake.hooks.sync = (path) => {
      if (path === incoming) throw new Error('unlink_barrier_failed');
    };
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('unlink_barrier_failed');
    expect(fake.entries.has(stage)).toBe(false);
    expect(fake.entries.has(target)).toBe(true);
    fake.hooks.sync = () => {};
    await fake.repository.release(prepared, 'stage');
    expect(fake.events.at(-1)).toBe(`sync:${root}`);
    expect(fake.entries.has(target)).toBe(true);
    expect(fake.handles.size).toBe(0);
  });
  it('individually cleans aborted links and never recursively removes directories', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await fake.repository.publish(prepared);
    await fake.repository.release(prepared, 'aborted');
    expect(fake.events.filter((event) => event.startsWith('unlink:'))).toEqual([`unlink:${target}`, `unlink:${stage}`]);
    expect(fake.entries.has(project)).toBe(true);
    expect(fake.handles.size).toBe(0);
  });
  it('can clean an aborted prepare that never created a target hierarchy', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await fake.repository.release(prepared, 'aborted');
    expect(fake.entries.has(stage)).toBe(false);
    expect(native.mkdir).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('refuses replacement cleanup even if the replacement has identical bytes', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    const foreign = fake.add(stage, 'file');
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('publication_identity_changed');
    expect(fake.entries.get(stage)).toBe(foreign);
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('does not remove an owned inode whose staged bytes changed after prepare', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.entries.get(stage)!.bytes = Buffer.from('evil');
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('publication_hash_changed');
    expect(fake.entries.has(stage)).toBe(true);
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('defers stage cleanup when its second hardlink is not the owned target', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    fake.entries.get(stage)!.nlink = 2n;
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow();
    expect(fake.entries.has(stage)).toBe(true);
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('propagates capture I/O failure instead of treating it as a link-count reconciliation', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await fake.repository.publish(prepared);
    vi.spyOn(fake.adapter, 'capture').mockRejectedValueOnce(error('EIO'));
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('EIO');
    expect(fake.entries.has(stage)).toBe(true);
    expect(native.unlink).not.toHaveBeenCalled();
  });
  it('does not confuse an unexpected hashing ENOENT with exact owned path absence', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    vi.spyOn(fake.adapter, 'hash').mockRejectedValueOnce(error('ENOENT'));
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('ENOENT');
    expect(fake.entries.has(stage)).toBe(true);
    expect(native.unlink).not.toHaveBeenCalled();
  });
  it('refuses unrelated extra hardlinks after intentional publication', async () => {
    const fake = syntheticLinux();
    const prepared = await fake.repository.prepare(KEY, stage, declaration);
    await fake.repository.publish(prepared);
    fake.entries.get(stage)!.nlink = 3n;
    await expect(fake.repository.release(prepared, 'stage')).rejects.toThrow('publication_identity_changed');
    expect(native.unlink).not.toHaveBeenCalled();
    expect(fake.handles.size).toBe(0);
  });
  it('rechecks the exact inode pair independently of checksum equality', () => {
    expect(() => assertSameOwnedInode({ dev: '1', ino: '2', size: 4 }, { dev: '1', ino: '3', size: 4 })).toThrow();
  });
});
