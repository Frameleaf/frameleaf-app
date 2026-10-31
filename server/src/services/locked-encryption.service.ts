import {
  type LockedKeyFile,
  type WrapKind,
  WrongSecretError,
  generateKeyPair,
  generateRecoveryKey,
  isLockedFile,
  removeWrap,
  unwrapKey,
  wrapKey,
} from '@frameleaf/locked-crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SALT_ROUNDS } from 'src/constants.js';
import {
  LOCKED_ASK_AGAIN_DEFAULT,
  LockedEncryptionDisableDto,
  LockedEncryptionEnableDto,
  LockedEncryptionRecoverDto,
  LockedEncryptionRecoveryKeyDto,
  LockedEncryptionRecoveryKeyResponseDto,
  LockedEncryptionStatusResponseDto,
  LockedEncryptionUnlockDto,
  LockedEncryptionUpdateDto,
} from 'src/dtos/locked-encryption.dto.js';
import { JobName } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import {
  type LockedEncryptionAsset,
  LockedEncryptionRepository,
} from 'src/repositories/locked-encryption.repository.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { publishLockedKey } from 'src/utils/locked-key-ipc.js';
import { checkSecret } from 'src/utils/secret-attempts.js';

type Mode = LockedKeyFile['mode'];

const FORMAT = 'frameleaf-locked-key/1';
const HOUR_MS = 60 * 60 * 1000;
/**
 * One key-file change at a time per person, from reading the file to writing the row (a double
 * submit must never write two key pairs or roll back the other request's file). Separate from the
 * secret-check queue in `secret-attempts.ts`, which runs inside it.
 */
const keyFileChanges = new Map<string, Promise<void>>();
/** How many originals are opened at once to count encrypted ones. */
const COUNT_CONCURRENCY = 16;

/**
 * FL-721 (spec §8): a Locked view needs the person's key and it isn't open. The web app turns the
 * `locked_key_unavailable` code into the PIN or passphrase prompt for `mode`.
 */
export class LockedKeyUnavailableException extends HttpException {
  constructor(
    mode: Mode,
    message = mode === 'pin' ? 'Enter your PIN to open Locked' : 'Type your passphrase to open Locked',
  ) {
    super({ code: 'locked_key_unavailable', mode, message }, HttpStatus.LOCKED);
  }
}

const secretName = (kind: WrapKind) => ({ pin: 'PIN', passphrase: 'passphrase', recovery: 'recovery key' })[kind];
const modeKind = (mode: Mode): WrapKind => (mode === 'pin' ? 'pin' : 'passphrase');

const assertPassphrase = (passphrase: string | undefined): string => {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024) {
    throw new BadRequestException('Use a passphrase of at least 12 characters and at most 1024 bytes');
  }
  return passphrase;
};

const unreadableKeyFile = () =>
  new ConflictException(
    'Your Locked key file is on this server but can’t be read, so nothing was changed. Restore it from a backup.',
  );

/**
 * FL-721: the person's Locked encryption settings (spec §7, §10) and the PIN hooks `AuthService`,
 * `UserAdminService` and `SessionService` call.
 *
 * - The key file (`LockedKeyRepository`) is the source of truth for the key pair and its mode; the
 *   `locked_encryption` row mirrors state only. An existing key file is never replaced unless it
 *   could be read and encrypts nothing (a PIN-only partner key pair, spec §4.1).
 * - Every unwrapped private key goes to this process's holder and, by `publishLockedKey`, to the job
 *   workers; nothing else keeps it. Buffers not handed to the holder are zero-filled.
 * - Every secret check shares PIN unlock's per-user queue and attempt limit (`checkSecret`).
 */
@Injectable()
export class LockedEncryptionService {
  constructor(
    private logger: LoggingRepository,
    private lockedKeyRepository: LockedKeyRepository,
    private lockedEncryptionRepository: LockedEncryptionRepository,
    private userRepository: UserRepository,
    private sessionRepository: SessionRepository,
    private jobRepository: JobRepository,
    private cryptoRepository: CryptoRepository,
    private websocketRepository: WebsocketRepository,
  ) {
    this.logger.setContext(LockedEncryptionService.name);
  }

