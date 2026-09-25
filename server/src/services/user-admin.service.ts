import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SALT_ROUNDS } from 'src/constants.js';
import { UserAdmin } from 'src/database.js';
import { AssetStatsDto, AssetStatsResponseDto, mapStats } from 'src/dtos/asset.dto.js';
import { CalendarHeatmapDto, CalendarHeatmapResponseDto } from 'src/dtos/calendar-heatmap.dto.js';
import { SessionResponseDto, mapSession } from 'src/dtos/session.dto.js';
import { UserPreferencesResponseDto, UserPreferencesUpdateDto, mapPreferences } from 'src/dtos/user-preferences.dto.js';
import {
  UserAdminCreateDto,
  UserAdminDeleteDto,
  UserAdminHistoryResponseDto,
  UserAdminHistorySearchDto,
  UserAdminPinCodeStateResponseDto,
  UserAdminResponseDto,
  UserAdminSearchDto,
  UserAdminUpdateDto,
  mapUserAdmin,
} from 'src/dtos/user.dto.js';
import { AdminAuditAction, AssetVisibility, JobName, UserMetadataKey, UserStatus } from 'src/enum.js';
import { UserFindOptions } from 'src/repositories/user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getCalendarHeatmap } from 'src/services/shared/user-methods.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getLockedOwnerId } from 'src/utils/locked-visibility.js';
import { findOrFail } from 'src/utils/misc.js';
import { getPreferences, getPreferencesPartial, mergePreferences } from 'src/utils/preferences.js';

/** One entry for the administrator audit trail about an account (FL-76). */
const accountEvent = (
  auth: AuthDto,
  user: { id: string; name: string },
  action: AdminAuditAction,
  detail: string | null = null,
) => ({ userId: user.id, actorId: auth.user.id, action, subject: user.name, detail });

type AccountEvent = ReturnType<typeof accountEvent>;
type Preferences = ReturnType<typeof getPreferences>;

/** The default page size of an account's history (FL-76). */
const HISTORY_PAGE_SIZE = 50;

@Injectable()
export class UserAdminService extends BaseService {
  async search(auth: AuthDto, dto: UserAdminSearchDto): Promise<UserAdminResponseDto[]> {
    const users = await this.userRepository.getList({
      id: dto.id,
      withDeleted: dto.withDeleted,
    });
    return users.map((user) => mapUserAdmin(user));
  }

  async create(auth: AuthDto, dto: UserAdminCreateDto): Promise<UserAdminResponseDto> {
    const { notify, ...userDto } = dto;
    const config = await this.getConfig({ withCache: false });
    if (!config.oauth.enabled && !userDto.password) {
      throw new BadRequestException('password is required');
    }

    const user = await this.createUser(userDto);

    await this.eventRepository.emit('UserSignup', {
      notify: !!notify,
      id: user.id,
      password: userDto.password,
    });

    await this.recordAdminEvents([accountEvent(auth, user, AdminAuditAction.AccountCreated)]);

    return mapUserAdmin(user);
  }

  async get(auth: AuthDto, id: string): Promise<UserAdminResponseDto> {
    const user = await this.findOrFail(id, { withDeleted: true });
    return mapUserAdmin(user);
  }

