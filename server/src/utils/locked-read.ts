import { decryptFile, isLockedFile, keyId as toKeyId, openDecrypt, readHeader } from '@frameleaf/locked-crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { queueExecution } from 'src/queue/context.js';
import { type HeldKey, lockedKeys } from 'src/utils/locked-key-holder.js';

/**
 * FL-721 (spec §8): the two ways a reader opens a file that may be encrypted.
 *
 * - `openLockedRead` gives a decrypting stream (HTTP responses, zip entries, anything that takes a
 *   stream). Range reads decrypt only the segments they cover.
 * - `withPlainCopy` gives a tool (ffmpeg, sharp, exiftool, ML) a plain path: a temporary copy in the
 *   RAM-backed `FRAMELEAF_LOCKED_TMP`, deleted in `finally`. A plain path passes straight through.
 *
 * Which key is used: the file header's key ids only pick which loaded private key to try. They are
 * never an access list. Whether a viewer may see the asset at all is the caller's access check
 * (ownership and partner rules); the key holder's `canRead` then decides whether that viewer may use
 * the key (their own, or an owner's they were granted). A background job (`viewerId` null) may use
 * any loaded key.
 *
 * Both throw `LockedKeyUnavailableError` when no usable key is loaded. Inside a job that is a
 * deferral, not a failure (`deferForLockedKey`); a request answers 423 (`sendFile`).
 */

/** The default RAM-backed folder for plain copies (spec §8). */
export const DEFAULT_LOCKED_TMP = '/dev/shm/frameleaf-locked';
/** How long a job waits for a key before it runs again on its own (woken earlier by a key load). */
export const LOCKED_DEFERRAL_DELAY_MS = 60 * 60 * 1000;
/** A job waits for a key at most this many times (one hour each), then fails as usual. */
export const LOCKED_DEFERRAL_MAX_ATTEMPTS = 72;

/**
 * Whether an operation-owned job (an Activity edit, a restoration) may wait for a Locked key once
 * more. Operations re-queue themselves for `LOCKED_DEFERRAL_DELAY_MS` and give the attempt back, so
 * the cap of `LOCKED_DEFERRAL_MAX_ATTEMPTS` waits is kept as the same ceiling in time: 72 hours after
 * the operation was created it fails as usual.
 * ponytail: operations are not woken early by a key load; they run again at their next hourly retry.
 */
export const lockedOperationMayWait = (createdAt: Date | string | number, now = Date.now()) =>
  now - new Date(createdAt).getTime() < LOCKED_DEFERRAL_DELAY_MS * LOCKED_DEFERRAL_MAX_ATTEMPTS;

/**
 * FL-721 (spec §6.2): why a partner's read of another person's encrypted file is refused, so a client
 * doesn't ask them for their own PIN: `owner-passphrase` (an Advanced Security owner's item, opened by
 * typing that owner's passphrase) or `not-ready` (no entry for them yet, or no longer a partner).
 */
export type LockedPartnerReason = 'not-ready' | 'owner-passphrase';

/** No loaded key that this viewer may use opens the file. `ownerIds` are the recipients' people, when known. */
export class LockedKeyUnavailableError extends Error {
  name = 'LockedKeyUnavailableError';
  readonly code = 'locked_key_unavailable';
  /** Set when the viewer reads another person's file as their partner (spec §6.2). */
  reason?: LockedPartnerReason;
  constructor(
    public ownerIds: string[],
    message = 'The Locked key for this file is not loaded',
  ) {
    super(message);
  }
}

/**
 * What a request answers when it needs a Locked key that isn't loaded: 423 with the
 * `locked_key_unavailable` code the web app turns into the PIN or passphrase prompt (spec §8). A
 * partner's read also carries `reason` (spec §6.2), for the owner's-passphrase or "not ready" screen.
 */
export const lockedKeyHttpException = (error?: LockedKeyUnavailableError) =>
  new HttpException(
    {
      code: 'locked_key_unavailable',
      message: 'Enter your PIN or passphrase to open Locked',
      ...(error?.reason ? { reason: error.reason } : {}),
    },
    HttpStatus.LOCKED,
  );

/**
 * FL-721 (spec §6.2, carry-over 4): the partner rules a read needs and only the database knows,
 * registered by `LockedEncryptionService`. Without them (a process that has no such service) every
 * partner read is refused.
 */
