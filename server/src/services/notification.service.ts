import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AdminNotice, ArgOf } from 'src/repositories/event.repository.js';
import type { EmailImageAttachment, JobOf, UserMetadataItem } from 'src/types.js';
import { JOBS_WITH_SENSITIVE_DATA } from 'src/constants.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { MapAlbumDto } from 'src/dtos/album.dto.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { SystemConfigSmtpDto } from 'src/dtos/config.dto.js';
import {
  NotificationDeleteAllDto,
  NotificationDto,
  NotificationSearchDto,
  NotificationUpdateAllDto,
  NotificationUpdateDto,
  mapNotification,
} from 'src/dtos/notification.dto.js';
import {
  AssetFileType,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  Permission,
  QueueName,
} from 'src/enum.js';
import { EmailTemplate } from 'src/repositories/email.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getFilenameExtension } from 'src/utils/file.js';
import { type HiddenContentFilter, hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { isNsfwHidingEnabled } from 'src/utils/misc.js';
import { isEqualObject } from 'src/utils/object.js';
import { getPreferences } from 'src/utils/preferences.js';

@Injectable()
export class NotificationService extends BaseService {
  private static albumUpdateEmailDelayMs = 300_000;

  async search(auth: AuthDto, dto: NotificationSearchDto): Promise<NotificationDto[]> {
    const items = await this.notificationRepository.search(auth.user.id, dto);
    return items.map((item) => mapNotification(item));
  }

  async updateAll(auth: AuthDto, dto: NotificationUpdateAllDto) {
    await this.requireAccess({ auth, ids: dto.ids, permission: Permission.NotificationUpdate });
    await this.notificationRepository.updateAll(dto.ids, {
      readAt: dto.readAt,
    });
  }

  async deleteAll(auth: AuthDto, dto: NotificationDeleteAllDto) {
    await this.requireAccess({ auth, ids: dto.ids, permission: Permission.NotificationDelete });
    await this.notificationRepository.deleteAll(dto.ids);
  }

  async get(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, ids: [id], permission: Permission.NotificationRead });
    const item = await this.notificationRepository.get(id);
    if (!item) {
      throw new BadRequestException('Notification not found');
    }
    return mapNotification(item);
  }

  async update(auth: AuthDto, id: string, dto: NotificationUpdateDto) {
    await this.requireAccess({ auth, ids: [id], permission: Permission.NotificationUpdate });
    const item = await this.notificationRepository.update(id, {
      readAt: dto.readAt,
    });
    return mapNotification(item);
  }

  async delete(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, ids: [id], permission: Permission.NotificationDelete });
    await this.notificationRepository.delete(id);
  }

  @OnJob({ name: JobName.NotificationsCleanup, queue: QueueName.BackgroundTask })
  async onNotificationsCleanup() {
    await this.notificationRepository.cleanup();
  }

  @OnEvent({ name: 'JobError' })
  async onJobError({ job, error }: ArgOf<'JobError'>) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }

    // FL-71: the signup notice and its mail carry a password, which never goes to the log
    const data = JOBS_WITH_SENSITIVE_DATA.has(job.name) ? '[redacted]' : JSON.stringify(job.data);
    this.logger.error(`Unable to run job handler (${job.name}): ${error}`, error?.stack, data);

    switch (job.name) {
      case JobName.DatabaseBackup: {
        const errorMessage = error instanceof Error ? error.message : error;
        const item = await this.notificationRepository.create({
          userId: admin.id,
          type: NotificationType.JobFailed,
          level: NotificationLevel.Error,
          title: 'Job Failed',
          description: `Job ${[job.name]} failed with error: ${errorMessage}`,
        });

        this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(item));
        break;
      }

      default: {
        return;
      }
    }
  }

  @OnEvent({ name: 'ConfigUpdate' })
  onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    this.websocketRepository.clientBroadcast('on_config_update');
    this.websocketRepository.serverSend('ConfigUpdate', { oldConfig, newConfig });
  }

  @OnEvent({ name: 'AppRestart' })
  onAppRestart(state: ArgOf<'AppRestart'>) {
    this.websocketRepository.clientBroadcast('AppRestartV1', {
      isMaintenanceMode: state.isMaintenanceMode,
    });

    this.websocketRepository.serverSend('AppRestart', state);
  }

  @OnEvent({ name: 'ConfigValidate', priority: -100 })
  async onConfigValidate({ oldConfig, newConfig }: ArgOf<'ConfigValidate'>) {
    try {
      if (
        newConfig.notifications.smtp.enabled &&
        !isEqualObject(oldConfig.notifications.smtp, newConfig.notifications.smtp)
      ) {
        await this.emailRepository.verifySmtp(newConfig.notifications.smtp.transport);
      }
    } catch (error: Error | any) {
      this.logger.error(`Failed to validate SMTP configuration: ${error}`, error?.stack);
      throw new Error('Invalid SMTP configuration', { cause: error });
    }
  }

  @OnEvent({ name: 'AssetHide' })
  onAssetHide({ assetId, userId }: ArgOf<'AssetHide'>) {
    this.websocketRepository.clientSend('on_asset_hidden', userId, assetId);
  }

  @OnEvent({ name: 'AssetShow' })
  async onAssetShow({ assetId }: ArgOf<'AssetShow'>) {
    await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: { id: assetId, notify: true } });
  }

  @OnEvent({ name: 'AssetTrash' })
  onAssetTrash({ assetId, userId }: ArgOf<'AssetTrash'>) {
    this.websocketRepository.clientSend('on_asset_trash', userId, [assetId]);
  }

  @OnEvent({ name: 'AssetDelete' })
  onAssetDelete({ assetId, userId }: ArgOf<'AssetDelete'>) {
    this.websocketRepository.clientSend('on_asset_delete', userId, assetId);
  }

  @OnEvent({ name: 'AssetTrashAll' })
  onAssetsTrash({ assetIds, userId }: ArgOf<'AssetTrashAll'>) {
    this.websocketRepository.clientSend('on_asset_trash', userId, assetIds);
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ assetId, userId, source }: ArgOf<'AssetMetadataExtracted'>) {
    if (source !== 'sidecar-write') {
      return;
    }

    const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([assetId], userId);
    if (asset) {
      this.websocketRepository.clientSend(
        'on_asset_update',
        userId,
        mapAsset(asset, { auth: { user: { id: userId } } as AuthDto }),
      );
    }
  }

  @OnEvent({ name: 'AssetRestoreAll' })
  onAssetsRestore({ assetIds, userId }: ArgOf<'AssetRestoreAll'>) {
    this.websocketRepository.clientSend('on_asset_restore', userId, assetIds);
  }

  @OnEvent({ name: 'StackCreate' })
  onStackCreate({ userId }: ArgOf<'StackCreate'>) {
    this.websocketRepository.clientSend('on_asset_stack_update', userId);
  }

  @OnEvent({ name: 'StackUpdate' })
  onStackUpdate({ userId }: ArgOf<'StackUpdate'>) {
    this.websocketRepository.clientSend('on_asset_stack_update', userId);
  }

  @OnEvent({ name: 'StackDelete' })
  onStackDelete({ userId }: ArgOf<'StackDelete'>) {
    this.websocketRepository.clientSend('on_asset_stack_update', userId);
  }

  @OnEvent({ name: 'StackDeleteAll' })
  onStacksDelete({ userId }: ArgOf<'StackDeleteAll'>) {
    this.websocketRepository.clientSend('on_asset_stack_update', userId);
  }

  @OnEvent({ name: 'UserSignup' })
  async onUserSignup({ notify, id, password: password }: ArgOf<'UserSignup'>) {
    if (notify) {
      await this.jobRepository.queue({ name: JobName.NotifyUserSignup, data: { id, password } });
    }
  }

  @OnEvent({ name: 'UserDelete' })
  onUserDelete({ id }: ArgOf<'UserDelete'>) {
    this.websocketRepository.clientBroadcast('on_user_delete', id);
  }

  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ id, userIds, recipientIds }: ArgOf<'AlbumUpdate'>) {
    for (const userId of userIds) {
      this.websocketRepository.clientSend('on_album_update', userId, id);
    }

    for (const recipientId of recipientIds) {
      await this.jobRepository.removeJob(JobName.NotifyAlbumUpdate, `${id}/${recipientId}`);
      await this.jobRepository.queue({
        name: JobName.NotifyAlbumUpdate,
        data: { id, recipientId, delay: NotificationService.albumUpdateEmailDelayMs },
      });
    }
  }

  @OnEvent({ name: 'AlbumInvite' })
  async onAlbumInvite({ id, userId, senderName }: ArgOf<'AlbumInvite'>) {
    await this.jobRepository.queue({ name: JobName.NotifyAlbumInvite, data: { id, recipientId: userId, senderName } });
  }

  @OnEvent({ name: 'ClusterGroupRequest' })
  async onClusterGroupRequest({ clusterGroupId, userId, senderName }: ArgOf<'ClusterGroupRequest'>) {
    const item = await this.notificationRepository.create({
      userId,
      type: NotificationType.ClusterGroupRequest,
      level: NotificationLevel.Info,
      title: 'Cluster Group Request',
      description: `${senderName} asked you to join their cluster group`,
      data: JSON.stringify({ clusterGroupId }),
    });

    this.websocketRepository.clientSend('on_notification', userId, mapNotification(item));
  }

  /**
   * Somebody was named in a shared space comment (FL-55). One in-app
   * notification per mentioned member, through the same repository and socket
   * as every other notification. This reads only the space's name — never an
   * asset — so it runs for every comment whatever the item's visibility, and
   * needs no elevated session; the client decides what to show when the
   * notification is opened.
   */
  @OnEvent({ name: 'SharedSpaceMention' })
  async onSharedSpaceMention({ id, assetId, activityId, userIds, senderName }: ArgOf<'SharedSpaceMention'>) {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    if (!album) {
      return;
    }

    for (const userId of userIds) {
      const item = await this.notificationRepository.create({
        userId,
        type: NotificationType.SharedSpaceMention,
        level: NotificationLevel.Info,
        title: 'Mentioned in a shared space',
        description: `${senderName} mentioned you in ${album.albumName}`,
        data: JSON.stringify({ albumId: id, assetId, activityId }),
      });

      this.websocketRepository.clientSend('on_notification', userId, mapNotification(item));
    }
  }

  /**
   * Somebody answered a member's comment in a shared space (FL-55, threaded
   * replies). One in-app notification to the author of the comment that was
   * answered, and no email, as for mentions. Like the mention handler this
   * reads only the space's name, never an asset, so it needs no elevated
   * session; the service has already checked the recipient is still a member.
   */
  @OnEvent({ name: 'SharedSpaceReply' })
  async onSharedSpaceReply({
    id,
    assetId,
    activityId,
    parentActivityId,
    userId,
    senderName,
  }: ArgOf<'SharedSpaceReply'>) {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    if (!album) {
      return;
    }

    const item = await this.notificationRepository.create({
      userId,
      type: NotificationType.SharedSpaceReply,
      level: NotificationLevel.Info,
      title: 'Reply in a shared space',
      description: `${senderName} replied to your comment in ${album.albumName}`,
      data: JSON.stringify({ albumId: id, assetId, activityId, parentActivityId }),
    });

    this.websocketRepository.clientSend('on_notification', userId, mapNotification(item));
  }

  /**
   * FL-155: one notice to every administrator. With a `dedupeKey`, an administrator who already got
   * a notice with that key in the last `dedupeDays` (1 to 30, default 7) is skipped, so a repeating
   * condition (a failing check-in, a clone warning) notifies once per window.
   */
  async notifyAdmins(notice: AdminNotice): Promise<number> {
    const days = Math.min(30, Math.max(1, Math.floor(notice.dedupeDays ?? 7)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let sent = 0;
    for (const admin of await this.userRepository.getAdmins()) {
      if (
        notice.dedupeKey &&
        (await this.notificationRepository.findRecentByDedupeKey(admin.id, notice.dedupeKey, since))
      ) {
        continue;
      }
      const item = await this.notificationRepository.create({
        userId: admin.id,
        type: notice.type,
        level: notice.level,
        title: notice.title,
        description: notice.description,
        data: notice.dedupeKey ? { dedupeKey: notice.dedupeKey } : null,
      });
      this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(item));
      sent++;
    }
    return sent;
  }

  @OnEvent({ name: 'AdminNotify' })
  async onAdminNotify(notice: ArgOf<'AdminNotify'>) {
    try {
      await this.notifyAdmins(notice);
    } catch (error) {
      this.logger.warn(`Unable to notify administrators (${notice.title}): ${error}`);
    }
  }

  @OnEvent({ name: 'SessionDelete' })
  onSessionDelete({ sessionId }: ArgOf<'SessionDelete'>) {
    // after the response is sent
    setTimeout(() => this.websocketRepository.clientSend('on_session_delete', sessionId, sessionId), 500);
  }

  async sendTestEmail(id: string, dto: SystemConfigSmtpDto, tempTemplate?: string) {
    const user = await this.userRepository.get(id, { withDeleted: false });
    if (!user) {
      throw new Error('User not found');
    }

    try {
      await this.emailRepository.verifySmtp(dto.transport);
    } catch (error) {
      throw new BadRequestException('Failed to verify SMTP configuration', { cause: error });
    }

    const { server } = await this.getConfig({ withCache: false });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.TEST_EMAIL,
      data: {
        baseUrl: await this.getPublicUrl(server),
        displayName: user.name,
      },
      customTemplate: tempTemplate!,
    });
    const { messageId } = await this.emailRepository.sendEmail({
      to: user.email,
      subject: 'Test email from Frameleaf',
      html,
      text,
      from: dto.from,
      replyTo: dto.replyTo || dto.from,
      smtp: dto.transport,
    });

    return { messageId };
  }

  @OnJob({ name: JobName.NotifyUserSignup, queue: QueueName.Notification })
  async handleUserSignup({ id, password }: JobOf<JobName.NotifyUserSignup>) {
    const user = await this.userRepository.get(id, { withDeleted: false });
    if (!user) {
      return JobStatus.Skipped;
    }

    const { server, templates } = await this.getConfig({ withCache: true });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.WELCOME,
      data: {
        baseUrl: await this.getPublicUrl(server),
        displayName: user.name,
        username: user.email,
        password,
      },
      customTemplate: templates.email.welcomeTemplate,
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: user.email,
        subject: 'Welcome to Frameleaf',
        html,
        text,
      },
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NotifyAlbumInvite, queue: QueueName.Notification })
  async handleAlbumInvite({ id, recipientId, senderName }: JobOf<JobName.NotifyAlbumInvite>) {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    if (!album) {
      return JobStatus.Skipped;
    }

    const recipient = await this.userRepository.get(recipientId, { withDeleted: false });
    if (!recipient) {
      return JobStatus.Skipped;
    }

    await this.sendAlbumLocalNotification(album, recipientId, NotificationType.AlbumInvite, senderName);

    const { emailNotifications } = getPreferences(recipient.metadata);

    if (!emailNotifications.enabled || !emailNotifications.albumInvite) {
      return JobStatus.Skipped;
    }

    const attachment = await this.getAlbumThumbnailAttachment(album, await this.getEmailHiddenContentFilter(recipient));

    const { server, templates } = await this.getConfig({ withCache: false });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.ALBUM_INVITE,
      data: {
        baseUrl: await this.getPublicUrl(server),
        albumId: album.id,
        albumName: album.albumName,
        senderName,
        recipientName: recipient.name,
        cid: attachment ? attachment.cid : undefined,
      },
      customTemplate: templates.email.albumInviteTemplate,
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: recipient.email,
        subject: `You have been added to a shared album - ${album.albumName}`,
        html,
        text,
        imageAttachments: attachment ? [attachment] : undefined,
      },
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NotifyAlbumUpdate, queue: QueueName.Notification })
  async handleAlbumUpdate({ id, recipientId }: JobOf<JobName.NotifyAlbumUpdate>) {
    const album = await this.albumRepository.getById(id, { withAssets: false });

    if (!album) {
      return JobStatus.Skipped;
    }

    const recipient = await this.userRepository.get(recipientId, { withDeleted: false });
    if (!recipient) {
      return JobStatus.Skipped;
    }

    await this.sendAlbumLocalNotification(album, recipientId, NotificationType.AlbumUpdate);

    const attachment = await this.getAlbumThumbnailAttachment(album, await this.getEmailHiddenContentFilter(recipient));

    const { server, templates } = await this.getConfig({ withCache: false });

    const user = await this.userRepository.get(recipientId, { withDeleted: false });
    if (!user) {
      return JobStatus.Skipped;
    }

    const { emailNotifications } = getPreferences(user.metadata);

    if (!emailNotifications.enabled || !emailNotifications.albumUpdate) {
      return JobStatus.Skipped;
    }

    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.ALBUM_UPDATE,
      data: {
        baseUrl: await this.getPublicUrl(server),
        albumId: album.id,
        albumName: album.albumName,
        recipientName: user.name,
        cid: attachment ? attachment.cid : undefined,
      },
      customTemplate: templates.email.albumUpdateTemplate,
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: user.email,
        subject: `New media has been added to an album - ${album.albumName}`,
        html,
        text,
        imageAttachments: attachment ? [attachment] : undefined,
      },
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SendMail, queue: QueueName.Notification })
  async handleSendEmail(data: JobOf<JobName.SendMail>): Promise<JobStatus> {
    const { notifications } = await this.getConfig({ withCache: false });
    if (!notifications.smtp.enabled) {
      return JobStatus.Skipped;
    }

    const { to, subject, html, text: plain } = data;
    const response = await this.emailRepository.sendEmail({
      to,
      subject,
      html,
      text: plain,
      from: notifications.smtp.from,
      replyTo: notifications.smtp.replyTo || notifications.smtp.from,
      smtp: notifications.smtp.transport,
      imageAttachments: data.imageAttachments,
    });

    this.logger.log(`Sent mail with id: ${response.messageId} status: ${response.response}`);

    return JobStatus.Success;
  }

  private async getAlbumThumbnailAttachment(
    album: {
      albumThumbnailAssetId: string | null;
    },
    hiddenContent: HiddenContentFilter,
  ): Promise<EmailImageAttachment | undefined> {
    if (!album.albumThumbnailAssetId) {
      return;
    }

    const nsfwThumbnailIds = hasHiddenContentFilter(hiddenContent)
      ? await this.assetRepository.getHiddenContentAssetIds([album.albumThumbnailAssetId], { hiddenContent })
      : new Set<string>();
    if (nsfwThumbnailIds.has(album.albumThumbnailAssetId)) {
      return;
    }

    const albumThumbnailFiles = await this.assetJobRepository.getAlbumThumbnailFiles(
      album.albumThumbnailAssetId,
      AssetFileType.Thumbnail,
    );

    if (albumThumbnailFiles.length !== 1) {
      return;
    }

    return {
      filename: `album-thumbnail${getFilenameExtension(albumThumbnailFiles[0].path)}`,
      path: albumThumbnailFiles[0].path,
      cid: 'album-thumbnail',
    };
  }

  private async getEmailHiddenContentFilter(user: {
    id: string;
    metadata: UserMetadataItem[];
  }): Promise<HiddenContentFilter> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    const suppression = getPreferences(user.metadata).privacy.suppression;

    return {
      userId: user.id,
      includeNsfw: isNsfwHidingEnabled(machineLearning),
      tagIds: suppression.tagIds,
      personIds: suppression.personIds,
      petIds: suppression.petIds,
      scope: suppression.scope,
    };
  }

  private async sendAlbumLocalNotification(
    album: MapAlbumDto,
    userId: string,
    type: NotificationType.AlbumInvite | NotificationType.AlbumUpdate,
    senderName?: string,
  ) {
    const isInvite = type === NotificationType.AlbumInvite;
    const item = await this.notificationRepository.create({
      userId,
      type,
      level: isInvite ? NotificationLevel.Success : NotificationLevel.Info,
      title: isInvite ? 'Shared Album Invitation' : 'Shared Album Update',
      description: isInvite
        ? `${senderName} shared an album (${album.albumName}) with you`
        : `New media has been added to the album (${album.albumName})`,
      data: JSON.stringify({ albumId: album.id }),
    });

    this.websocketRepository.clientSend('on_notification', userId, mapNotification(item));
  }
}