  async getStatus(auth: AuthDto): Promise<LockedEncryptionStatusResponseDto> {
    const userId = auth.user.id;
    const row = await this.lockedEncryptionRepository.get(userId);
    const assets = await this.lockedEncryptionRepository.getLockedAssets(userId);
    const encryptable = assets.filter((asset) => asset.encryptable);

    let encrypted = 0;
    let progress: LockedEncryptionStatusResponseDto['progress'] = null;
    if (row?.status === 'on') {
      encrypted = encryptable.length;
    } else if (row) {
      encrypted = await this.countEncrypted(encryptable);
      const total = encryptable.length;
      progress = { done: row.status === 'encrypting' ? encrypted : total - encrypted, total };
    }

    return {
      enabled: !!row,
      mode: row?.mode ?? null,
      status: row?.status ?? null,
      keyLoaded: lockedKeys.has(userId),
      expiresAt: lockedKeys.expiresAt(userId)?.toISOString() ?? null,
      askAgainHours: row ? row.askAgainHours : LOCKED_ASK_AGAIN_DEFAULT,
      recoveryKeyCreatedAt: row ? new Date(row.recoveryKeyCreatedAt).toISOString() : null,
      progress,
      counts: { encrypted, notEncryptable: assets.length - encryptable.length },
    };
  }

  /** Spec §7.1 step 1: key pair, key file, row, loaded key; then the sweep queues the seals. */
  enable(auth: AuthDto, dto: LockedEncryptionEnableDto): Promise<LockedEncryptionRecoveryKeyResponseDto> {
    return this.withKeyFileLock(auth.user.id, () => this.enableLocked(auth, dto));
  }

  private async enableLocked(
    auth: AuthDto,
    dto: LockedEncryptionEnableDto,
  ): Promise<LockedEncryptionRecoveryKeyResponseDto> {
    const userId = auth.user.id;
    const passphrase = dto.mode === 'advanced' ? assertPassphrase(dto.passphrase) : undefined;
    if (dto.mode === 'pin' && dto.passphrase !== undefined) {
      throw new BadRequestException('A passphrase is only used with Advanced Security');
    }
    if (await this.lockedEncryptionRepository.get(userId)) {
      throw new ConflictException('Locked encryption is already on');
    }
    await this.verifyPin(userId, dto.pinCode);

    const existing = await this.readKeyFile(userId);
    let publicKey: Buffer;
    let privateKey: Buffer;
    let createdAt = new Date().toISOString();
    const reused = existing ? await this.privateKeyOf(userId, existing, dto.pinCode) : null;
    if (existing && reused) {
      // a PIN-only key pair (spec §4.1): partners' files already carry entries for it
      publicKey = Buffer.from(existing.publicKey, 'base64');
      privateKey = reused;
      createdAt = existing.createdAt;
    } else if (!existing || this.isReplaceable(existing, false)) {
      ({ publicKey, privateKey } = generateKeyPair());
    } else {
      throw new ConflictException(
        'A Locked key file is already on this server and your PIN doesn’t open it, so nothing was changed.',
      );
    }

    const recoveryKey = generateRecoveryKey();
    let file: LockedKeyFile;
    try {
      // the row is the claim: its primary key refuses a second turn-on before any file is written
      try {
        await this.lockedEncryptionRepository.create({
          userId,
          mode: dto.mode,
          status: 'encrypting',
          recoveryKeyCreatedAt: new Date(),
        });
      } catch (error) {
        if (await this.lockedEncryptionRepository.get(userId)) {
          throw new ConflictException('Locked encryption is already on');
        }
        throw error;
      }
      try {
        const base = {
          format: FORMAT,
          userId,
          label: auth.user.name,
          publicKey: publicKey.toString('base64'),
          mode: dto.mode,
          encrypting: true,
          createdAt,
          updatedAt: createdAt,
        } as const;
        file = await wrapKey(base, privateKey, modeKind(dto.mode), passphrase ?? dto.pinCode);
        file = await wrapKey(file, privateKey, 'recovery', recoveryKey);
        await this.lockedKeyRepository.write(file);
      } catch (error) {
        // nothing of this request reached the key file (the write is atomic and comes last), so
        // only the claim is undone; a retry can then turn it on
        await this.lockedEncryptionRepository.delete(userId);
        throw error;
      }
    } catch (error) {
      privateKey.fill(0);
      throw error;
    }

    // PIN mode: the key follows the PIN unlock; sealing needs only the public key
    const expiresAt =
      dto.mode === 'pin'
        ? await this.sessionRepository.getPinUnlockedUntil(userId)
        : this.askAgainExpiry(LOCKED_ASK_AGAIN_DEFAULT);
    if (dto.mode === 'pin' && !expiresAt) {
      privateKey.fill(0);
    } else {
      this.load(userId, file, privateKey, expiresAt);
    }
    // turned on whatever happens next: the recovery key must reach the person; a failed queue is
    // picked up again by the sweep
    try {
      await this.jobRepository.queue({ name: JobName.LockedSweep, data: { userId } });
    } catch (error) {
      this.logger.error(`Could not queue the Locked sweep of user ${userId}: ${(error as Error).name}`);
    }
    return { recoveryKey };
  }