export interface LockedPartnerPolicy {
  /** Whether the person whose key is `ownerKeyId` shares their library with `viewerId` now. */
  isPartnerKey(ownerKeyId: Buffer, viewerId: string): Promise<boolean>;
  /** Why `viewerId` can't open a file with these recipients as a partner; undefined when it's their own file. */
  reasonFor(keyIds: Buffer[], viewerId: string): Promise<LockedPartnerReason | undefined>;
}

let partnerPolicy: LockedPartnerPolicy | undefined;

export const setLockedPartnerPolicy = (policy: LockedPartnerPolicy | undefined) => {
  partnerPolicy = policy;
};

/** `FRAMELEAF_LOCKED_TMP` is not RAM-backed, so no plain copy is made; the job waits like a missing key. */
export class LockedTmpUnavailableError extends LockedKeyUnavailableError {
  name = 'LockedTmpUnavailableError';
  constructor(message: string) {
    super([], message);
  }
}

/** The requested byte range lies outside the decrypted file. */
export class RangeNotSatisfiableError extends Error {
  name = 'RangeNotSatisfiableError';
  constructor(public plaintextLength: number) {
    super(`The range is outside 0-${plaintextLength - 1}`);
  }
}

// ---- isLockedPath ----

type CachedCheck = { dev: number; ino: number; size: number; mtimeMs: number; locked: boolean };
/** Bounded; an entry is only trusted while the file's inode, size and mtime are unchanged. */
const MAX_CACHED_CHECKS = 4096;
const checks = new Map<string, CachedCheck>();

/**
 * Whether the file starts with `FLLK`. A missing or unreadable file is "not locked", so the caller
 * goes on and fails the way it always did. The answer is cached per path while the file's inode,
 * size and mtime stay the same: sealing and unsealing rename a new file over the path, which changes
 * the inode.
 */
