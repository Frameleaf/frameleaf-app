import { NotificationLevel, NotificationType } from '@frameleaf/sdk';
import {
  mdiAccountMultiplePlusOutline,
  mdiCheckCircleOutline,
  mdiCloudOutline,
  mdiHarddisk,
  mdiImageMultipleOutline,
  mdiInformationOutline,
} from '@mdi/js';
import { notificationIcon, notificationIcons, notificationKind } from './notification-kind';

const notice = (type: NotificationType, level = NotificationLevel.Info, dedupeKey?: string) => ({
  type,
  level,
  data: dedupeKey ? { dedupeKey } : undefined,
});

describe('notificationKind', () => {
  it.each([
    [NotificationType.AlbumInvite, 'invitation'],
    [NotificationType.AlbumUpdate, 'photos'],
    [NotificationType.ItemShare, 'share'],
    [NotificationType.SharedSpaceMention, 'mention'],
    [NotificationType.SharedSpaceReply, 'reply'],
    [NotificationType.BackupFailed, 'backup'],
    [NotificationType.JobFailed, 'failed'],
  ])('knows %s by its type: %s', (type, kind) => {
    expect(notificationKind(notice(type, NotificationLevel.Error))).toBe(kind);
  });

  it.each([
    ['buddy:capacity', 'storage'],
    ['buddy:incomplete', 'backup'],
    ['cloud-backup:failed', 'backup'],
    ['cloud-backup-attention/abc', 'backup'],
    ['library-snapshot-failed', 'backup'],
    ['frameleaf-cloud:revoked', 'cloud'],
    ['frameleaf-license:expired:abc', 'licence'],
    ['frameleaf-mail:needs-sign-in', 'mail'],
    ['frameleaf-remote:relay', 'remote'],
    ['memories/owner/2026-11-10', 'memories'],
  ])('reads what a system message is about from its key: %s is %s', (key, kind) => {
    expect(notificationKind(notice(NotificationType.SystemMessage, NotificationLevel.Warning, key))).toBe(kind);
  });

  it('falls back to the level: finished work, something to look at, or plain information', () => {
    expect(notificationKind(notice(NotificationType.Custom, NotificationLevel.Success))).toBe('done');
    expect(notificationKind(notice(NotificationType.SystemMessage, NotificationLevel.Warning))).toBe('attention');
    expect(notificationKind(notice(NotificationType.Custom, NotificationLevel.Error))).toBe('attention');
    expect(notificationKind(notice(NotificationType.SystemMessage))).toBe('system');
    expect(notificationKind(notice(NotificationType.Custom, NotificationLevel.Info, 'something-new'))).toBe('system');
    expect(notificationKind({ ...notice(NotificationType.Custom), data: { dedupeKey: 7 } })).toBe('system');
  });

  it('gives each kind its own icon, the prototype’s for the kinds it draws', () => {
    expect(new Set(Object.values(notificationIcons)).size).toBe(Object.keys(notificationIcons).length);
    expect(notificationIcon(notice(NotificationType.AlbumInvite))).toBe(mdiAccountMultiplePlusOutline);
    expect(notificationIcon(notice(NotificationType.AlbumUpdate))).toBe(mdiImageMultipleOutline);
    expect(notificationIcon(notice(NotificationType.Custom, NotificationLevel.Success))).toBe(mdiCheckCircleOutline);
    expect(notificationIcon(notice(NotificationType.SystemMessage, NotificationLevel.Warning, 'buddy:capacity'))).toBe(
      mdiHarddisk,
    );
    expect(
      notificationIcon(notice(NotificationType.SystemMessage, NotificationLevel.Info, 'frameleaf-cloud:linked:1')),
    ).toBe(mdiCloudOutline);
    expect(notificationIcon(notice(NotificationType.SystemMessage))).toBe(mdiInformationOutline);
  });
});