  /** Spec §7.4: the key stays loaded (pinned) until the last file is decrypted. */
  disable(auth: AuthDto, dto: LockedEncryptionDisableDto): Promise<void> {
    return this.withKeyFileLock(auth.user.id, () => this.disableLocked(auth, dto));
  }

  private async disableLocked(auth: AuthDto, dto: LockedEncryptionDisableDto): Promise<void> {
    const userId = auth.user.id;
    const row = await this.requireRow(userId);
    const file = await this.requireKeyFile(userId);
    const secret = file.mode === 'pin' ? dto.pinCode : dto.passphrase;
    if (!secret) {
      throw new BadRequestException(file.mode === 'pin' ? 'Enter your PIN' : 'Type your passphrase');
    }
    const privateKey = await this.unwrap(userId, file, modeKind(file.mode), secret);
    this.load(userId, file, privateKey, null, true);
    if (row.status !== 'decrypting') {
      await this.lockedEncryptionRepository.update(userId, { status: 'decrypting' });
    }
    await this.queueFor(userId, JobName.LockedUnseal);
    // finishes turning off when nothing is left to decrypt (Task 5's sweep)
    await this.jobRepository.queue({ name: JobName.LockedSweep, data: { userId } });
  }

  /** Advanced Security: the passphrase opens the key until the ask-again time (spec §4.3). */
  async unlock(auth: AuthDto, dto: LockedEncryptionUnlockDto): Promise<void> {
    const userId = auth.user.id;
    const row = await this.requireRow(userId);
    const file = await this.requireKeyFile(userId);
    if (file.mode !== 'advanced') {
      throw new BadRequestException('Locked encryption uses your PIN; enter it to open Locked');
    }
    const privateKey = await this.unwrap(userId, file, 'passphrase', dto.passphrase);
    const decrypting = row.status === 'decrypting';
    this.load(userId, file, privateKey, decrypting ? null : this.askAgainExpiry(row.askAgainHours), decrypting);
  }

  /** Lock now. Refused while turning off, which needs the key until it finishes (spec §4.3). */
  async lock(auth: AuthDto): Promise<void> {
    const userId = auth.user.id;
    const row = await this.requireRow(userId);
    if (row.status === 'decrypting') {
      throw new ConflictException('Lock now is off while Locked encryption is being turned off');
    }
    this.drop(userId);
    if (row.mode === 'pin') {
      // in PIN mode the key follows the PIN unlock, so the unlock ends too
      await this.sessionRepository.lockAll(userId);
      this.websocketRepository.clientSend('on_session_lock', userId);
    }
  }

  /** Spec §7.5: switch mode, change the passphrase, or the ask-again time. No file is encrypted again. */
  update(auth: AuthDto, dto: LockedEncryptionUpdateDto): Promise<void> {
    return this.withKeyFileLock(auth.user.id, () => this.updateLocked(auth, dto));
  }