export async function isLockedPath(path: string): Promise<boolean> {
  let stats;
  try {
    stats = await fs.stat(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) {
    return false;
  }
  const cached = checks.get(path);
  if (
    cached &&
    cached.dev === stats.dev &&
    cached.ino === stats.ino &&
    cached.size === stats.size &&
    cached.mtimeMs === stats.mtimeMs
  ) {
    return cached.locked;
  }
  let locked: boolean;
  try {
    locked = stats.size >= 4 && (await isLockedFile(path));
  } catch {
    return false;
  }
  if (checks.size >= MAX_CACHED_CHECKS) {
    checks.delete(checks.keys().next().value!);
  }
  checks.set(path, { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, locked });
  return locked;
}

/** For tests. */
export const clearLockedPathCache = () => checks.clear();

// ---- key choice ----

/**
 * The first loaded key among the file's recipients that this viewer may use (null: a background job).
 *
 * Header entries are never an access list (carry-over 4). The viewer's own key on a file whose first
 * entry (the owner's, spec §5) is someone else's is used only while that owner shares with the viewer
 * now: a former partner's stale entry, left until the owner's next re-wrap, opens nothing. An owner's
 * key needs `canRead` (the viewer is the owner, or was granted it), and grants end with the
 * partnership (`onPartnershipEnded`).
 */
const usableKey = async (keyIds: Buffer[], viewerId: string | null): Promise<HeldKey | undefined> => {
  for (const id of keyIds) {
    const held = lockedKeys.forKeyId(id);
    if (!held) {
      continue;
    }
    if (viewerId === null) {
      return held;
    }
    if (!lockedKeys.canRead(viewerId, held.userId)) {
      continue;
    }
    const ownerKeyId = keyIds[0];
    if (
      held.userId === viewerId &&
      !ownerKeyId.equals(held.keyId) &&
      !(await (partnerPolicy?.isPartnerKey(ownerKeyId, viewerId) ?? Promise.resolve(false)))
    ) {
      continue;
    }
    return held;
  }
};

/**
 * Whether a loaded key that this viewer may use opens a file with these recipients, for what a
 * screen shows only (`getPartnerItemView`); every read still goes through `openLockedRead`.
 */
export const hasUsableLockedKey = async (keyIds: Buffer[], viewerId: string): Promise<boolean> =>
  !!(await usableKey(keyIds, viewerId));

/** keyId (hex) → userId, from the key files; read again when an unknown key id turns up (at most once a minute). */
let keyOwners = new Map<string, string>();
let keyOwnersReadAt = 0;
const KEY_OWNERS_REFRESH_MS = 60_000;

const ownersOf = async (keyIds: Buffer[]): Promise<string[]> => {
  const hex = keyIds.map((id) => id.toString('hex'));
  if (hex.some((id) => !keyOwners.has(id)) && Date.now() - keyOwnersReadAt > KEY_OWNERS_REFRESH_MS) {
    keyOwnersReadAt = Date.now();
    try {
      const next = new Map<string, string>();
      // imported when first needed: file.ts (and so every controller) imports this module, and the
      // key repository's storage imports would make a cycle. The path is relative because the build
      // rewrites the `src/` alias of static imports only; `import('src/…')` fails in the built server.
      const { LockedKeyRepository } = await import('../repositories/locked-key.repository.js');
      for (const file of await new LockedKeyRepository().list()) {
        next.set(toKeyId(Buffer.from(file.publicKey, 'base64')).toString('hex'), file.userId);
      }
      keyOwners = next;
    } catch {
      // the owners only make the error more useful; the error stands without them
    }
  }
  return [...new Set(hex.map((id) => keyOwners.get(id)).filter((id): id is string => !!id))];
};

/** For tests. */
export const clearLockedKeyOwners = () => {
  keyOwners = new Map();
  keyOwnersReadAt = 0;
};

const unavailable = async (keyIds: Buffer[], viewerId: string | null = null) => {
  const error = new LockedKeyUnavailableError(await ownersOf(keyIds));
  if (viewerId && partnerPolicy) {
    try {
      error.reason = await partnerPolicy.reasonFor(keyIds, viewerId);
    } catch {
      // the reason only picks the screen; the refusal stands without it
    }
  }
  deferForLockedKey(error);
  return error;
};

// ---- openLockedRead ----

/**
 * Reads the header and checks that a loaded key opens the file for this viewer, without decrypting
 * anything. Throws `LockedKeyUnavailableError` otherwise.
 */
export async function assertLockedReadable(
  path: string,
  viewerId: string | null,
): Promise<{ plaintextLength: number }> {
  const header = await readHeader(path);
  if (!(await usableKey(header.keyIds, viewerId))) {
    throw await unavailable(header.keyIds, viewerId);
  }
  return { plaintextLength: header.plaintextLength };
}

/**
 * A decrypting stream of an encrypted file (spec §8). `viewerId` is the person the bytes are for
 * (`canRead` must allow them the key); null is a background job. With `range` (inclusive, in
 * plaintext bytes) only the segments that hold it are read and decrypted.
 */
export async function openLockedRead(
  path: string,
  viewerId: string | null,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; plaintextLength: number; mime: string }> {
  const header = await readHeader(path);
  const held = await usableKey(header.keyIds, viewerId);
  if (!held) {
    throw await unavailable(header.keyIds, viewerId);
  }
  if (
    range &&
    (!Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.start > range.end ||
      range.end >= header.plaintextLength)
  ) {
    throw new RangeNotSatisfiableError(header.plaintextLength);
  }
  // the holder zeroes its buffer when the key is dropped; this read keeps its own copy until opened
  const privateKey = Buffer.from(held.privateKey);
  try {
    const { stream, plaintextLength, info } = await openDecrypt(path, privateKey, range);
    return { stream, plaintextLength, mime: info.mime };
  } finally {
    privateKey.fill(0);
  }
}

/**
 * A decrypting stream that opens the file only when it is first read, for zip entries (spec §8.1:
 * `archive.append(stream)`): an archive reads its entries one after another, so a long list of
 * encrypted entries never holds more than one file open.
 */
export function lazyLockedStream(path: string, viewerId: string | null): Readable {
  async function* chunks() {
    const { stream } = await openLockedRead(path, viewerId);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        yield chunk;
      }
    } finally {
      (stream as Readable).destroy();
    }
  }
  // Readable.from asks the generator for its first chunk only when the stream is first read
  return Readable.from(chunks(), { objectMode: false });
}

/**
 * What to add to a zip for `path`: the path itself when it is plain, or a lazy decrypting stream when
 * it is encrypted. The key is checked here, so a request is refused (423) before the archive starts
 * rather than broken halfway. `viewerId` undefined (a shared link) never reads an encrypted file.
 */
export async function lockedArchiveInput(
  path: string,
  viewerId: string | null | undefined,
): Promise<string | Readable> {
  if (!(await isLockedPath(path))) {
    return path;
  }
  if (viewerId === undefined) {
    throw new LockedKeyUnavailableError([]);
  }
  await assertLockedReadable(path, viewerId);
  return lazyLockedStream(path, viewerId);
}