  async update(auth: AuthDto, id: string, dto: UserAdminUpdateDto): Promise<UserAdminResponseDto> {
    const user = await this.findOrFail(id, {});

    if (dto.isAdmin !== undefined && dto.isAdmin !== auth.user.isAdmin && auth.user.id === id) {
      throw new BadRequestException('Admin status can only be changed by another admin');
    }

    if (dto.quotaSizeInBytes && user.quotaSizeInBytes !== dto.quotaSizeInBytes) {
      await this.userRepository.syncUsage(id);
    }

    if (dto.email) {
      const duplicate = await this.userRepository.getByEmail(dto.email);
      if (duplicate && duplicate.id !== id) {
        this.logger.debug('Email already in use by another account');
        throw new BadRequestException('Email is not available');
      }
    }

    if (dto.storageLabel) {
      const duplicate = await this.userRepository.getByStorageLabel(dto.storageLabel, true);
      if (duplicate && duplicate.id !== id) {
        throw new BadRequestException('Storage label already in use by another account');
      }
    }

    if (dto.password) {
      dto.password = await this.cryptoRepository.hashBcrypt(dto.password, SALT_ROUNDS);
    }

    if (dto.pinCode) {
      dto.pinCode = await this.cryptoRepository.hashBcrypt(dto.pinCode, SALT_ROUNDS);
    }

    if (dto.storageLabel === '') {
      dto.storageLabel = null;
    }

    const updatedUser = await this.userRepository.update(id, { ...dto, updatedAt: new Date() });

    /*
     * FL-76: setting, changing or clearing a PIN has to drop the elevated state of that
     * account's existing sessions, the same way `AuthService.resetPinCode` does for the
     * owner's own reset. Without this an administrator "reset PIN" would leave a session
     * that had already unlocked with the old PIN holding `pinExpiresAt` in the future, and
     * that session keeps reaching Locked content for the rest of its elevation window.
     * `undefined` means the update never mentioned the PIN, so nothing is locked then.
     * FL-34: a password reset revokes elevation the same way, and the account's open tabs are
     * told (`on_session_lock`) so none keeps showing what it had unlocked.
     */
    if (dto.password !== undefined || dto.pinCode !== undefined) {
      await this.sessionRepository.lockAll(id);
      this.websocketRepository.clientSend('on_session_lock', id);
    }

    await this.recordAdminEvents(this.getUpdateEvents(auth, user, updatedUser, dto));

    return mapUserAdmin(updatedUser);
  }

  /**
   * FL-76: what an account update changed, one audit entry per kind of change. It compares the
   * account before and after, so a field sent unchanged records nothing. A password or PIN is
   * recorded as having been reset or set, never with its value.
   */
  private getUpdateEvents(auth: AuthDto, before: UserAdmin, after: UserAdmin, dto: UserAdminUpdateDto) {
    const events: AccountEvent[] = [];
    const add = (action: AdminAuditAction, detail: string | null = null) => {
      events.push(accountEvent(auth, after, action, detail));
    };

    const profileChanged =
      (dto.name !== undefined && dto.name !== before.name) ||
      (dto.email !== undefined && dto.email !== before.email) ||
      (dto.avatarColor !== undefined && dto.avatarColor !== before.avatarColor) ||
      (!dto.password &&
        dto.shouldChangePassword !== undefined &&
        dto.shouldChangePassword !== before.shouldChangePassword);
    if (profileChanged) {
      add(AdminAuditAction.AccountUpdated);
    }

    if (dto.isAdmin !== undefined && after.isAdmin !== before.isAdmin) {
      add(after.isAdmin ? AdminAuditAction.AdminGranted : AdminAuditAction.AdminRevoked);
    }

    if (dto.quotaSizeInBytes !== undefined && after.quotaSizeInBytes !== before.quotaSizeInBytes) {
      add(AdminAuditAction.QuotaChanged, after.quotaSizeInBytes === null ? null : String(after.quotaSizeInBytes));
    }

    if (dto.storageLabel !== undefined && after.storageLabel !== before.storageLabel) {
      add(AdminAuditAction.StorageLabelChanged, after.storageLabel);
    }

    if (dto.password) {
      add(AdminAuditAction.PasswordReset, after.shouldChangePassword ? 'change-required' : null);
    }

    if (dto.pinCode !== undefined) {
      add(dto.pinCode === null ? AdminAuditAction.PinReset : AdminAuditAction.PinSet);
    }

    return events;
  }