  private async updateLocked(auth: AuthDto, dto: LockedEncryptionUpdateDto): Promise<void> {
    const userId = auth.user.id;
    const row = await this.requireRow(userId);
    const askAgainHours = dto.askAgainHours === undefined ? row.askAgainHours : dto.askAgainHours;
    const file = await this.requireKeyFile(userId);
    const target = dto.mode ?? file.mode;
    const switching = target !== file.mode;

    if (!switching && dto.newPassphrase === undefined) {
      if (dto.askAgainHours === undefined && dto.mode === undefined) {
        throw new BadRequestException('Nothing to change');
      }
      if (dto.askAgainHours !== undefined) {
        await this.lockedEncryptionRepository.update(userId, { askAgainHours });
      }
      if (dto.mode !== undefined && row.status !== 'decrypting') {
        // the current mode again: queue the partner re-wrap again, in case a switch couldn't (§6.2)
        await this.queueFor(userId, JobName.LockedRewrap);
      }
      return;
    }
    if (row.status === 'decrypting') {
      throw new ConflictException('Locked encryption is being turned off');
    }
    if (!dto.currentSecret) {
      throw new BadRequestException(file.mode === 'pin' ? 'Enter your current PIN' : 'Type your current passphrase');
    }
    if (target === 'advanced') {
      assertPassphrase(dto.newPassphrase);
    } else if (dto.newPassphrase !== undefined) {
      throw new BadRequestException('A passphrase is only used with Advanced Security');
    } else if (!dto.pinCode) {
      throw new BadRequestException('Enter your Locked PIN');
    }

    const privateKey = await this.unwrap(userId, file, modeKind(file.mode), dto.currentSecret);
    let next: LockedKeyFile;
    try {
      if (target === 'advanced') {
        next = await wrapKey({ ...file, mode: 'advanced' }, privateKey, 'passphrase', dto.newPassphrase!);
        // spec §4.2: an advanced key file never holds a PIN wrap
        next = switching ? removeWrap(next, 'pin') : next;
      } else {
        await this.verifyPin(userId, dto.pinCode!);
        next = removeWrap(await wrapKey({ ...file, mode: 'pin' }, privateKey, 'pin', dto.pinCode!), 'passphrase');
      }
      await this.lockedKeyRepository.write(next);
      try {
        await this.lockedEncryptionRepository.update(userId, { mode: target, askAgainHours });
      } catch (error) {
        await this.lockedKeyRepository.write(file);
        throw error;
      }
    } catch (error) {
      privateKey.fill(0);
      throw error;
    }

    const expiresAt =
      target === 'advanced'
        ? this.askAgainExpiry(askAgainHours)
        : await this.sessionRepository.getPinUnlockedUntil(userId);
    if (target === 'pin' && !expiresAt) {
      privateKey.fill(0);
      this.drop(userId);
    } else {
      this.load(userId, next, privateKey, expiresAt);
    }
    if (switching) {
      // spec §6.2: partner entries are added (PIN) or removed (Advanced) on every file. The switch
      // is saved either way; `PUT {mode}` with the current mode (or the sweep) queues it again.
      try {
        await this.queueFor(userId, JobName.LockedRewrap);
      } catch (error) {
        this.logger.error(`Could not queue the Locked re-wrap of user ${userId}: ${(error as Error).name}`);
      }
    }
  }

  newRecoveryKey(auth: AuthDto, dto: LockedEncryptionRecoveryKeyDto): Promise<LockedEncryptionRecoveryKeyResponseDto> {
    return this.withKeyFileLock(auth.user.id, () => this.newRecoveryKeyLocked(auth, dto));
  }

  private async newRecoveryKeyLocked(
    auth: AuthDto,
    dto: LockedEncryptionRecoveryKeyDto,
  ): Promise<LockedEncryptionRecoveryKeyResponseDto> {
    const userId = auth.user.id;
    const row = await this.requireRow(userId);
    if (row.status === 'decrypting') {
      throw new ConflictException('Locked encryption is being turned off');
    }
    const file = await this.requireKeyFile(userId);
    const privateKey = await this.unwrap(userId, file, modeKind(file.mode), dto.secret);
    const recoveryKey = generateRecoveryKey();
    try {
      await this.lockedKeyRepository.write(await wrapKey(file, privateKey, 'recovery', recoveryKey));
    } finally {
      privateKey.fill(0);
    }
    await this.lockedEncryptionRepository.update(userId, { recoveryKeyCreatedAt: new Date() });
    return { recoveryKey };
  }

  /** Spec §7.5 "Forgot PIN or passphrase": the recovery key opens the key file and a new secret wraps it. */
  recover(auth: AuthDto, dto: LockedEncryptionRecoverDto): Promise<void> {
    return this.withKeyFileLock(auth.user.id, () => this.recoverLocked(auth, dto));
  }

