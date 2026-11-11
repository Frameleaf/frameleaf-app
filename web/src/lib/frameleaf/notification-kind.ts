/**
 * What a notification is about, which picks its icon (prototype `system-data.mjs`
 * `notificationTypes`; UI review 2026-11-10, A7). Most of what the server sends is a
 * `SystemMessage`, so the type alone gave every row the same icon.
 *
 * ponytail: for system messages the subject is read from the start of the notice's `dedupeKey`,
 * the only thing that names it today. A notice with no key falls back to its level. If the server
 * ever sends the subject on `data`, read that here instead.
 */
import { NotificationLevel, NotificationType, type NotificationDto } from '@frameleaf/sdk';
import {
  mdiAccountMultiplePlusOutline,
  mdiAlertOutline,
  mdiAt,
  mdiBackupRestore,
  mdiCheckCircleOutline,
  mdiCloudOutline,
  mdiEmailOutline,
  mdiHarddisk,
  mdiHistory,
  mdiImageMultipleOutline,
  mdiInformationOutline,
  mdiKeyOutline,
  mdiReply,
  mdiShareVariantOutline,
  mdiSync,
  mdiWeb,
} from '@mdi/js';

export type NotificationKind =
  | 'invitation'
  | 'photos'
  | 'share'
  | 'mention'
  | 'reply'
  | 'storage'
  | 'backup'
  | 'cloud'
  | 'licence'
  | 'mail'
  | 'remote'
  | 'memories'
  | 'failed'
  | 'done'
  | 'attention'
  | 'system';

export const notificationIcons: Record<NotificationKind, string> = {
  invitation: mdiAccountMultiplePlusOutline,
  photos: mdiImageMultipleOutline,
  share: mdiShareVariantOutline,
  mention: mdiAt,
  reply: mdiReply,
  storage: mdiHarddisk,
  backup: mdiBackupRestore,
  cloud: mdiCloudOutline,
  licence: mdiKeyOutline,
  mail: mdiEmailOutline,
  remote: mdiWeb,
  memories: mdiHistory,
  failed: mdiSync,
  done: mdiCheckCircleOutline,
  attention: mdiAlertOutline,
  system: mdiInformationOutline,
};

const BY_TYPE: Partial<Record<NotificationType, NotificationKind>> = {
  [NotificationType.AlbumInvite]: 'invitation',
  [NotificationType.AlbumUpdate]: 'photos',
  [NotificationType.ItemShare]: 'share',
  [NotificationType.SharedSpaceMention]: 'mention',
  [NotificationType.SharedSpaceReply]: 'reply',
};

/** The start of a notice's `dedupeKey`, most specific first. */
const BY_SUBJECT: readonly (readonly [string, NotificationKind])[] = [
  ['buddy:capacity', 'storage'],
  ['buddy:', 'backup'],
  ['cloud-backup', 'backup'],
  ['backup-attention', 'backup'],
  ['library-snapshot', 'backup'],
  ['frameleaf-cloud:', 'cloud'],
  ['frameleaf-license:', 'licence'],
  ['frameleaf-mail:', 'mail'],
  ['frameleaf-remote:', 'remote'],
  ['memories', 'memories'],
];

const BY_LEVEL: Partial<Record<NotificationLevel, NotificationKind>> = {
  [NotificationLevel.Success]: 'done',
  [NotificationLevel.Warning]: 'attention',
  [NotificationLevel.Error]: 'attention',
};

export const notificationKind = ({ type, level, data }: Pick<NotificationDto, 'type' | 'level' | 'data'>) => {
  const byType = BY_TYPE[type];
  if (byType) {
    return byType;
  }
  const key = (data as { dedupeKey?: unknown } | undefined)?.dedupeKey;
  const subject = typeof key === 'string' ? BY_SUBJECT.find(([start]) => key.startsWith(start))?.[1] : undefined;
  if (subject) {
    return subject;
  }
  if (type === NotificationType.BackupFailed) {
    return 'backup';
  }
  if (type === NotificationType.JobFailed) {
    return 'failed';
  }
  return BY_LEVEL[level] ?? 'system';
};

export const notificationIcon = (notification: Pick<NotificationDto, 'type' | 'level' | 'data'>) =>
  notificationIcons[notificationKind(notification)];