  async delete(auth: AuthDto, id: string, dto: UserAdminDeleteDto): Promise<UserAdminResponseDto> {
    const { force } = dto;
    await this.findOrFail(id, {});
    if (auth.user.id === id) {
      throw new ForbiddenException('Cannot delete your own account');
    }
    await this.assertNotDeduplicationRetainedAccount(id);

    await this.albumRepository.softDeleteAll(id);

    const status = force ? UserStatus.Removing : UserStatus.Deleted;
    const user = await this.userRepository.update(id, { status, deletedAt: new Date() });

    // FL-76: deleting an account signs out its devices, as the delete dialog says, so a restored
    // account signs in again rather than resuming the sessions it had before
    const deletedIds = await this.sessionRepository.invalidateAll({ userId: id });
    for (const sessionId of deletedIds) {
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }

    await this.eventRepository.emit('UserTrash', user);

    if (force) {
      await this.jobRepository.queue({ name: JobName.UserDelete, data: { id: user.id, force } });
      await this.recordAdminEvents([accountEvent(auth, user, AdminAuditAction.AccountRemovalScheduled)]);
    } else {
      const { user: userConfig } = await this.getConfig({ withCache: true });
      await this.recordAdminEvents([
        accountEvent(auth, user, AdminAuditAction.AccountDeleted, String(userConfig.deleteDelay)),
      ]);
    }

    return mapUserAdmin(user);
  }

  /**
   * FL-44 (FN-304): the account physical deduplication retains originals in holds files other
   * accounts' photos point at. Deleting it would take those files with it, so it cannot be deleted
   * until another account is chosen to retain originals (Settings, Storage template, Physical deduplication).
   */
  private async assertNotDeduplicationRetainedAccount(id: string) {
    const { physicalDeduplication } = await this.getConfig({ withCache: false });
    if (physicalDeduplication.masterUserId === id) {
      throw new BadRequestException(
        'This account keeps the original files shared by physical deduplication. Choose another account to keep originals in the storage template settings before deleting it.',
      );
    }
  }

  async restore(auth: AuthDto, id: string): Promise<UserAdminResponseDto> {
    await this.findOrFail(id, { withDeleted: true });
    await this.albumRepository.restoreAll(id);
    const user = await this.userRepository.restore(id);
    await this.eventRepository.emit('UserRestore', user);
    await this.recordAdminEvents([accountEvent(auth, user, AdminAuditAction.AccountRestored)]);
    return mapUserAdmin(user);
  }

  async getCalendarHeatmap(auth: AuthDto, id: string, dto: CalendarHeatmapDto): Promise<CalendarHeatmapResponseDto> {
    await this.findOrFail(id, { withDeleted: false });
    // an administrator never counts anyone's Locked media, their own included: there is no elevated
    // owner to name here (FL-34)
    return getCalendarHeatmap(id, dto, { asset: this.assetRepository });
  }

  async getSessions(auth: AuthDto, id: string): Promise<SessionResponseDto[]> {
    const sessions = await this.sessionRepository.getByUserId(id);
    // `auth.session` is always the administrator's own current session. It only ever matches one
    // of `id`'s sessions when the administrator is looking at their own account, so this is safe
    // to pass unconditionally rather than branching on `id === auth.user.id` (FL-76).
    return sessions.map((session) => mapSession(session, auth.session?.id));
  }

  /**
   * FL-76: the admin revoke endpoint `SessionService.delete` cannot offer, because that one is
   * scoped to the caller's own sessions (`Permission.AuthDeviceDelete`). Confirming the session
   * belongs to `id` first keeps this from becoming a delete-any-session-by-id endpoint.
   */
  async deleteSession(auth: AuthDto, id: string, sessionId: string): Promise<void> {
    const user = await this.findOrFail(id, { withDeleted: true });
    const sessions = await this.sessionRepository.getByUserId(id);
    const session = sessions.find((session) => session.id === sessionId);
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    await this.sessionRepository.delete(sessionId);
    await this.eventRepository.emit('SessionDelete', { sessionId });

    // the device as the Security tab names it: operating system · device type
    const device = [session.deviceOS, session.deviceType].filter(Boolean).join(' · ') || null;
    await this.recordAdminEvents([accountEvent(auth, user, AdminAuditAction.SessionRevoked, device)]);
  }

  /**
   * FL-76: the account's administrator history, newest first, for the account detail's Activity
   * tab. Admin-only (`AdminUserRead`). It names what was changed, never a password, PIN or photo.
   */
  async getHistory(auth: AuthDto, id: string, dto: UserAdminHistorySearchDto): Promise<UserAdminHistoryResponseDto> {
    await this.findOrFail(id, { withDeleted: true });
    const take = dto.take ?? HISTORY_PAGE_SIZE;
    // one extra row says whether an older page exists
    const rows = await this.adminAuditRepository.getByUserId(id, { before: dto.before, take: take + 1 });

    return {
      events: rows.slice(0, take).map((row) => ({
        id: row.id,
        action: row.action,
        subject: row.subject,
        detail: row.detail,
        libraryId: row.libraryId,
        actorId: row.actorId,
        actorName: row.actorName,
        createdAt: asDateTimeString(row.createdAt),
      })),
      hasMore: rows.length > take,
    };
  }