  private async recoverLocked(auth: AuthDto, dto: LockedEncryptionRecoverDto): Promise<void> {
    const userId = auth.user.id;
    const row = await this.requireRow(userId);
    const file = await this.requireKeyFile(userId);
    if (file.mode === 'pin' && !dto.newPinCode) {
      throw new BadRequestException('Choose a new PIN');
    }
    if (file.mode === 'pin' && dto.newPassphrase !== undefined) {
      throw new BadRequestException('A passphrase is only used with Advanced Security');
    }
    if (file.mode === 'advanced') {
      if (dto.newPassphrase === undefined && !dto.newPinCode) {
        throw new BadRequestException('Choose a new passphrase or PIN');
      }
      if (dto.newPassphrase !== undefined) {
        assertPassphrase(dto.newPassphrase);
      }
    }

    const privateKey = await this.unwrap(userId, file, 'recovery', dto.recoveryKey);
    let next = file;
    try {
      if (file.mode === 'pin') {
        next = await wrapKey(file, privateKey, 'pin', dto.newPinCode!);
      } else if (dto.newPassphrase !== undefined) {
        next = await wrapKey(file, privateKey, 'passphrase', dto.newPassphrase);
      }
      if (next !== file) {
        await this.lockedKeyRepository.write(next);
      }
      if (dto.newPinCode) {
        await this.setPin(userId, dto.newPinCode, () => this.restoreKeyFile(userId, file, next));
      }
    } catch (error) {
      privateKey.fill(0);
      throw error;
    }

    const decrypting = row.status === 'decrypting';
    if (decrypting) {
      // turning off resumes once a secret is typed (spec §4.3)
      this.load(userId, next, privateKey, null, true);
    } else if (file.mode === 'advanced') {
      this.load(userId, next, privateKey, this.askAgainExpiry(row.askAgainHours));
    } else {
      // the new PIN locked every session, and a PIN-mode key follows the PIN unlock
      privateKey.fill(0);
      this.drop(userId);
    }
  }

  // ---- Hooks ----

  /** Whether the person has Locked encryption on (or turning on or off): their PIN can't be reset or cleared. */
  async isOn(userId: string): Promise<boolean> {
    return !!(await this.lockedEncryptionRepository.get(userId));
  }

  /** Which of these people have Locked encryption on, for the admin user list. */
  usersWithEncryption(userIds: string[]): Promise<Set<string>> {
    return this.lockedEncryptionRepository.getUserIds(userIds);
  }

  /** `resetPinCode` (forgot PIN, with the password): refused while encryption is on (spec §7.5, owner). */
  async assertPinResettable(userId: string): Promise<void> {
    if (await this.isOn(userId)) {
      throw new ConflictException(
        'Locked encryption is on, so your PIN can’t be reset with your password. Use your recovery key to choose a new PIN.',
      );
    }
  }

  /**
   * A new PIN is about to be stored (`setupPinCode`, `changePinCode`). Spec §4.1: create the key pair
   * when there is no key file; spec §7.5: in PIN mode re-wrap the `pin` wrap with the new PIN. Writes
   * the key file now and returns how to put the previous one back if storing the PIN then fails.
   * Refuses (and changes nothing) when the key file can't be read or opened. The caller holds
   * `withKeyFileLock` across this and storing the PIN.
   */
  async onPinSet(userId: string, pinCode: string, currentPinCode?: string): Promise<() => Promise<void>> {
    const noop = async () => {};
    const file = await this.readKeyFile(userId);
    if (file?.mode === 'advanced') {
      // the PIN isn't a key in Advanced Security
      return noop;
    }
    const encryptionOn = await this.isOn(userId);
    if (!file && encryptionOn) {
      // never make a new key pair for someone whose files may be sealed with a lost one
      this.logger.warn(`Locked encryption is on for user ${userId} but their key file is missing`);
      return noop;
    }

    let next: LockedKeyFile;
    const privateKey = file ? await this.privateKeyOf(userId, file, currentPinCode) : null;
    if (file && privateKey) {
      try {
        next = await wrapKey(file, privateKey, 'pin', pinCode);
      } finally {
        privateKey.fill(0);
      }
    } else if (!file || this.isReplaceable(file, encryptionOn)) {
      if (file) {
        this.logger.log(`Replacing the PIN-only Locked key pair of user ${userId}, which the new PIN can't open`);
      }
      next = await this.newPinKeyFile(userId, pinCode);
    } else {
      throw new ConflictException(
        'Locked encryption is on, so enter your current PIN to change it, or use your recovery key.',
      );
    }
    await this.lockedKeyRepository.write(next);
    return () => this.restoreKeyFile(userId, file, next);
  }

