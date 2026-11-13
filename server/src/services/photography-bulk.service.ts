import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PhotographyBulkCreateDto, type PhotographyBulkDto } from 'src/dtos/photography-bulk.dto.js';
import { JobName, JobStatus, QueueName, UserStatus } from 'src/enum.js';
import { OnJob } from 'src/decorators.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import type { DB } from 'src/schema/index.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { PhotographySiteService } from 'src/services/photography-site.service.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import type { JobOf } from 'src/types.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import { bulkInvitation, type BulkGalleryBatch, type BulkGalleryRow } from 'src/utils/photography-bulk.js';

type RowStatus = Pick<BulkGalleryRow, 'status' | 'error'>;

@Injectable()
export class PhotographyBulkService {
  constructor(
    private repository: PhotographyWorkflowRepository,
    private workflows: PhotographyWorkflowService,
    private sites: PhotographySiteService,
    private jobs: JobRepository,
    private users: UserRepository,
    private config: ConfigRepository,
    private crypto: CryptoRepository,
  ) {}

  private ownerId(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink)
      throw new ForbiddenException('Photography requires a user session');
    return auth.user.id;
  }

  private invitation(ownerId: string, rowId: string) {
    return bulkInvitation(rowId, (purpose, id) =>
      this.crypto.serverKeyedHash(identityDirectory(this.config), `photography-bulk-${purpose}`, `${ownerId}:${id}`),
    );
  }

  private async view(ownerId: string, batch: BulkGalleryBatch): Promise<PhotographyBulkDto> {
    return {
      id: batch.id,
      rows: await Promise.all(
        batch.rows.map(async ({ id, title, clientName, clientEmail, status, error, albumId, recipientId }) => {
          const row = status === 'ready' || status === 'mail-queued' ? await this.repository.get(id) : undefined;
          const recipient = row?.value.recipients.find((item) => item.id === recipientId);
          const expiresAt = [recipient?.expiresAt, row?.value.config.expiresAt];
          const invitation =
            row?.ownerId === ownerId &&
            row.value.published &&
            recipient &&
            !recipient.revoked &&
            expiresAt.every((date) => !date || Date.parse(date) > Date.now())
              ? await this.invitation(ownerId, id)
              : null;
          return {
            id,
            title,
            clientName,
            clientEmail,
            status,
            error,
            shootId: albumId ? id : null,
            link: invitation ? `/photography/gallery/${id}#invitation=${invitation.token}` : null,
            password: invitation?.password ?? null,
          };
        }),
      ),
    };
  }

  private async batch(ownerId: string, id: string) {
    const { record } = await this.repository.studioRecord(ownerId);
    const batch = record.bulkGalleries?.find((batch) => batch.id === id);
    if (!batch) throw new NotFoundException('Gallery batch unavailable');
    return batch;
  }

  get(auth: AuthDto, id: string) {
    const ownerId = this.ownerId(auth);
    return this.batch(ownerId, id).then((batch) => this.view(ownerId, batch));
  }

  async create(auth: AuthDto, input: PhotographyBulkCreateDto): Promise<PhotographyBulkDto> {
    const ownerId = this.ownerId(auth);
    const { requestId: id, templateId, rows } = PhotographyBulkCreateDto.schema.parse(input);
    const template = await this.workflows.get(auth, templateId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ templateId, rows })).digest('hex');
    const { result } = await this.repository.mutateStudio(ownerId, undefined, async (record, tx) => {
      const batches = (record.bulkGalleries ??= []);
      const existing = batches.find((batch) => batch.id === id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException('Gallery batch request changed');
        return existing;
      }
      // Keep pending batches and retain completed invitations until their galleries expire.
      const cutoff = Date.now() - 30 * 86_400_000;
      record.bulkGalleries = batches.filter(
        (batch) =>
          Date.parse(batch.createdAt) > cutoff ||
          batch.rows.some(({ status }) => status === 'queued' || status === 'publishing'),
      );
      if (record.bulkGalleries.length >= 20) throw new ConflictException('Gallery batch limit reached');
      const batch: BulkGalleryBatch = {
        id,
        createdAt: new Date().toISOString(),
        fingerprint,
        template: template.config,
        rows: rows.map((row) => ({ ...row, id: randomUUID(), status: 'queued', error: null })),
      };
      record.bulkGalleries.push(batch);
      await this.jobs.queueAllInTransaction(
        tx,
        batch.rows.map((row) => ({
          name: JobName.PhotographyBulkGallery,
          data: { id: row.id, ownerId, batchId: id },
        })),
      );
      return batch;
    });
    return this.view(ownerId, result);
  }

  async retry(auth: AuthDto, batchId: string, id: string): Promise<PhotographyBulkDto> {
    const ownerId = this.ownerId(auth);
    const { result } = await this.repository.mutateStudio(ownerId, undefined, async (record, tx) => {
      const batch = record.bulkGalleries?.find((batch) => batch.id === batchId);
      const row = batch?.rows.find((row) => row.id === id);
      if (!batch || !row) throw new NotFoundException('Gallery unavailable');
      if (['failed', 'ready', 'mail-queued', 'draft'].includes(row.status)) {
        const retryPublication = row.error === 'publication-failed';
        row.status = 'queued';
        row.error = null;
        await this.jobs.queueInTransaction(tx, {
          name: JobName.PhotographyBulkGallery,
          data: { id, ownerId, batchId, retryPublication },
        });
      }
      return batch;
    });
    return this.view(ownerId, result);
  }

  private async update(ownerId: string, batchId: string, id: string, patch: Partial<BulkGalleryRow>) {
    await this.repository.mutateStudio(ownerId, undefined, (record) => {
      const row = record.bulkGalleries?.find((batch) => batch.id === batchId)?.rows.find((row) => row.id === id);
      if (row) Object.assign(row, patch);
    });
  }

  @OnJob({ name: JobName.PhotographyBulkGallery, queue: QueueName.BackgroundTask })
  async run({ id, ownerId, batchId, retryPublication }: JobOf<JobName.PhotographyBulkGallery>) {
    const owner = await this.users.get(ownerId, {});
    if (!owner || owner.status !== UserStatus.Active) return JobStatus.Skipped;
    const auth: AuthDto = { user: owner, session: { id: randomUUID(), hasElevatedPermission: false } };
    const batch = await this.batch(ownerId, batchId);
    const row = batch.rows.find((row) => row.id === id);
    if (!row || !['queued', 'publishing'].includes(row.status)) return JobStatus.Skipped;
    let status: RowStatus | undefined;
    try {
      status = await this.prepare(auth, batch, row, retryPublication);
    } catch {
      status = { status: 'failed', error: 'setup-failed' };
    }
    if (status) {
      await this.update(ownerId, batchId, id, status);
    }
    if (status?.status === 'publishing') {
      await this.jobs.queue({
        name: JobName.PhotographyBulkGallery,
        data: { id, ownerId, batchId, delay: 3000 },
      });
    }
    return JobStatus.Success;
  }

  private async prepare(
    auth: AuthDto,
    batch: BulkGalleryBatch,
    row: BulkGalleryRow,
    retryPublication?: boolean,
  ): Promise<RowStatus | undefined> {
    const ownerId = auth.user.id;
    if (!row.albumId) {
      const { result } = await this.repository.mutateStudio(ownerId, undefined, async (record, tx) => {
        const current = record
          .bulkGalleries!.find((item) => item.id === batch.id)!
          .rows.find((item) => item.id === row.id)!;
        current.albumId ??= await this.repository.createBulkShoot(tx, ownerId, row.id, row);
        return current.albumId;
      });
      if (!result) return { status: 'failed', error: 'photos-unavailable' };
    }

    let workflow = await this.workflows.get(auth, row.id);
    if (!workflow.revision) {
      const { presentation, ...config } = batch.template;
      workflow = await this.workflows.config(auth, row.id, {
        expectedRevision: null,
        config: {
          ...config,
          title: row.title,
          expiresAt: new Date(Date.parse(batch.createdAt) + 30 * 86_400_000).toISOString(),
          selectionDeadline: null,
          presentation: { ...presentation, coverCaptureId: null, blocks: undefined },
        },
      });
    }
    const invitation = await this.invitation(ownerId, row.id);
    const tokenHash = createHash('sha256').update(invitation.token).digest('hex');
    const stored = await this.repository.get(row.id);
    const recipient = stored?.value.recipients.find((item) => item.tokenHash === tokenHash);
    if (recipient && (recipient.revoked || (recipient.expiresAt && Date.parse(recipient.expiresAt) <= Date.now())))
      return { status: 'failed', error: 'setup-failed' };
    if (!recipient) {
      const created = await this.workflows.createRecipient(
        auth,
        row.id,
        {
          expectedRevision: workflow.revision,
          name: row.clientName,
          email: row.clientEmail,
          password: invitation.password,
          expiresAt: workflow.config.expiresAt,
          canProof: true,
          canDownload: false,
          captureIds: null,
        },
        invitation.token,
      );
      workflow = created.workflow;
      await this.update(ownerId, batch.id, row.id, { recipientId: created.invitation.recipientId });
    } else if (!row.recipientId) {
      await this.update(ownerId, batch.id, row.id, { recipientId: recipient.id });
    }
    if (!workflow.captures.length)
      workflow = await this.workflows.intake(auth, row.id, { expectedRevision: workflow.revision });
    if (!workflow.captures.length) return { status: 'draft', error: null };
    if (!workflow.captures.some((capture) => capture.eligible))
      return { status: 'failed', error: 'photos-unavailable' };
    if (!workflow.publication || (workflow.publication.status === 'failed' && retryPublication)) {
      workflow = await this.workflows.publish(auth, row.id, {
        expectedRevision: workflow.revision,
        scope: 'all-eligible',
      });
    }
    if (workflow.publication?.status === 'failed') return { status: 'failed', error: 'publication-failed' };
    if (workflow.publication?.status !== 'ready') return { status: 'publishing', error: null };
    if (workflow.config.expiresAt && Date.parse(workflow.config.expiresAt) <= Date.now())
      return { status: 'failed', error: 'setup-failed' };

    const email = await this.sites.prepareInvitationEmail(auth, {
      workflowId: row.id,
      ...invitation,
      email: recipient?.email ?? row.clientEmail,
      recipientName: row.clientName,
      galleryTitle: row.title,
      welcomeMessage: workflow.config.welcomeMessage,
      expiresAt: workflow.config.expiresAt,
    });
    if (!email) return { status: 'ready', error: 'email-unavailable' };
    // The queued mail and its result commit together so a worker restart never queues it a second time.
    await this.repository.mutateStudio(ownerId, undefined, async (record, tx: Transaction<DB>) => {
      const current = record.bulkGalleries
        ?.find((item) => item.id === batch.id)
        ?.rows.find((item) => item.id === row.id);
      if (!current || !['queued', 'publishing'].includes(current.status)) return;
      await this.jobs.queueInTransaction(tx, { name: JobName.SendMail, data: email });
      current.status = 'mail-queued';
      current.error = null;
    });
  }
}