/**
 * The decrypted bytes of a file that may be encrypted, for readers that load a whole (small) file
 * into memory: ML inputs (a preview), cached JSON. A job reads with any loaded recipient key; a
 * request passes `viewerId` (undefined: never). `maxBytes` refuses a larger file before decrypting.
 */
export async function readPlainFile(
  path: string,
  options: { maxBytes?: number; viewerId?: string | null } = {},
): Promise<Buffer> {
  if (!(await isLockedPath(path))) {
    return fs.readFile(path);
  }
  const viewerId = 'viewerId' in options ? options.viewerId : null;
  if (viewerId === undefined) {
    throw new LockedKeyUnavailableError([]);
  }
  const { stream, plaintextLength } = await openLockedRead(path, viewerId);
  if (options.maxBytes !== undefined && plaintextLength > options.maxBytes) {
    (stream as Readable).destroy();
    throw new RangeError(`The file is larger than ${options.maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The hash of a file's plaintext: the file's own hash when it is plain, the hash of what it decrypts
 * to when it is sealed (a sealed file's own bytes change with every seal). A job read.
 */
export async function hashPlainFile(path: string, algorithm: 'sha1' | 'sha256' = 'sha256'): Promise<Buffer> {
  const hash = createHash(algorithm);
  const stream = (await isLockedPath(path)) ? (await openLockedRead(path, null)).stream : createReadStream(path);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  return hash.digest();
}

/**
 * Throws what `withPlainCopy` would (`LockedKeyUnavailableError`, deferring a job) without decrypting
 * anything, so a job can wait for the key before it starts work it would have to undo.
 */
export async function assertPlainCopyPossible(path: string): Promise<void> {
  if (!(await isLockedPath(path))) {
    return;
  }
  await assertLockedReadable(path, null);
  try {
    await assertLockedTmpIsTmpfs();
  } catch (error) {
    deferForLockedKey(error);
    throw error;
  }
}

// ---- withPlainCopy ----

export interface LockedTmpConfig {
  path: string;
  allowDisk: boolean;
}

/**
 * The environment variables of plain copies, read here (they are not in `EnvSchema`, whose keys are a
 * response enum the native apps decode strictly):
 *
 * - `FRAMELEAF_LOCKED_TMP` (default `/dev/shm/frameleaf-locked`): where a tool gets its temporary
 *   plain copy of an encrypted Locked file. It must be on tmpfs or ramfs (checked against
 *   /proc/mounts); otherwise no plain copy is made and the work waits, so decrypted bytes never reach
 *   a disk.
 * - `FRAMELEAF_LOCKED_TMP_ALLOW_DISK=true`: UNSAFE, for local development and tests only (macOS has no
 *   tmpfs). It lets `FRAMELEAF_LOCKED_TMP` be on an ordinary disk, so decrypted copies are written to
 *   that disk. Only the exact value `true` turns it on; never set it on a server with real Locked files.
 */
export const lockedTmpConfig = (): LockedTmpConfig => ({
  path: resolve(process.env.FRAMELEAF_LOCKED_TMP || DEFAULT_LOCKED_TMP),
  allowDisk: process.env.FRAMELEAF_LOCKED_TMP_ALLOW_DISK === 'true',
});

const RAM_FILESYSTEMS = new Set(['tmpfs', 'ramfs']);

/** The filesystem type `/proc/mounts` gives for the mount holding `path` (the longest mount point that contains it). */
const mountTypeOf = (mounts: string, path: string): string | undefined => {
  let best: { point: string; type: string } | undefined;
  for (const line of mounts.split('\n')) {
    const [, rawPoint, type] = line.split(' ', 3);
    if (!rawPoint || !type) {
      continue;
    }
    // /proc/mounts escapes spaces, tabs, newlines and backslashes as octal
    const point = rawPoint.replaceAll(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCodePoint(Number.parseInt(octal, 8)),
    );
    const contains = point === '/' || path === point || path.startsWith(point.endsWith(sep) ? point : point + sep);
    if (contains && (!best || point.length >= best.point.length)) {
      best = { point, type };
    }
  }
  return best?.type;
};

let tmpCheck: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;

const checkTmp = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const { path, allowDisk } = lockedTmpConfig();
  try {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    // a folder made earlier (or by hand) may be wider; mkdir leaves an existing one as it is
    await fs.chmod(path, 0o700);
  } catch (error) {
    return { ok: false, reason: `The Locked temporary folder ${path} can't be prepared (${(error as Error).message})` };
  }
  if (allowDisk) {
    return { ok: true };
  }
  if (process.platform !== 'linux') {
    return {
      ok: false,
      reason: `The Locked temporary folder ${path} can't be checked for tmpfs on ${process.platform}; set FRAMELEAF_LOCKED_TMP_ALLOW_DISK=true for development only`,
    };
  }
  try {
    const real = await fs.realpath(path);
    const type = mountTypeOf(await fs.readFile('/proc/mounts', 'utf8'), real);
    if (type && RAM_FILESYSTEMS.has(type)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `The Locked temporary folder ${path} is on ${type ?? 'an unknown filesystem'}, not tmpfs`,
    };
  } catch (error) {
    return { ok: false, reason: `The Locked temporary folder ${path} can't be checked (${(error as Error).message})` };
  }
};

/**
 * Spec §8: plain copies are made only in a RAM-backed folder. Run at startup (and once, lazily, by
 * the first plain copy). When it fails, every plain copy is refused with `LockedTmpUnavailableError`,
 * which a job treats as a deferral, so plaintext never reaches a disk.
 */
export async function assertLockedTmpIsTmpfs(): Promise<void> {
  tmpCheck ??= checkTmp();
  const result = await tmpCheck;
  if (!result.ok) {
    throw new LockedTmpUnavailableError(result.reason);
  }
}

/** For tests: forget the tmpfs check so the next plain copy runs it again. */
export const resetLockedTmpCheck = () => {
  tmpCheck = undefined;
};

const COPY_PREFIX = 'copy-';

/**
 * Removes plain copies a crashed process left behind: folders `copy-<pid>-…` whose process is gone.
 * Copies of live processes (the API and every worker share the folder) are kept.
 */
export async function removeStalePlainCopies(): Promise<number> {
  const { path } = lockedTmpConfig();
  let names: string[];
  try {
    names = await fs.readdir(path);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const pid = Number(/^copy-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) {
      continue;
    }
    await fs.rm(join(path, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Runs `fn` on a plain version of `path` (spec §8): `path` itself when it isn't encrypted, otherwise
 * a decrypted copy (mode 0600, in its own 0700 folder under `FRAMELEAF_LOCKED_TMP`) that keeps the
 * file name, so tools that look at the extension still work. The copy is deleted when `fn` settles.
 * A job reads with any loaded recipient key; a request passes `viewerId`, who must be allowed the key
 * (`canRead`).
 */
export async function withPlainCopy<T>(
  path: string,
  fn: (plainPath: string) => Promise<T>,
  options: { viewerId?: string | null } = {},
): Promise<T> {
  if (!(await isLockedPath(path))) {
    return fn(path);
  }
  const header = await readHeader(path);
  // `viewerId: undefined` (a shared link, or nobody signed in) never reads an encrypted file
  const viewerId = 'viewerId' in options ? options.viewerId : null;
  const held = viewerId === undefined ? undefined : await usableKey(header.keyIds, viewerId);
  if (!held) {
    throw await unavailable(header.keyIds, viewerId ?? null);
  }
  try {
    await assertLockedTmpIsTmpfs();
  } catch (error) {
    deferForLockedKey(error);
    throw error;
  }
  const { path: root } = lockedTmpConfig();
  const folder = await fs.mkdtemp(join(root, `${COPY_PREFIX}${process.pid}-`));
  try {
    await fs.chmod(folder, 0o700);
    const plainPath = join(folder, basename(path) || 'file');
    const privateKey = Buffer.from(held.privateKey);
    try {
      // created exclusively with mode 0600 (locked-crypto `writeOutput`)
      await decryptFile(path, plainPath, privateKey);
    } finally {
      privateKey.fill(0);
    }
    // tools that read the file's dates (exiftool's FileModifyDate) see the stored file's, not now
    const { atime, mtime } = await fs.stat(path);
    await fs.utimes(plainPath, atime, mtime);
    return await fn(plainPath);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

/** Whether `path` lies inside `FRAMELEAF_LOCKED_TMP`: a plain copy that `withPlainCopy` handed out. */
export function isPlainCopyPath(path: string): boolean {
  const { path: root } = lockedTmpConfig();
  return resolve(path).startsWith(root + sep);
}

/**
 * FL-721 (spec §8): a private scratch folder for a tool. With `sealed` (its input is, or comes from,
 * a sealed Locked file) the folder is made inside the RAM-backed `FRAMELEAF_LOCKED_TMP`, mode 0700 and
 * named like a plain copy's, so a crashed process's folder is swept at startup
 * (`removeStalePlainCopies`): a decrypted input, and full renditions of it, never reach a disk.
 * Otherwise it is an ordinary folder in the OS temp folder. The caller removes it.
 */
export async function makeWorkDir(label: string, sealed: boolean): Promise<string> {
  if (!sealed) {
    return fs.mkdtemp(join(tmpdir(), `frameleaf-${label}-`));
  }
  try {
    await assertLockedTmpIsTmpfs();
  } catch (error) {
    deferForLockedKey(error);
    throw error;
  }
  const folder = await fs.mkdtemp(join(lockedTmpConfig().path, `${COPY_PREFIX}${process.pid}-${label}-`));
  await fs.chmod(folder, 0o700);
  return folder;
}

/** `makeWorkDir` for a tool given `input`: in the locked folder when `input` is a plain copy. */
export const makeWorkDirFor = (input: string, label: string) => makeWorkDir(label, isPlainCopyPath(input));

/** `withPlainCopy` over several paths (e.g. a Live Photo's still and motion part, or a sidecar and its original). */
export async function withPlainCopies<T>(paths: string[], fn: (plainPaths: string[]) => Promise<T>): Promise<T> {
  const run = async (index: number, done: string[]): Promise<T> =>
    index === paths.length ? fn(done) : withPlainCopy(paths[index], (plain) => run(index + 1, [...done, plain]));
  return run(0, []);
}

/**
 * Writes a tool's output for a file that may be encrypted. When `path` is sealed, the tool works on a
 * plain copy and the result replaces the sealed file as plain bytes (renamed into place); the caller
 * then queues `LockedSeal`, which encrypts it again (spec §7.2: a newly written file is sealed after
 * the job that wrote it). Returns whether `path` was sealed before.
 */
export async function rewriteThroughPlainCopy(
  path: string,
  fn: (plainPath: string) => Promise<void>,
): Promise<boolean> {
  if (!(await isLockedPath(path))) {
    await fn(path);
    return false;
  }
  await withPlainCopy(path, async (plainPath) => {
    await fn(plainPath);
    const staging = join(dirname(path), `.${basename(path)}.${process.pid}-${Date.now()}.plain.tmp`);
    await fs.copyFile(plainPath, staging, constants.COPYFILE_EXCL);
    try {
      await fs.rename(staging, path);
    } catch (error) {
      await fs.rm(staging, { force: true });
      throw error;
    }
  });
  return true;
}

// ---- job deferral ----

/** Bounded per process: job ids waiting for each person's key, woken by `wakeLockedDeferrals`. */
const MAX_DEFERRED = 10_000;
const deferred = new Map<string, Set<string>>();
let deferredCount = 0;

/**
 * Inside a job, records that it waits for a Locked key: the queue defers it (one hour, at most 72
 * times) instead of failing it, logs no error, and `wakeLockedDeferrals` runs it early when one of
 * `ownerIds` loads a key. Recorded on the execution itself, so a handler that catches the error and
 * returns Failed still defers. Outside a job, and for operation-owned jobs, nothing happens.
 */
export function deferForLockedKey(error: unknown): void {
  if (!(error instanceof LockedKeyUnavailableError)) {
    return;
  }
  const context = queueExecution.getStore();
  if (!context || context.claim.data.operationId || context.claim.attempt > LOCKED_DEFERRAL_MAX_ATTEMPTS) {
    return;
  }
  context.dependencyReason ??= 'locked-key-unavailable';
  for (const ownerId of error.ownerIds) {
    let ids = deferred.get(ownerId);
    if (!ids) {
      ids = new Set();
      deferred.set(ownerId, ids);
    }
    if (!ids.has(context.claim.id) && deferredCount < MAX_DEFERRED) {
      ids.add(context.claim.id);
      deferredCount++;
    }
  }
}

/** The job ids this process deferred for `ownerId`'s key, forgotten as they are handed out. */
export function takeLockedDeferrals(ownerId: string): string[] {
  const ids = deferred.get(ownerId);
  if (!ids) {
    return [];
  }
  deferred.delete(ownerId);
  deferredCount -= ids.size;
  return [...ids];
}

/** For tests. */
export const clearLockedDeferrals = () => {
  deferred.clear();
  deferredCount = 0;
};

/** Whether `error` means "wait for a Locked key" (or for a RAM-backed temporary folder). */
export const isLockedKeyUnavailable = (error: unknown): error is LockedKeyUnavailableError =>
  error instanceof LockedKeyUnavailableError;