  /**
   * The PIN was entered and the session elevated (`unlockSession`). PIN mode: unwrap the key and keep
   * it until the last PIN unlock ends (spec §4.3); create the key pair when there is none (§4.1).
   */
  onPinVerified(userId: string, pinCode: string): Promise<void> {
    return this.withKeyFileLock(userId, () => this.onPinVerifiedLocked(userId, pinCode));
  }

  private async onPinVerifiedLocked(userId: string, pinCode: string): Promise<void> {
    const file = await this.readKeyFile(userId);
    if (file?.mode === 'advanced') {
      return;
    }
    const row = await this.lockedEncryptionRepository.get(userId);
    const decrypting = row?.status === 'decrypting';
    const until = decrypting ? null : await this.sessionRepository.getPinUnlockedUntil(userId);
    if (!decrypting && !until) {
      return;
    }

    if (!file) {
      if (row) {
        this.logger.warn(`Locked encryption is on for user ${userId} but their key file is missing`);
        return;
      }
      const { file: created, privateKey } = await this.newPinKeyPair(userId, pinCode);
      try {
        await this.lockedKeyRepository.write(created);
      } catch (error) {
        privateKey.fill(0);
        throw error;
      }
      this.load(userId, created, privateKey, until);
      return;
    }

    if (!decrypting && this.extend(userId, file, until!)) {
      return;
    }
    let privateKey: Buffer;
    try {
      privateKey = await unwrapKey(file, 'pin', pinCode);
    } catch (error) {
      if (!(error instanceof WrongSecretError)) {
        throw error;
      }
      if (!this.isReplaceable(file, !!row)) {
        this.logger.warn(`The Locked PIN of user ${userId} doesn't open their key file`);
        return;
      }
      this.logger.log(`Replacing the PIN-only Locked key pair of user ${userId}, which their PIN can't open`);
      const replaced = await this.newPinKeyPair(userId, pinCode);
      await this.lockedKeyRepository.write(replaced.file);
      this.load(userId, replaced.file, replaced.privateKey, until);
      return;
    }
    this.load(userId, file, privateKey, until, decrypting);
  }

  /** An elevated session's PIN expiry was extended (`refreshPinExpiry`): a PIN-mode key follows it. */
  async onPinExtended(userId: string, until: Date): Promise<void> {
    const held = this.held(userId);
    if (!held?.expiresAt || held.expiresAt >= until) {
      return;
    }
    const file = await this.readKeyFile(userId);
    if (file?.mode === 'pin') {
      this.extend(userId, file, until);
    }
  }

  /**
   * Sessions were locked or signed out. PIN mode: drop the key once no elevated session remains.
   * Never throws (it runs after locks and revocations are stored) and fails closed: when the key
   * file or the sessions can't be read, the key is dropped.
   */
  async onSessionsLocked(userId: string): Promise<void> {
    const held = this.held(userId);
    if (!held) {
      return;
    }
    let until: Date | null;
    try {
      const file = await this.readKeyFile(userId);
      if (file?.mode === 'advanced') {
        return;
      }
      until = file ? await this.sessionRepository.getPinUnlockedUntil(userId) : null;
    } catch (error) {
      this.logger.warn(`Dropping the Locked key of user ${userId}: ${(error as Error).name}`);
      this.drop(userId);
      return;
    }
    if (!until) {
      // a pinned key (turning off) stays; the holder and the workers ignore the drop
      this.drop(userId);
    } else if (held.expiresAt && until < held.expiresAt) {
      lockedKeys.load(userId, held.publicKey, held.privateKey, until);
      this.publishLoad(userId, held.publicKey.toString('base64'), held.privateKey, until);
    }
  }

  /**
   * Spec §4.3: whose PIN unlocks must end at boot, since the keys did not survive it: everyone with a
   * key file (readable or not) or a `locked_encryption` row, except a readable Advanced key file,
   * where the PIN isn't the key.
   */
  async usersWithKeyFiles(): Promise<string[]> {
    const users = new Set([
      ...(await this.lockedKeyRepository.userIds()),
      ...(await this.lockedEncryptionRepository.getAllUserIds()),
    ]);
    for (const file of await this.lockedKeyRepository.list()) {
      if (file.mode === 'advanced') {
        users.delete(file.userId);
      }
    }
    return [...users];
  }

  // ---- Helpers ----

  private async requireRow(userId: string) {
    const row = await this.lockedEncryptionRepository.get(userId);
    if (!row) {
      throw new BadRequestException('Locked encryption is off');
    }
    return row;
  }

