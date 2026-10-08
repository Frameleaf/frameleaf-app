import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AdminNotice, ArgOf } from 'src/repositories/event.repository.js';
import type { EmailImageAttachment, IEmailJob, JobOf, UserMetadataItem } from 'src/types.js';
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
import {
  type NotificationText,
  type SystemNotificationTemplate,
  notificationLocaleOf,
  renderSystemNotification,
} from 'src/utils/notification-locale.js';
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
        const text = await this.localText(
          admin.id,
          { version: 1, key: 'job-failed', args: { jobName: job.name, error: String(errorMessage) } },
          { title: 'Job Failed', body: `Job ${[job.name]} failed with error: ${errorMessage}` },
        );
        const item = await this.notificationRepository.create({
          userId: admin.id,
          type: NotificationType.JobFailed,
          level: NotificationLevel.Error,
          ...text,
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
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    this.websocketRepository.clientBroadcast('on_config_update');
    await this.websocketRepository.awaitConfigUpdate({ oldConfig, newConfig });
  }

  @OnEvent({ name: 'AppRestart' })
  async onAppRestart(state: ArgOf<'AppRestart'>) {
    await this.websocketRepository.clientBroadcastAndFlush('AppRestartV1', {
      isMaintenanceMode: state.isMaintenanceMode,
    });

    await this.websocketRepository.serverSendAndFlush('AppRestart', state);
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

  @OnEvent({ name: 'AssetLocalEffects' })
  async onAssetLocalEffects(bundle: ArgOf<'AssetLocalEffects'>) {
    const removed = await this.mediaOperationRepository.listRevokedSourceAdmissions(bundle.revocations);
    const admissions = new Map(
      [...removed, ...(bundle.lockedCascade?.interactiveAdmissions ?? [])].map((row) => [row.id, row]),
    )
      .values()
      .toArray();
    const audiences = new Set([bundle.ownerId, ...admissions.map((row) => row.ownerId)]);
    for (const ownerId of audiences)
      this.websocketRepository.clientSend('AssetLocalEffectsV1', ownerId, {
        streamEpoch: bundle.streamEpoch,
        sequence: bundle.sequence,
        effectId: bundle.effectId,
        assetIds:
          ownerId === bundle.ownerId
            ? [
                ...new Set([
                  ...bundle.assets.map((row) => row.assetId),
                  ...bundle.stacks.flatMap((row) => row.memberAssetIds),
                ]),
              ]
            : [],
        revokedOperationIds: admissions.filter((row) => row.ownerId === ownerId).map((row) => row.id),
      });
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

  /**
   * FL-83 (AL-30b): items were shared with a person. The notification album invitations use: one
   * in-app notification, and an email when the recipient allows album invitation emails. Both carry
   * the share link (`resolveShareBaseUrl`); neither names or shows an item, so nothing about the
   * items reaches the recipient outside the access checks.
   */
  @OnEvent({ name: 'ItemShare' })
  async onItemShare({ ownerId, userId, senderName, count, link }: ArgOf<'ItemShare'>) {
    const recipient = await this.userRepository.get(userId, { withDeleted: false });
    if (!recipient) {
      return;
    }

    const item = await this.notificationRepository.create({
      userId,
      type: NotificationType.ItemShare,
      level: NotificationLevel.Success,
      ...(await this.localText(
        userId,
        count === 1
          ? { version: 1, key: 'item-share-one', args: { senderName } }
          : { version: 1, key: 'item-share-many', args: { senderName, count } },
        {
          title: 'Shared with you',
          body: count === 1 ? `${senderName} shared an item with you` : `${senderName} shared ${count} items with you`,
        },
      )),
      data: JSON.stringify({ ownerId, count, link }),
    });
    this.websocketRepository.clientSend('on_notification', userId, mapNotification(item));

    const { emailNotifications } = getPreferences(recipient.metadata);
    if (!emailNotifications.enabled || !emailNotifications.albumInvite) {
      return;
    }

    const { server } = await this.getConfig({ withCache: false });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.ITEM_SHARE,
      data: {
        baseUrl: await this.getPublicUrl(server),
        senderName,
        recipientName: recipient.name,
        count,
        link: link ?? undefined,
      },
      customTemplate: '',
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: recipient.email,
        subject: count === 1 ? `${senderName} shared an item with you` : `${senderName} shared ${count} items with you`,
        html,
        text,
      },
    });
  }

  @OnEvent({ name: 'ClusterGroupRequest' })
  async onClusterGroupRequest({ clusterGroupId, userId, senderName }: ArgOf<'ClusterGroupRequest'>) {
    const item = await this.notificationRepository.create({
      userId,
      type: NotificationType.ClusterGroupRequest,
      level: NotificationLevel.Info,
      ...(await this.localText(
        userId,
        { version: 1, key: 'cluster-request', args: { senderName } },
        { title: 'Cluster Group Request', body: `${senderName} asked you to join their cluster group` },
      )),
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
        ...(await this.localText(
          userId,
          { version: 1, key: 'space-mention', args: { senderName, albumName: album.albumName } },
          { title: 'Mentioned in a shared space', body: `${senderName} mentioned you in ${album.albumName}` },
        )),
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
      ...(await this.localText(
        userId,
        { version: 1, key: 'space-reply', args: { senderName, albumName: album.albumName } },
        { title: 'Reply in a shared space', body: `${senderName} replied to your comment in ${album.albumName}` },
      )),
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
        ...(notice.systemTemplate
          ? await this.localText(admin.id, notice.systemTemplate, { title: notice.title, body: notice.description })
          : { title: notice.title, description: notice.description }),
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
    const context = { albumId: id, recipientId, senderName, kind: 'invite' as const };
    const current = await this.getCurrentAlbumNotification(context);
    if (!current) {
      return JobStatus.Skipped;
    }
    await this.sendAlbumLocalNotification(current.album, recipientId, NotificationType.AlbumInvite, senderName);
    const mail = await this.prepareAlbumNotificationEmail(context);
    if (!mail || !(await this.isAlbumEmailCurrent(mail))) {
      return JobStatus.Skipped;
    }
    await this.jobRepository.queue({ name: JobName.SendMail, data: mail });
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NotifyAlbumUpdate, queue: QueueName.Notification })
  async handleAlbumUpdate({ id, recipientId }: JobOf<JobName.NotifyAlbumUpdate>) {
    const context = { albumId: id, recipientId, kind: 'update' as const };
    const current = await this.getCurrentAlbumNotification(context);
    if (!current) {
      return JobStatus.Skipped;
    }
    await this.sendAlbumLocalNotification(current.album, recipientId, NotificationType.AlbumUpdate);
    const mail = await this.prepareAlbumNotificationEmail(context);
    if (!mail || !(await this.isAlbumEmailCurrent(mail))) {
      return JobStatus.Skipped;
    }
    await this.jobRepository.queue({ name: JobName.SendMail, data: mail });
    return JobStatus.Success;
  }

  private async getCurrentAlbumNotification(context: NonNullable<IEmailJob['albumMailContext']>) {
    const album = await this.albumRepository.getById(context.albumId, { withAssets: false });
    if (!album) {
      return;
    }
    const recipient = await this.userRepository.get(context.recipientId, { withDeleted: false });
    if (!recipient) {
      return;
    }
    const allowed = await this.checkAccess({
      auth: { user: recipient },
      permission: Permission.AlbumRead,
      ids: [album.id],
    });
    if (!allowed.has(album.id)) {
      return;
    }
    return { album, recipient };
  }

  private async prepareAlbumNotificationEmail(
    context: NonNullable<IEmailJob['albumMailContext']>,
  ): Promise<IEmailJob | undefined> {
    const current = await this.getCurrentAlbumNotification(context);
    if (!current) {
      return;
    }
    const { album, recipient } = current;
    const invite = context.kind === 'invite';
    const { emailNotifications } = getPreferences(recipient.metadata);
    if (!emailNotifications.enabled || !(invite ? emailNotifications.albumInvite : emailNotifications.albumUpdate)) {
      return;
    }
    const attachment = await this.getAlbumThumbnailAttachment(
      album,
      await this.getEmailHiddenContentFilter(recipient),
      recipient,
    );
    const { server, templates } = await this.getConfig({ withCache: false });
    const data = {
      baseUrl: await this.getPublicUrl(server),
      albumId: album.id,
      albumName: album.albumName,
      recipientName: recipient.name,
      senderName: context.senderName ?? '',
      cid: attachment?.cid,
    };
    const { html, text } = await this.emailRepository.renderEmail(
      invite
        ? { template: EmailTemplate.ALBUM_INVITE, data, customTemplate: templates.email.albumInviteTemplate }
        : { template: EmailTemplate.ALBUM_UPDATE, data, customTemplate: templates.email.albumUpdateTemplate },
    );
    return {
      albumMailContext: context,
      to: recipient.email,
      subject: invite
        ? `You have been added to a shared album - ${album.albumName}`
        : `New media has been added to an album - ${album.albumName}`,
      html,
      text,
      imageAttachments: attachment ? [attachment] : undefined,
    };
  }

  private async isAlbumEmailCurrent(mail: IEmailJob) {
    const context = mail.albumMailContext;
    if (!context) {
      return false;
    }
    const current = await this.getCurrentAlbumNotification(context);
    if (!current || mail.to !== current.recipient.email) {
      return false;
    }
    const { emailNotifications } = getPreferences(current.recipient.metadata);
    if (
      !emailNotifications.enabled ||
      !(context.kind === 'invite' ? emailNotifications.albumInvite : emailNotifications.albumUpdate)
    ) {
      return false;
    }
    const attachment = await this.getAlbumThumbnailAttachment(
      current.album,
      await this.getEmailHiddenContentFilter(current.recipient),
      current.recipient,
    );
    if (!isEqualObject(mail.imageAttachments ?? [], attachment ? [attachment] : [])) {
      return false;
    }
    // Attachment/configuration reads may yield; close the membership boundary after those awaits.
    const allowed = await this.checkAccess({
      auth: { user: current.recipient },
      permission: Permission.AlbumRead,
      ids: [current.album.id],
    });
    if (!allowed.has(current.album.id)) {
      return false;
    }
    if (attachment && current.album.albumThumbnailAssetId) {
      const visible = await this.checkAccess({
        auth: { user: current.recipient },
        permission: Permission.AssetView,
        ids: [current.album.albumThumbnailAssetId],
      });
      return visible.has(current.album.albumThumbnailAssetId);
    }
    return true;
  }

  @OnJob({ name: JobName.SendMail, queue: QueueName.Notification })
  async handleSendEmail(data: JobOf<JobName.SendMail>): Promise<JobStatus> {
    const { notifications } = await this.getConfig({ withCache: false });
    if (!notifications.smtp.enabled) {
      return JobStatus.Skipped;
    }

    // Only known legacy album payloads are identifiable without the new durable binding. Unknown
    // custom legacy mail remains the existing generic path; this does not certify its provenance.
    if (
      !data.albumMailContext &&
      (data.subject.startsWith('You have been added to a shared album - ') ||
        data.subject.startsWith('New media has been added to an album - ') ||
        data.imageAttachments?.some(({ cid }) => cid === 'album-thumbnail'))
    ) {
      return JobStatus.Skipped;
    }
    const mail = data.albumMailContext ? await this.prepareAlbumNotificationEmail(data.albumMailContext) : data;
    if (!mail || (mail.albumMailContext && !(await this.isAlbumEmailCurrent(mail)))) {
      return JobStatus.Skipped;
    }
    // Current authority was checked immediately before transport; no transaction spans SMTP I/O.
    const { to, subject, html, text: plain } = mail;
    const response = await this.emailRepository.sendEmail({
      to,
      subject,
      html,
      text: plain,
      from: notifications.smtp.from,
      replyTo: notifications.smtp.replyTo || notifications.smtp.from,
      smtp: notifications.smtp.transport,
      imageAttachments: mail.imageAttachments,
    });

    this.logger.log(`Sent mail with id: ${response.messageId} status: ${response.response}`);

    return JobStatus.Success;
  }

  private async getAlbumThumbnailAttachment(
    album: {
      albumThumbnailAssetId: string | null;
    },
    hiddenContent: HiddenContentFilter,
    recipient: AuthDto['user'],
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

    // Background delivery never inherits a recipient's PIN elevation. Existing access predicates
    // exclude actual Locked media while preserving owner rule-only explicit album shares.
    const allowed = await this.checkAccess({
      auth: { user: recipient },
      permission: Permission.AssetView,
      ids: [album.albumThumbnailAssetId],
    });
    if (!allowed.has(album.albumThumbnailAssetId)) {
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
      ...(await this.localText(
        userId,
        isInvite
          ? senderName === undefined
            ? { version: 1, key: 'album-invite-anonymous', args: { albumName: album.albumName } }
            : { version: 1, key: 'album-invite', args: { senderName, albumName: album.albumName } }
          : { version: 1, key: 'album-update', args: { albumName: album.albumName } },
        {
          title: isInvite ? 'Shared Album Invitation' : 'Shared Album Update',
          body: isInvite
            ? senderName === undefined
              ? `An album (${album.albumName}) was shared with you`
              : `${senderName} shared an album (${album.albumName}) with you`
            : `New media has been added to the album (${album.albumName})`,
        },
      )),
      data: JSON.stringify({ albumId: album.id }),
    });

    this.websocketRepository.clientSend('on_notification', userId, mapNotification(item));
  }

  private async localText(userId: string, template: SystemNotificationTemplate, fallback: NotificationText) {
    const preferences = getPreferences((await this.userRepository.getMetadata(userId).catch(() => [])) ?? []);
    const { title, body } = renderSystemNotification(template, notificationLocaleOf(preferences), fallback);
    return { title, description: body };
  }
}