  /**
   * FL-76 (CC-30): whether the account has a PIN, so its Security tab offers Set PIN or Change PIN
   * and Reset PIN. Admin-only (`AdminUserRead`); only the presence is read, never the PIN.
   */
  async getPinCodeState(auth: AuthDto, id: string): Promise<UserAdminPinCodeStateResponseDto> {
    const pinCode = await this.userRepository.hasPinCode(id);
    if (pinCode === undefined) {
      throw new NotFoundException('User not found');
    }
    return { pinCode };
  }

  async getStatistics(auth: AuthDto, id: string, dto: AssetStatsDto): Promise<AssetStatsResponseDto> {
    // an administrator never counts someone's Locked media: only its owner's elevated session does (FL-34)
    if (dto.visibility === AssetVisibility.Locked && !(id === auth.user.id && getLockedOwnerId(auth))) {
      throw new ForbiddenException('Locked media statistics are only available to their owner');
    }

    const stats = await this.assetRepository.getStatistics(id, dto);
    return mapStats(stats);
  }

  async getPreferences(auth: AuthDto, id: string): Promise<UserPreferencesResponseDto> {
    await this.findOrFail(id, { withDeleted: true });
    const metadata = await this.userRepository.getMetadata(id);
    return mapPreferences(getPreferences(metadata), 'admin');
  }

  async updatePreferences(auth: AuthDto, id: string, dto: UserPreferencesUpdateDto) {
    const user = await this.findOrFail(id, { withDeleted: false });
    // FL-67: under the account's preferences lock, so an administrator's save can never write back
    // Locked rules (or anything else) the account changed between this read and the write.
    // FL-76: `mergePreferences` changes the object it is given, so keep a separate copy to compare with.
    let previous: Preferences | undefined;
    const newPreferences = await this.databaseRepository.withUserPreferencesLock(id, async (trx) => {
      const metadata = await this.userRepository.getMetadata(id, trx);
      previous = getPreferences(metadata);
      const merged = mergePreferences(getPreferences(metadata), dto, 'admin');
      await this.userRepository.upsertMetadata(
        id,
        { key: UserMetadataKey.Preferences, value: getPreferencesPartial(merged) },
        trx,
      );
      return merged;
    });

    await this.recordAdminEvents(this.getPreferencesEvents(auth, user, previous ?? newPreferences, newPreferences));

    return mapPreferences(newPreferences, 'admin');
  }

  /**
   * FL-76: what an administrator's preferences save changed. Turning casting off or on is its own
   * entry; every other change is one entry naming the preference sections it touched.
   */
  private getPreferencesEvents(auth: AuthDto, user: UserAdmin, previous: Preferences, next: Preferences) {
    const events: AccountEvent[] = [];

    const changed = (key: keyof Preferences) => {
      if (key === 'cast') {
        // turning casting off or on is its own entry below; only the account's own choice counts here
        return previous.cast.gCastEnabled !== next.cast.gCastEnabled;
      }
      return !isDeepStrictEqual(previous[key], next[key]);
    };
    const keys = Object.keys(next) as Array<keyof Preferences>;
    const sections = keys.filter((key) => changed(key)).toSorted((a, b) => a.localeCompare(b));
    if (sections.length > 0) {
      events.push(accountEvent(auth, user, AdminAuditAction.PreferencesUpdated, sections.join(',')));
    }

    if (previous.cast.adminDisabled !== next.cast.adminDisabled) {
      const action = next.cast.adminDisabled ? AdminAuditAction.CastingDisabled : AdminAuditAction.CastingAllowed;
      events.push(accountEvent(auth, user, action));
    }

    return events;
  }

  private findOrFail(id: string, options: UserFindOptions) {
    return findOrFail(() => this.userRepository.get(id, options), 'User');
  }
}