  /** The key file, or null when there is none. Throws when one is on disk but can't be used. */
  private async readKeyFile(userId: string): Promise<LockedKeyFile | null> {
    let file: LockedKeyFile | null;
    try {
      file = await this.lockedKeyRepository.read(userId);
    } catch {
      // never the error itself: it could quote the file
      this.logger.error(`The Locked key file of user ${userId} can't be read`);
      throw unreadableKeyFile();
    }
    if (!file && (await this.lockedKeyRepository.exists(userId))) {
      this.logger.error(`The Locked key file of user ${userId} isn't a key file for them`);
      throw unreadableKeyFile();
    }
    return file;
  }

  private async requireKeyFile(userId: string): Promise<LockedKeyFile> {
    const file = await this.readKeyFile(userId);
    if (!file) {
      throw new ConflictException('Your Locked key file is missing from this server. Restore it from a backup.');
    }
    return file;
  }

  /** Only a PIN-only key pair that encrypts nothing may be replaced (spec §4.1); never one in use. */
  private isReplaceable(file: LockedKeyFile, encryptionOn: boolean) {
    return !encryptionOn && file.mode === 'pin' && !file.encrypting;
  }

  /** The private key of `file`: a copy of the loaded one, or unwrapped with the PIN. Null if neither works. */
  private async privateKeyOf(userId: string, file: LockedKeyFile, pinCode?: string): Promise<Buffer | null> {
    const held = this.held(userId);
    if (held && held.publicKey.equals(Buffer.from(file.publicKey, 'base64'))) {
      return Buffer.from(held.privateKey);
    }
    if (!pinCode || file.mode !== 'pin') {
      return null;
    }
    try {
      return await unwrapKey(file, 'pin', pinCode);
    } catch (error) {
      if (error instanceof WrongSecretError) {
        return null;
      }
      throw error;
    }
  }

  private async newPinKeyPair(userId: string, pinCode: string) {
    const { publicKey, privateKey } = generateKeyPair();
    const now = new Date().toISOString();
    const user = await this.userRepository.get(userId, {});
    try {
      const file = await wrapKey(
        {
          format: FORMAT,
          userId,
          label: user?.name ?? '',
          publicKey: publicKey.toString('base64'),
          mode: 'pin',
          encrypting: false,
          createdAt: now,
          updatedAt: now,
        },
        privateKey,
        'pin',
        pinCode,
      );
      return { file, privateKey };
    } catch (error) {
      privateKey.fill(0);
      throw error;
    }
  }

  private async newPinKeyFile(userId: string, pinCode: string) {
    const { file, privateKey } = await this.newPinKeyPair(userId, pinCode);
    privateKey.fill(0);
    return file;
  }

  /**
   * Puts back the key file a failed change replaced, or removes the one it created, but only while
   * the file on disk is still the one this change wrote: never another change's file.
   */
  private async restoreKeyFile(userId: string, previous: LockedKeyFile | null, written: LockedKeyFile) {
    const current = await this.lockedKeyRepository.read(userId).catch(() => null);
    if (current?.publicKey !== written.publicKey || current.updatedAt !== written.updatedAt) {
      this.logger.warn(`Left the Locked key file of user ${userId} as it is: another change wrote it`);
      return;
    }
    await (previous ? this.lockedKeyRepository.write(previous) : this.lockedKeyRepository.delete(userId));
  }

  /** Runs `change` after every earlier key-file change of this person has finished (see `keyFileChanges`). */
  async withKeyFileLock<T>(userId: string, change: () => Promise<T>): Promise<T> {
    const previous = keyFileChanges.get(userId);
    const { promise, resolve } = Promise.withResolvers<void>();
    keyFileChanges.set(userId, promise);
    await previous;
    try {
      return await change();
    } finally {
      resolve();
      if (keyFileChanges.get(userId) === promise) {
        keyFileChanges.delete(userId);
      }
    }
  }

  /** Checks the Locked PIN against the account, under PIN unlock's attempt limit. */
  private async verifyPin(userId: string, pinCode: string) {
    await checkSecret(userId, async (verify) => {
      const user = await this.userRepository.getForPinCode(userId);
      if (!user.pinCode) {
        throw new BadRequestException('Set a Locked PIN first');
      }
      await verify(async () => {
        if (!(await this.cryptoRepository.compareBcrypt(pinCode, user.pinCode!))) {
          throw new UnauthorizedException('Wrong PIN code');
        }
      });
    });
  }

  /** Unwraps the private key with a secret, under PIN unlock's attempt limit. 401 when it doesn't open. */
  private unwrap(userId: string, file: LockedKeyFile, kind: WrapKind, secret: string): Promise<Buffer> {
    return checkSecret(
      userId,
      (verify) =>
        verify(async () => {
          try {
            return await unwrapKey(file, kind, secret);
          } catch (error) {
            if (error instanceof WrongSecretError) {
              throw new UnauthorizedException(kind === 'pin' ? 'Wrong PIN code' : `Wrong ${secretName(kind)}`);
            }
            throw error;
          }
        }),
      secretName(kind),
    );
  }

  /** Stores a new Locked PIN, which ends every PIN unlock of the account; `undo` runs if it isn't stored. */
  private async setPin(userId: string, pinCode: string, undo: () => Promise<void>) {
    const verified = await this.userRepository.getForPinCode(userId);
    const hashed = await this.cryptoRepository.hashBcrypt(pinCode, SALT_ROUNDS);
    let stored = false;
    try {
      stored = await this.userRepository.setPinCodeAndLockSessions(userId, verified, hashed);
    } finally {
      if (!stored) {
        await undo();
      }
    }
    if (!stored) {
      throw new UnauthorizedException('Your PIN or password changed; try again');
    }
    this.websocketRepository.clientSend('on_session_lock', userId);
  }

  private askAgainExpiry(hours: number | null) {
    return hours ? new Date(Date.now() + hours * HOUR_MS) : null;
  }

  private held(userId: string) {
    return lockedKeys.list().find((key) => key.userId === userId);
  }

  /** Keeps the loaded key of `file` until `until` if that is later. False when it isn't loaded. */
  private extend(userId: string, file: LockedKeyFile, until: Date): boolean {
    const held = this.held(userId);
    if (!held || !held.publicKey.equals(Buffer.from(file.publicKey, 'base64'))) {
      return false;
    }
    if (held.expiresAt && held.expiresAt < until) {
      lockedKeys.load(userId, held.publicKey, held.privateKey, until);
      this.publishLoad(userId, file.publicKey, held.privateKey, until);
    }
    return true;
  }

  /** Hands the key to this process's holder (which then owns the buffer) and to the job workers. */
  private load(userId: string, file: LockedKeyFile, privateKey: Buffer, expiresAt: Date | null, pinned = false) {
    try {
      lockedKeys.load(userId, Buffer.from(file.publicKey, 'base64'), privateKey, expiresAt);
    } catch (error) {
      privateKey.fill(0);
      throw error;
    }
    this.publishLoad(userId, file.publicKey, privateKey, expiresAt);
    if (pinned) {
      lockedKeys.pin(userId, true);
      publishLockedKey({ type: 'locked-key', action: 'pin', userId });
    }
  }

  private publishLoad(userId: string, publicKey: string, privateKey: Buffer, expiresAt: Date | null) {
    publishLockedKey({
      type: 'locked-key',
      action: 'load',
      userId,
      publicKey,
      privateKey: privateKey.toString('base64'),
      expiresAt: expiresAt?.toISOString() ?? null,
      grants: lockedKeys.grantsOf(userId),
    });
  }

  private drop(userId: string) {
    lockedKeys.drop(userId);
    publishLockedKey({ type: 'locked-key', action: 'drop', userId });
  }

  private async queueFor(userId: string, name: JobName.LockedUnseal | JobName.LockedRewrap) {
    const assets = await this.lockedEncryptionRepository.getLockedAssets(userId);
    const jobs = assets.filter((asset) => asset.encryptable).map(({ id }) => ({ name, data: { id } }));
    if (jobs.length > 0) {
      await this.jobRepository.queueAll(jobs);
    }
  }

  /** How many of these items' originals are encrypted now (they start with `FLLK`, spec §5). */
  private async countEncrypted(assets: LockedEncryptionAsset[]): Promise<number> {
    let count = 0;
    for (let index = 0; index < assets.length; index += COUNT_CONCURRENCY) {
      const batch = assets.slice(index, index + COUNT_CONCURRENCY);
      const sealed = await Promise.all(batch.map(({ originalPath }) => isLockedFile(originalPath).catch(() => false)));
      count += sealed.filter(Boolean).length;
    }
    return count;
  }
}
