import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, constants, mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobOf } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import {
  type PhotographyWatermark,
  type PhotographyWatermarkPreset,
  PhotographyWatermarkSchema,
} from 'src/dtos/photography-rendition.dto.js';
import {
  PhotographyApprovalDto,
  PhotographyAssemblyDto,
  type PhotographyChapter,
  PhotographyChoicesDto,
  type PhotographyConfig,
  PhotographyConfigSchema,
  PhotographyGallerySessionDto,
  PhotographyGuestApprovalDto,
  PhotographyIntakeDto,
  PhotographyOrderAcceptDto,
  PhotographyOrderCreateDto,
  PhotographyPaymentDto,
  PhotographyPresetSaveDto,
  PhotographyPublicationDto,
  PhotographyRecipientCreateDto,
  PhotographyRecipientUpdateDto,
  PhotographySiteSaveDto,
  PhotographyStudioPresetApplyDto,
  PhotographyWorkflowConfigDto,
  PhotographyWorkflowMutationDto,
  PhotographyZipDto,
} from 'src/dtos/photography-workflow.dto.js';
import { CacheControl, ImmichWorker, JobName, JobStatus, QueueName, StorageFolder } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { PhotographyWorkflowRepository, type WorkflowRow } from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { preparePhotographyLogo, renderPhotographyRendition } from 'src/utils/photography-rendition.js';
import { deliveryBlock, priceSelection, verifyStripeSignature } from 'src/utils/photography-workflow.js';

export type PhotographyCapture = {
  id: string;
  number: number;
  assetId: string;
  assetIds: string[];
  checksum: string;
  fileName: string;
  camera: string;
  capturedAt: string;
  offsetSeconds: number;
  photographer: string;
  chapterId: string | null;
  position: number;
  withheld: boolean;
  rating: number | null;
  isRaw: boolean;
  eligible: boolean;
  exclusion: string | null;
  processing: 'ready' | 'pending' | 'failed';
  proofRevisionId: string | null;
  approvedRevisionId: string | null;
  approvalRequested: boolean;
  state: 'imported' | 'selected' | 'approval-requested' | 'approved' | 'delivered';
};
type Recipient = {
  id: string;
  name: string;
  tokenHash: string;
  passwordHash: string | null;
  revoked: boolean;
  expiresAt: string | null;
  canProof: boolean;
  canDownload: boolean;
  captureIds: string[] | null;
  choices: string[];
  notes: PhotographyChoicesDto['notes'];
};
type Round = {
  id: string;
  recipientId: string;
  number: number;
  captureIds: string[];
  notes: Recipient['notes'];
  createdAt: string;
};
type DeliveryOutput = {
  id: string;
  key: string;
  label: string;
  kind: 'print' | 'web' | 'social';
  revisionId: string | null;
  approved: boolean;
  clientApprovalRequired: boolean;
  explicitRevision: boolean;
  approvalPreviewPath?: string | null;
  proofWatermark?: PhotographyWatermark;
  finalPath: string | null;
  exportWatermark: PhotographyWatermark | null;
  exportSpec: { format: 'jpeg'; quality: 90; maxEdge: number };
};
type OrderItem = {
  captureId: string;
  revisionId: string | null;
  approved: boolean;
  clientApprovalRequired: boolean;
  finalPath: string | null;
  exportWatermark: PhotographyWatermark | null;
  exportSpec: { format: 'jpeg'; quality: 90; maxEdge: number };
  outputs?: DeliveryOutput[];
};
type Order = {
  id: string;
  recipientId: string;
  roundId: string | null;
  status: 'quoted' | 'accepted' | 'settled' | 'free' | 'refunded' | 'cancelled';
  currency: string;
  total: number;
  captureIds: string[];
  terms: string;
  paymentTiming: PhotographyConfig['paymentTiming'];
  pricing: {
    includedCount: number;
    additionalPrice: number;
    collectionPrice: number | null;
    bundles: PhotographyConfig['bundles'];
    option: string;
  };
  items: OrderItem[];
  createdAt: string;
  acceptedAt: string | null;
  checkoutId: string | null;
  paymentIntentId: string | null;
};
type PublishedPhoto = {
  captureId: string;
  number: number;
  chapterId: string | null;
  previewPath: string;
  thumbnailPath: string;
  revisionId: string | null;
};
type Publication = {
  id: string;
  status: 'queued' | 'rendering' | 'ready' | 'failed';
  completed: number;
  total: number;
  error: string | null;
  failedCaptureId: string | null;
  captureIds: string[];
  config: PhotographyConfig;
  updatedAt: string;
  claim: string | null;
  photos: PublishedPhoto[];
  sources: {
    captureId: string;
    revisionId: string | null;
    number: number;
    chapterId: string | null;
    approved: boolean;
  }[];
  brand: {
    name: string;
    tagline: string;
    email: string;
    phone: string;
    color: string;
    background: string;
    textColor: string;
    font: string;
    logoAssetId: string | null;
  };
  logoPath: string | null;
  chapters: PhotographyChapter[];
};
export type PhotographyWorkflow = {
  config: PhotographyConfig;
  expandedAssetIds: string[];
  presets: { id: string; name: string; config: PhotographyConfig }[];
  approvedVersions?: { captureId: string; revisionId: string; approvedAt: string }[];
  captures: PhotographyCapture[];
  chapters: PhotographyChapter[];
  ordering: PhotographyAssemblyDto['ordering'];
  recipients: Recipient[];
  rounds: Round[];
  orders: Order[];
  publication: Publication | null;
  published: {
    generationId?: string;
    config: PhotographyConfig;
    chapters: PhotographyChapter[];
    photos: PublishedPhoto[];
    brand: Publication['brand'];
    logoPath: string | null;
  } | null;
  sessions: { hash: string; recipientId: string; expiresAt: string }[];
  approvals: {
    recipientId: string;
    captureId: string;
    revisionId: string;
    approved: boolean;
    note: string;
    createdAt: string;
  }[];
  receipts: {
    id: string;
    orderId: string | null;
    recipientId: string;
    action: string;
    reference: string;
    createdAt: string;
  }[];
  zips: {
    id: string;
    recipientId: string;
    captureIds: string[];
    entries?: { captureId: string; orderId: string; outputId: string; revisionId: string }[];
    createdAt: string;
    expiresAt: string;
  }[];
};
const iso = () => new Date().toISOString();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const expired = (at: string | null) => at !== null && Date.parse(at) <= Date.now();

@Injectable()
export class PhotographyWorkflowService {
  constructor(
    private repository: PhotographyWorkflowRepository,
    private workspace: PhotographyWorkspaceRepository,
    private albums: AlbumService,
    private revisions: AssetDevelopRepository,
    private crypto: CryptoRepository,
    private jobs: JobRepository,
    private storage: StorageRepository,
  ) {}
  private initial(
    title: string,
    studio?: {
      name: string;
      watermarkColor: string;
      watermarkOpacity: number;
      watermarkPosition: string;
      watermarkSize: number;
      watermarkPresets?: PhotographyWatermarkPreset[];
      webWatermarkPresetId?: string | null;
      proofWatermarkPresetId?: string | null;
      exportWatermarkPresetId?: string | null;
    },
  ): PhotographyWorkflow {
    const legacy = PhotographyWatermarkSchema.parse({
      text: studio?.name ?? title,
      color: studio?.watermarkColor ?? '#ffffff',
      opacity: studio?.watermarkOpacity ?? 45,
      position: studio?.watermarkPosition ?? 'bottom-right',
      size: studio?.watermarkSize ?? 6,
    });
    const selected = (id: string | null | undefined) =>
      studio?.watermarkPresets?.find((preset) => preset.id === id)?.watermark;
    return {
      config: PhotographyConfigSchema.parse({
        title,
        mode: 'select-before-editing',
        paymentTiming: 'after-approval',
        currency: 'CAD',
        includedCount: 0,
        additionalPrice: 0,
        collectionPrice: null,
        bundles: [],
        terms: '',
        selectionDeadline: null,
        expiresAt: null,
        turnaroundDays: 14,
        proofWatermark: structuredClone(
          selected(studio?.proofWatermarkPresetId) ?? {
            ...legacy,
            secondLine: 'PROOF',
            pattern: 'tile',
            opacity: Math.max(65, legacy.opacity),
          },
        ),
        webWatermark: structuredClone(selected(studio?.webWatermarkPresetId) ?? legacy),
        downloadWatermark: structuredClone(selected(studio?.exportWatermarkPresetId) ?? null),
        presentation: {
          template: 'proofing',
          coverCaptureId: null,
          coverTreatment: 'quiet',
          coverFocal: 50,
          font: 'editorial',
          palette: 'studio',
          spacing: 'comfortable',
          introduction: '',
          showChapters: true,
          showNumbers: true,
        },
      }),
      expandedAssetIds: [],
      presets: [],
      approvedVersions: [],
      captures: [],
      chapters: [],
      ordering: 'chronological',
      recipients: [],
      rounds: [],
      orders: [],
      publication: null,
      published: null,
      sessions: [],
      approvals: [],
      receipts: [],
      zips: [],
    };
  }
  private async owner(auth: AuthDto, id: string) {
    if (!auth.session || auth.sharedLink || auth.apiKey)
      throw new ForbiddenException('Photography requires a user session');
    const stored = await this.workspace.get(auth.user.id);
    const shoot = stored?.value.shoots.find((shoot) => shoot.id === id);
    if (!shoot) throw new NotFoundException('Shoot not found');
    const album = await this.albums.get(
      { ...auth, session: { ...auth.session, hasElevatedPermission: false } },
      shoot.albumId,
    );
    if (album.albumUsers[0]?.user.id !== auth.user.id || album.isSmart || album.kind !== 'album')
      throw new ForbiddenException('Source album is unavailable');
    return {
      ownerId: auth.user.id,
      albumId: shoot.albumId,
      initial: this.initial(
        shoot.name,
        stored?.value.brand ?? {
          name: auth.user.name || shoot.name,
          watermarkColor: '#ffffff',
          watermarkOpacity: 45,
          watermarkPosition: 'bottom-right',
          watermarkSize: 6,
        },
      ),
    };
  }
  private async ownerView(row: WorkflowRow) {
    await this.hydrateOutputFiles(row.value);
    const value = row.value;
    const assets = await this.repository.assets(row.ownerId, row.albumId, [
      ...new Set(value.captures.flatMap((c) => c.assetIds)),
    ]);
    const revisions = await this.repository.eligibleRevisions(row, [
      ...new Set([
        ...value.captures.flatMap((capture) =>
          [capture.proofRevisionId, capture.approvedRevisionId].filter((id): id is string => !!id),
        ),
        ...(value.approvedVersions ?? []).map((version) => version.revisionId),
        ...value.approvals.map((approval) => approval.revisionId),
        ...value.orders.flatMap((order) =>
          order.items.flatMap((item) =>
            this.outputs(order, item).flatMap((output) => (output.revisionId ? [output.revisionId] : [])),
          ),
        ),
      ]),
    ]);
    const lockedLogos = await this.lockedWatermarkLogos(
      row.ownerId,
      value.orders.flatMap((order) =>
        order.items.flatMap((item) =>
          this.outputs(order, item).flatMap((output) => [output.proofWatermark, output.exportWatermark]),
        ),
      ),
    );
    const captures = value.captures.map((capture) => {
      const asset = assets.find((a) => a.id === capture.assetId);
      const eligible =
        !!asset &&
        !asset.isOffline &&
        asset.rating !== -1 &&
        !capture.withheld &&
        asset.checksum.toString('hex') === capture.checksum;
      return eligible
        ? {
            ...capture,
            proofRevisionId:
              capture.proofRevisionId && revisions.has(capture.proofRevisionId) ? capture.proofRevisionId : null,
            approvedRevisionId:
              capture.approvedRevisionId && revisions.has(capture.approvedRevisionId)
                ? capture.approvedRevisionId
                : null,
            assetIds: capture.assetIds.filter((id) =>
              assets.some((a) => a.id === id && !a.isOffline && a.rating !== -1),
            ),
            eligible: true,
            exclusion: null,
            rating: asset.rating,
            processing:
              asset.baseProofReady === undefined
                ? capture.processing
                : asset.baseProofReady
                  ? ('ready' as const)
                  : capture.processing === 'failed'
                    ? ('failed' as const)
                    : ('pending' as const),
          }
        : {
            ...capture,
            eligible: false,
            exclusion: capture.withheld
              ? 'withheld'
              : asset?.isOffline
                ? 'offline'
                : asset?.rating === -1
                  ? 'rejected'
                  : 'unavailable',
            assetId: null,
            assetIds: [],
            fileName: null,
            checksum: null,
            camera: null,
            capturedAt: null,
            rating: null,
            isRaw: null,
            proofRevisionId: null,
            approvedRevisionId: null,
            approvalRequested: false,
          };
    });
    const visible = new Set(captures.filter((capture) => capture.eligible).map((capture) => capture.id));
    return {
      revision: row.revision,
      shootId: row.id,
      config: value.config,
      presets: value.presets ?? [],
      studioPresets: await this.repository.studioPresets(row.ownerId),
      approvedVersions: (value.approvedVersions ?? []).filter(
        (version) => visible.has(version.captureId) && revisions.has(version.revisionId),
      ),
      pendingEdits: new Set(
        value.orders
          .filter(
            (order) =>
              ['accepted', 'settled', 'free'].includes(order.status) &&
              (order.paymentTiming !== 'before-editing' || ['settled', 'free'].includes(order.status)),
          )
          .flatMap((order) =>
            order.items
              .filter(
                (item) =>
                  visible.has(item.captureId) &&
                  this.outputs(order, item).some(
                    (output) =>
                      (!output.revisionId || revisions.has(output.revisionId)) &&
                      (!output.approved || !output.revisionId),
                  ),
              )
              .map((item) => item.captureId),
          ),
      ).size,
      captures,
      chapters: value.chapters,
      ordering: value.ordering,
      recipients: value.recipients.map(({ tokenHash: _token, passwordHash, ...recipient }) => ({
        ...recipient,
        captureIds: recipient.captureIds?.filter((id) => visible.has(id)) ?? null,
        choices: recipient.choices.filter((id) => visible.has(id)),
        notes: recipient.notes.filter((note) => visible.has(note.captureId)),
        passwordProtected: !!passwordHash,
      })),
      rounds: value.rounds.map((round) => ({
        ...round,
        captureIds: round.captureIds.filter((id) => visible.has(id)),
        notes: round.notes.filter((note) => visible.has(note.captureId)),
      })),
      orders: value.orders.map((order) => this.orderView(order, row.id, visible, revisions, lockedLogos)),
      publication: this.publicationView(value.publication),
      receipts: value.receipts,
      approvals: value.approvals.filter(
        (approval) => visible.has(approval.captureId) && revisions.has(approval.revisionId),
      ),
    };
  }
  private publicationView(publication: Publication | null) {
    return (
      publication && {
        id: publication.id,
        status: publication.status,
        completed: publication.completed,
        total: publication.total,
        error: publication.error,
        failedCaptureId: publication.failedCaptureId,
      }
    );
  }
  private async hydrateOutputFiles(value: PhotographyWorkflow) {
    for (const order of value.orders)
      for (const item of order.items) {
        for (const output of this.outputs(order, item))
          for (const field of ['finalPath', 'approvalPreviewPath'] as const)
            if (output[field]) {
              try {
                await access(output[field]!, constants.R_OK);
              } catch {
                output[field] = null;
              }
            }
        this.primary(item);
      }
  }
  private orderView(
    order: Order,
    shootId: string,
    visible: Set<string>,
    revisions: Set<string>,
    lockedLogos: Set<string>,
  ) {
    const items = order.items
      .filter((item) => visible.has(item.captureId))
      .flatMap((item) => {
        const outputs = this.visibleOutputs(order, item, revisions, lockedLogos);
        if (outputs.length === 0) return [];
        const projected = { ...item, outputs };
        this.primary(projected);
        return [projected];
      });
    return {
      id: order.id,
      recipientId: order.recipientId,
      roundId: order.roundId,
      status: order.status,
      currency: order.currency,
      total: order.total,
      captureIds: order.captureIds.filter((id) => visible.has(id)),
      terms: order.terms,
      paymentTiming: order.paymentTiming,
      pricing: order.pricing,
      createdAt: order.createdAt,
      acceptedAt: order.acceptedAt,
      items: items.map(({ finalPath, exportWatermark: _watermark, ...item }) => ({
        ...item,
        ready: !!finalPath,
        outputs: item.outputs!.map((output) => this.outputView(shootId, item, output)),
      })),
      readyCount: items.filter((item) => item.approved && item.finalPath).length,
      editingBlocked: order.paymentTiming === 'before-editing' && !['settled', 'free'].includes(order.status),
    };
  }
  async list(auth: AuthDto) {
    const ownerId = this.studioSession(auth);
    const shoots = (await this.workspace.get(ownerId))?.value.shoots ?? [];
    const rows = await this.repository.list(
      ownerId,
      shoots.map((shoot) => shoot.id),
    );
    return {
      galleries: rows
        .filter((row) => shoots.some((shoot) => shoot.id === row.shootId && shoot.albumId === row.albumId))
        .map(({ albumId: _album, ...gallery }) => gallery),
    };
  }
  async get(auth: AuthDto, id: string) {
    const owner = await this.owner(auth, id);
    const row = await this.repository.get(id);
    if (!row)
      return { ...(await this.ownerView({ id, ...owner, revision: '', value: owner.initial })), revision: null };
    if (row.ownerId !== owner.ownerId || row.albumId !== owner.albumId) throw new ForbiddenException();
    return this.ownerView(row);
  }
  private async mutate(
    auth: AuthDto,
    id: string,
    expected: string | null,
    change: (value: PhotographyWorkflow) => Promise<void> | void,
  ) {
    const owner = await this.owner(auth, id);
    const { row } = await this.repository.mutate(id, owner.ownerId, owner.albumId, expected, owner.initial, change);
    return this.ownerView(row);
  }
  async config(auth: AuthDto, id: string, input: PhotographyWorkflowConfigDto) {
    const dto = PhotographyWorkflowConfigDto.schema.parse(input);
    return this.mutate(auth, id, dto.expectedRevision, async (value) => {
      await this.validateConfig(auth, id, value, dto.config);
      value.config = dto.config;
    });
  }
  private async validateConfig(auth: AuthDto, id: string, value: PhotographyWorkflow, config: PhotographyConfig) {
    if (config.presentation.coverCaptureId && value.captures.every((c) => c.id !== config.presentation.coverCaptureId))
      throw new BadRequestException('Unknown cover');
    for (const block of config.presentation.blocks ?? []) {
      if (block.chapterId && value.chapters.every((chapter) => chapter.id !== block.chapterId))
        throw new BadRequestException('Unknown block chapter');
      if (block.captureIds.some((id) => value.captures.every((capture) => capture.id !== id)))
        throw new BadRequestException('Unknown block photograph');
    }
    for (const watermark of [
      config.proofWatermark,
      config.webWatermark,
      config.downloadWatermark,
      ...(config.downloadOutputs ?? []).map((output) => output.watermark),
    ])
      if (watermark?.logoAssetId) await this.logo(await this.owner(auth, id), watermark);
  }
  async savePreset(auth: AuthDto, id: string, input: PhotographyPresetSaveDto) {
    const dto = PhotographyPresetSaveDto.schema.parse(input);
    return this.mutate(auth, id, dto.expectedRevision, async (value) => {
      await this.validateConfig(auth, id, value, dto.config);
      value.presets ??= [];
      const preset = dto.id && value.presets.find((preset) => preset.id === dto.id);
      if (dto.id && !preset) throw new NotFoundException('Preset unavailable');
      if (preset) Object.assign(preset, { name: dto.name, config: structuredClone(dto.config) });
      else {
        if (value.presets.length >= 30) throw new ConflictException('Gallery preset limit reached');
        value.presets.push({ id: randomUUID(), name: dto.name, config: structuredClone(dto.config) });
      }
    });
  }
  async applyPreset(auth: AuthDto, id: string, presetId: string, input: PhotographyWorkflowMutationDto) {
    const dto = PhotographyWorkflowMutationDto.schema.parse(input);
    return this.mutate(auth, id, dto.expectedRevision, async (value) => {
      const preset = value.presets?.find((preset) => preset.id === presetId);
      if (!preset) throw new NotFoundException('Preset unavailable');
      await this.validateConfig(auth, id, value, preset.config);
      value.config = structuredClone(preset.config);
    });
  }
  async studioPresets(auth: AuthDto) {
    return this.repository.studioPresets(this.studioSession(auth));
  }
  async saveStudioPreset(auth: AuthDto, input: PhotographyPresetSaveDto) {
    const dto = PhotographyPresetSaveDto.schema.parse(input);
    const ownerId = this.studioSession(auth);
    for (const watermark of [
      dto.config.proofWatermark,
      dto.config.webWatermark,
      dto.config.downloadWatermark,
      ...(dto.config.downloadOutputs ?? []).map((output) => output.watermark),
    ])
      if (watermark?.logoAssetId) await this.logo({ ownerId, albumId: '' }, watermark);
    const result = await this.repository.mutateStudio(ownerId, dto.expectedRevision, (record) => {
      const current = dto.id && record.presets.find((preset) => preset.id === dto.id);
      if (dto.id && !current) throw new NotFoundException('Studio preset unavailable');
      const config = structuredClone(dto.config);
      config.presentation.coverCaptureId = null;
      if (config.presentation.blocks)
        config.presentation.blocks = config.presentation.blocks.map((block) => ({
          ...block,
          selection: 'automatic',
          chapterId: null,
          captureIds: [],
        }));
      if (current) Object.assign(current, { name: dto.name, config });
      else {
        if (record.presets.length >= 30) throw new ConflictException('Studio preset limit reached');
        record.presets.push({ id: randomUUID(), name: dto.name, config });
      }
    });
    return { revision: result.revision, presets: result.record.presets };
  }
  async applyStudioPreset(auth: AuthDto, id: string, presetId: string, input: PhotographyStudioPresetApplyDto) {
    const dto = PhotographyStudioPresetApplyDto.schema.parse(input);
    const owner = await this.owner(auth, id);
    const { row } = await this.repository.mutate(
      id,
      owner.ownerId,
      owner.albumId,
      dto.expectedRevision,
      owner.initial,
      async (value, tx) => {
        const preset = await this.repository.pinnedStudioPreset(
          tx,
          owner.ownerId,
          dto.expectedPresetRevision,
          presetId,
        );
        await this.validateConfig(auth, id, value, preset.config);
        value.config = structuredClone(preset.config);
      },
    );
    return this.ownerView(row);
  }
  private outputs(order: Order, item: OrderItem): DeliveryOutput[] {
    if (item.outputs) return item.outputs;
    const bytes = createHash('sha256').update(`${order.id}:${item.captureId}:print`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    item.outputs = [
      {
        id,
        key: 'print',
        label: 'Print',
        kind: 'print',
        revisionId: item.revisionId,
        approved: item.approved,
        clientApprovalRequired: item.clientApprovalRequired,
        explicitRevision: !!item.approved,
        finalPath: item.finalPath,
        exportSpec: structuredClone(item.exportSpec),
        exportWatermark: structuredClone(item.exportWatermark),
      },
    ];
    return item.outputs;
  }
  private primary(item: OrderItem) {
    const output = item.outputs?.find((output) => output.kind === 'print') ?? item.outputs?.[0];
    if (output) {
      item.revisionId = output.revisionId;
      item.approved = output.approved;
      item.clientApprovalRequired = output.clientApprovalRequired;
      item.finalPath = output.finalPath;
      item.exportSpec = structuredClone(output.exportSpec);
      item.exportWatermark = structuredClone(output.exportWatermark);
    }
  }
  private approveVersion(value: PhotographyWorkflow, captureId: string, revisionId: string) {
    value.approvedVersions ??= [];
    if (value.approvedVersions.some((version) => version.captureId === captureId && version.revisionId === revisionId))
      return;
    if (value.approvedVersions.length >= 20_000) throw new ConflictException('Approved version limit reached');
    value.approvedVersions.push({ captureId, revisionId, approvedAt: iso() });
  }
  private approvedVersion(value: PhotographyWorkflow, captureId: string, revisionId: string) {
    return (
      value.captures.some((capture) => capture.id === captureId && capture.approvedRevisionId === revisionId) ||
      value.approvedVersions?.some((version) => version.captureId === captureId && version.revisionId === revisionId) ||
      value.orders.some((order) =>
        order.items.some(
          (item) =>
            item.captureId === captureId &&
            this.outputs(order, item).some((output) => output.approved && output.revisionId === revisionId),
        ),
      )
    );
  }
  private outputView(shootId: string, item: Pick<OrderItem, 'captureId'>, output: DeliveryOutput) {
    return {
      id: output.id,
      label: output.label,
      kind: output.kind,
      revisionId: output.revisionId,
      approved: output.approved,
      approvalPreviewUrl:
        output.clientApprovalRequired && output.approvalPreviewPath && output.proofWatermark
          ? `/api/photography/galleries/${shootId}/photos/${item.captureId}/outputs/${output.id}/preview`
          : null,
      clientApprovalRequired: output.clientApprovalRequired,
      ready: !!output.finalPath,
      renderStatus:
        !output.approved || !output.revisionId
          ? ('awaiting-approval' as const)
          : output.finalPath
            ? ('ready' as const)
            : ('preparing' as const),
      branded: !!output.exportWatermark,
      exportSpec: output.exportSpec,
      url: `/api/photography/galleries/${shootId}/photos/${item.captureId}/outputs/${output.id}`,
    };
  }
  async intake(
    auth: AuthDto,
    id: string,
    input: Pick<PhotographyIntakeDto, 'expectedRevision'> & { expandCaptureIds?: string[] },
  ) {
    const dto = PhotographyIntakeDto.schema.parse(input);
    const owner = await this.owner(auth, id);
    const assets = await this.repository.assets(owner.ownerId, owner.albumId);
    if (assets.length > 10_000) throw new BadRequestException('Split shoots larger than 10000 files into albums');
    return this.mutate(auth, id, dto.expectedRevision, async (value) => {
      this.captureIds(value, dto.expandCaptureIds);
      value.expandedAssetIds = [
        ...new Set([
          ...(value.expandedAssetIds ?? []),
          ...value.captures.filter((c) => dto.expandCaptureIds.includes(c.id)).flatMap((c) => c.assetIds),
        ]),
      ];
      const groups = new Map<string, typeof assets>();
      for (const asset of assets) {
        const key = value.expandedAssetIds.includes(asset.id)
          ? asset.id
          : (asset.stackId ?? (asset.autoStackId ? `pair:${asset.autoStackId}` : asset.id));
        groups.set(key, [...(groups.get(key) ?? []), asset]);
      }
      const seen = new Set<string>();
      let number = Math.max(0, ...value.captures.map((capture) => capture.number));
      for (const group of groups.values()) {
        const previous =
          value.captures.find((capture) => group.some((asset) => asset.id === capture.assetId)) ??
          value.captures.find(
            (capture) => group.length > 1 && group.some((asset) => capture.assetIds.includes(asset.id)),
          );
        const asset =
          group.find((asset) => asset.id === previous?.assetId) ??
          group.find((asset) => !mimeTypes.isRaw(asset.originalFileName)) ??
          group[0];
        const source = await this.repository.proofSource(asset.id);
        const capture: PhotographyCapture = {
          ...(previous ?? {
            id: randomUUID(),
            number: ++number,
            chapterId: null,
            position: number,
            offsetSeconds: 0,
            photographer: '',
            withheld: false,
            proofRevisionId: null,
            approvedRevisionId: null,
            approvalRequested: false,
            state: 'imported',
          }),
          assetId: asset.id,
          assetIds: group.map((asset) => asset.id),
          checksum: asset.checksum.toString('hex'),
          fileName: asset.originalFileName,
          camera: [asset.make, asset.model].filter(Boolean).join(' '),
          capturedAt: new Date(asset.dateTimeOriginal ?? asset.fileCreatedAt).toISOString(),
          rating: asset.rating,
          isRaw: group.some((asset) => mimeTypes.isRaw(asset.originalFileName)),
          eligible: !asset.isOffline && asset.rating !== -1 && !previous?.withheld,
          exclusion: asset.isOffline
            ? 'offline'
            : asset.rating === -1
              ? 'rejected'
              : previous?.withheld
                ? 'withheld'
                : null,
          processing: asset.isOffline ? 'failed' : source ? 'ready' : 'pending',
        };
        seen.add(capture.id);
        if (previous) Object.assign(previous, capture);
        else value.captures.push(capture);
      }
      for (const capture of value.captures)
        if (!seen.has(capture.id)) {
          capture.eligible = false;
          capture.exclusion = 'unavailable';
        }
      this.sort(value);
    });
  }
  async retryCapture(auth: AuthDto, id: string, captureId: string, input: PhotographyWorkflowMutationDto) {
    const dto = PhotographyWorkflowMutationDto.schema.parse(input);
    const owner = await this.owner(auth, id);
    const row = await this.repository.get(id);
    if (!row || row.ownerId !== owner.ownerId || row.revision !== dto.expectedRevision)
      throw new ConflictException('Reload the intake before retrying');
    const capture = row.value.captures.find((c) => c.id === captureId);
    if (!capture || !(await this.eligible(row, [captureId])).has(captureId))
      throw new ForbiddenException('Source capture is unavailable');
    const result = await this.mutate(auth, id, dto.expectedRevision, (value) => {
      value.captures.find((c) => c.id === captureId)!.processing = 'pending';
    });
    await this.jobs.queue({ name: JobName.AssetExtractMetadata, data: { id: capture.assetId } });
    await this.jobs.queue({ name: JobName.AssetGenerateThumbnails, data: { id: capture.assetId } });
    return result;
  }
  private sort(value: PhotographyWorkflow) {
    const time = (c: PhotographyCapture) => Date.parse(c.capturedAt) + c.offsetSeconds * 1000;
    value.captures.sort((a, b) => {
      if (value.ordering === 'chronological') return time(a) - time(b) || a.number - b.number;
      if (value.ordering === 'photographer') return a.photographer.localeCompare(b.photographer) || time(a) - time(b);
      if (value.ordering === 'chapters')
        return (
          (value.chapters.find((c) => c.id === a.chapterId)?.position ?? 10_001) -
            (value.chapters.find((c) => c.id === b.chapterId)?.position ?? 10_001) || a.position - b.position
        );
      return a.position - b.position;
    });
  }
  async assembly(auth: AuthDto, id: string, input: PhotographyAssemblyDto) {
    const dto = PhotographyAssemblyDto.schema.parse(input);
    return this.mutate(auth, id, dto.expectedRevision, (value) => {
      if (
        new Set(dto.chapters.map((c) => c.id)).size !== dto.chapters.length ||
        new Set(dto.captures.map((c) => c.id)).size !== dto.captures.length
      )
        throw new BadRequestException('Duplicate IDs');
      for (const chapter of dto.chapters)
        if (chapter.coverCaptureId && value.captures.every((c) => c.id !== chapter.coverCaptureId))
          throw new BadRequestException('Unknown chapter cover');
      for (const patch of dto.captures) {
        const capture = value.captures.find((c) => c.id === patch.id);
        if (!capture || (patch.chapterId && dto.chapters.every((c) => c.id !== patch.chapterId)))
          throw new BadRequestException('Unknown capture or chapter');
        Object.assign(capture, patch);
      }
      value.chapters = dto.chapters;
      for (const capture of value.captures)
        if (capture.chapterId && value.chapters.every((c) => c.id !== capture.chapterId)) capture.chapterId = null;
      value.ordering = dto.ordering;
      this.sort(value);
    });
  }
  async createRecipient(auth: AuthDto, id: string, input: PhotographyRecipientCreateDto) {
    const dto = PhotographyRecipientCreateDto.schema.parse(input);
    const token = randomBytes(32).toString('hex');
    const recipientId = randomUUID();
    const passwordHash = dto.password ? await this.crypto.hashBcrypt(dto.password, 12) : null;
    const workflow = await this.mutate(auth, id, dto.expectedRevision, (value) => {
      if (value.recipients.length >= 200) throw new BadRequestException('Recipient limit reached');
      this.captureIds(value, dto.captureIds ?? []);
      value.recipients.push({
        id: recipientId,
        name: dto.name,
        tokenHash: hash(token),
        passwordHash,
        revoked: false,
        expiresAt: dto.expiresAt,
        canProof: dto.canProof,
        canDownload: dto.canDownload,
        captureIds: dto.captureIds,
        choices: [],
        notes: [],
      });
    });
    return { workflow, invitation: { recipientId, token } };
  }
  async updateRecipient(auth: AuthDto, id: string, recipientId: string, input: PhotographyRecipientUpdateDto) {
    const dto = PhotographyRecipientUpdateDto.schema.parse(input);
    return this.mutate(auth, id, dto.expectedRevision, (value) => {
      const recipient = value.recipients.find((r) => r.id === recipientId);
      if (!recipient) throw new NotFoundException();
      this.captureIds(value, dto.captureIds ?? []);
      const { expectedRevision: _revision, ...patch } = dto;
      Object.assign(recipient, patch);
      if (dto.revoked) value.sessions = value.sessions.filter((s) => s.recipientId !== recipientId);
    });
  }
  private captureIds(value: PhotographyWorkflow, ids: string[]) {
    if (ids.some((id) => value.captures.every((capture) => capture.id !== id)))
      throw new BadRequestException('Unknown capture');
  }
  private requireRecipient(row: WorkflowRow, recipientId: string) {
    const recipient = row.value.recipients.find((r) => r.id === recipientId);
    if (!recipient || recipient.revoked || expired(recipient.expiresAt) || expired(row.value.config.expiresAt))
      throw new ForbiddenException('Gallery access expired or revoked');
    return recipient;
  }
  private async guest(id: string, token: string | undefined) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ForbiddenException('Gallery session required');
    const row = await this.repository.get(id);
    if (!row) throw new NotFoundException('Gallery unavailable');
    await this.repository.live(row);
    const session = row.value.sessions.find((s) => s.hash === hash(token) && !expired(s.expiresAt));
    if (!session) throw new ForbiddenException('Gallery session expired');
    return { row, recipient: this.requireRecipient(row, session.recipientId) };
  }
  async session(id: string, input: PhotographyGallerySessionDto) {
    const dto = PhotographyGallerySessionDto.schema.parse(input);
    const row = await this.repository.get(id);
    if (!row) throw new ForbiddenException('Invalid invitation');
    await this.repository.live(row);
    const recipient = row.value.recipients.find((r) => r.tokenHash === hash(dto.token));
    if (!recipient) throw new ForbiddenException('Invalid invitation');
    this.requireRecipient(row, recipient.id);
    if (recipient.passwordHash && !this.crypto.compareBcrypt(dto.password ?? '', recipient.passwordHash))
      throw new ForbiddenException('Invalid invitation or password');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Math.min(
        Date.now() + 24 * 3_600_000,
        Date.parse(recipient.expiresAt ?? '9999-01-01'),
        Date.parse(row.value.config.expiresAt ?? '9999-01-01'),
      ),
    ).toISOString();
    await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, (value) => {
      this.requireRecipient({ ...row, value }, recipient.id);
      value.sessions = value.sessions.filter((s) => !expired(s.expiresAt));
      if (value.sessions.length >= 2000) throw new ConflictException('Gallery session limit reached');
      value.sessions.push({ hash: hash(token), recipientId: recipient.id, expiresAt });
    });
    return { session: token, expiresAt, recipientId: recipient.id };
  }
  private async eligible(row: WorkflowRow, captureIds: string[], publishedPixels = false) {
    // ponytail: legacy publications do not pin which proof/web watermark rendered each photo; check both until provenance is stored per photo.
    if (
      publishedPixels &&
      (
        await this.lockedWatermarkLogos(row.ownerId, [
          row.value.published?.config.proofWatermark,
          row.value.published?.config.webWatermark,
        ])
      ).size > 0
    )
      return new Set<string>();
    const captures = row.value.captures.filter((c) => captureIds.includes(c.id));
    const assets = await this.repository.assets(
      row.ownerId,
      row.albumId,
      captures.map((c) => c.assetId),
    );
    return new Set(
      captures
        .filter(
          (c) =>
            !c.withheld &&
            assets.some(
              (a) => a.id === c.assetId && !a.isOffline && a.rating !== -1 && a.checksum.toString('hex') === c.checksum,
            ),
        )
        .map((c) => c.id),
    );
  }
  private proofPermission(recipient: Recipient, id: string) {
    return recipient.canProof && (recipient.captureIds === null || recipient.captureIds.includes(id));
  }
  private async lockedWatermarkLogos(ownerId: string, watermarks: (PhotographyWatermark | null | undefined)[]) {
    const locked = new Set<string>();
    for (const id of new Set(
      watermarks.flatMap((watermark) =>
        watermark?.type !== 'text' && watermark?.logoAssetId ? [watermark.logoAssetId] : [],
      ),
    )) {
      if (!(await this.repository.logo(ownerId, id))[0]) locked.add(id);
    }
    return locked;
  }
  private visibleOutputs(order: Order, item: OrderItem, revisions: Set<string>, lockedLogos: Set<string>) {
    const hidden = (watermark: PhotographyWatermark | null | undefined) =>
      !!watermark?.logoAssetId && watermark.type !== 'text' && lockedLogos.has(watermark.logoAssetId);
    return this.outputs(order, item)
      .filter((output) => !output.revisionId || revisions.has(output.revisionId))
      .map((output) => ({
        ...output,
        finalPath: hidden(output.exportWatermark) ? null : output.finalPath,
        approvalPreviewPath:
          !output.proofWatermark || hidden(output.proofWatermark) ? null : output.approvalPreviewPath,
      }));
  }
  private async guestView(row: WorkflowRow, recipient: Recipient) {
    await this.hydrateOutputFiles(row.value);
    const published = row.value.published;
    const ids = [
      ...new Set([
        ...(published?.photos.map((p) => p.captureId) ?? []),
        ...row.value.orders.filter((order) => order.recipientId === recipient.id).flatMap((order) => order.captureIds),
      ]),
    ];
    const eligible = await this.eligible(row, ids);
    const proofEligible = await this.eligible(row, published?.photos.map((photo) => photo.captureId) ?? [], true);
    const revisions = await this.repository.eligibleRevisions(row, [
      ...new Set([
        ...(published?.photos ?? []).flatMap((p) => (p.revisionId ? [p.revisionId] : [])),
        ...row.value.orders
          .filter((o) => o.recipientId === recipient.id)
          .flatMap((o) =>
            o.items.flatMap((i) =>
              this.outputs(o, i).flatMap((output) => (output.revisionId ? [output.revisionId] : [])),
            ),
          ),
      ]),
    ]);
    const lockedLogos = await this.lockedWatermarkLogos(
      row.ownerId,
      row.value.orders
        .filter((order) => order.recipientId === recipient.id)
        .flatMap((order) =>
          order.items.flatMap((item) =>
            this.outputs(order, item).flatMap((output) => [output.proofWatermark, output.exportWatermark]),
          ),
        ),
    );
    const photos = (published?.photos ?? [])
      .filter(
        (photo) =>
          (!photo.revisionId || revisions.has(photo.revisionId)) &&
          proofEligible.has(photo.captureId) &&
          this.proofPermission(recipient, photo.captureId),
      )
      .map((photo) => {
        const capture = row.value.captures.find((c) => c.id === photo.captureId)!;
        const outputs = row.value.orders
          .filter((order) => order.recipientId === recipient.id)
          .flatMap((order) =>
            order.items
              .filter((item) => item.captureId === capture.id)
              .flatMap((item) =>
                this.visibleOutputs(order, item, revisions, lockedLogos).map((output) => {
                  const blockedReason = this.outputBlock(recipient, capture.id, order, output, revisions);
                  return {
                    ...this.outputView(row.id, item, output),
                    canDownload: blockedReason === null,
                    blockedReason,
                  };
                }),
              ),
          );
        const blockedReason = outputs.some((output) => output.canDownload)
          ? null
          : (outputs.at(-1)?.blockedReason ?? 'order');
        return {
          id: capture.id,
          number: photo.number,
          chapterId: photo.chapterId,
          status: capture.state,
          outputs,
          previewUrl: `/api/photography/galleries/${row.id}/photos/${capture.id}/preview`,
          thumbnailUrl: `/api/photography/galleries/${row.id}/photos/${capture.id}/thumbnail`,
          canDownload: blockedReason === null,
          blockedReason,
          approvalRevisionId:
            capture.approvalRequested &&
            photo.revisionId === capture.proofRevisionId &&
            outputs.some(
              (output) => output.revisionId === photo.revisionId && output.clientApprovalRequired && !output.approved,
            )
              ? photo.revisionId
              : null,
        };
      });
    const visible = new Set(photos.map((p) => p.id));
    const brand = published?.brand;
    const hasLogo = brand?.logoAssetId && (await this.repository.logo(row.ownerId, brand.logoAssetId))[0];
    const { logoAssetId: _logoId, ...publicBrand } = brand ?? {
      logoAssetId: null,
      name: row.value.config.title,
      tagline: '',
      email: '',
      phone: '',
      color: '#577059',
      background: '#f5f3ed',
      textColor: '#263329',
      font: 'editorial',
    };
    const presentation = structuredClone(published?.config.presentation ?? row.value.config.presentation);
    if (presentation.coverCaptureId && !visible.has(presentation.coverCaptureId)) presentation.coverCaptureId = null;
    if (presentation.blocks)
      presentation.blocks = presentation.blocks.map((block) => ({
        ...block,
        selection: block.selection ?? (block.captureIds.length > 0 ? 'explicit' : 'automatic'),
        captureIds: block.captureIds.filter((id) => visible.has(id)),
        chapterId:
          block.chapterId && published?.chapters.some((chapter) => chapter.id === block.chapterId)
            ? block.chapterId
            : null,
      }));
    return {
      revision: row.revision,
      checkoutAvailable: this.checkoutAvailable(row.ownerId),
      publishedGenerationId: published?.generationId ?? null,
      title: published?.config.title ?? row.value.config.title,
      mode: published?.config.mode ?? row.value.config.mode,
      presentation,
      brand: {
        ...publicBrand,
        logoUrl: hasLogo && published?.logoPath ? `/api/photography/galleries/${row.id}/logo` : null,
      },
      chapters: (published?.chapters ?? []).map((chapter) => ({
        ...chapter,
        coverCaptureId: chapter.coverCaptureId && visible.has(chapter.coverCaptureId) ? chapter.coverCaptureId : null,
      })),
      photos,
      recipient: { id: recipient.id, name: recipient.name, canDownload: recipient.canDownload },
      choices: recipient.choices.filter((id) => visible.has(id)),
      notes: recipient.notes.filter((n) => visible.has(n.captureId)),
      receipts: row.value.receipts.filter((receipt) => receipt.recipientId === recipient.id),
      rounds: row.value.rounds
        .filter((round) => round.recipientId === recipient.id)
        .map((round) => ({
          ...round,
          captureIds: round.captureIds.filter((id) => visible.has(id)),
          notes: round.notes.filter((note) => visible.has(note.captureId)),
        })),
      orders: row.value.orders
        .filter((order) => order.recipientId === recipient.id)
        .map((order) => this.orderView(order, row.id, eligible, revisions, lockedLogos)),
      publication: this.publicationView(row.value.publication),
      pricing: {
        currency: row.value.config.currency,
        includedCount: row.value.config.includedCount,
        additionalPrice: row.value.config.additionalPrice,
        collectionPrice: row.value.config.collectionPrice,
        bundles: row.value.config.bundles,
        terms: row.value.config.terms,
        selectionDeadline: row.value.config.selectionDeadline,
      },
    };
  }
  async gallery(id: string, token: string | undefined) {
    const { row, recipient } = await this.guest(id, token);
    return this.guestView(row, recipient);
  }
  private async guestMutation(
    id: string,
    token: string | undefined,
    expected: string | null,
    change: (value: PhotographyWorkflow, recipient: Recipient, row: WorkflowRow) => Promise<void> | void,
  ) {
    const guest = await this.guest(id, token);
    const { row } = await this.repository.mutate(
      id,
      guest.row.ownerId,
      guest.row.albumId,
      expected,
      guest.row.value,
      async (value) => {
        const row = { ...guest.row, value };
        const recipient = this.requireRecipient(row, guest.recipient.id);
        if (value.sessions.every((s) => s.hash !== hash(token!) || expired(s.expiresAt)))
          throw new ForbiddenException('Session revoked');
        await change(value, recipient, row);
      },
    );
    return this.guestView(row, this.requireRecipient(row, guest.recipient.id));
  }
  private async selection(row: WorkflowRow, recipient: Recipient, ids: string[], deadline = true) {
    if (deadline && expired(row.value.config.selectionDeadline))
      throw new ForbiddenException('Selection deadline passed');
    const eligible = await this.eligible(row, ids);
    if (
      ids.some(
        (id) =>
          !eligible.has(id) ||
          !this.proofPermission(recipient, id) ||
          !row.value.published?.photos.some((p) => p.captureId === id),
      )
    )
      throw new ForbiddenException('Photo is unavailable');
  }
  async choices(id: string, token: string | undefined, input: PhotographyChoicesDto) {
    const dto = PhotographyChoicesDto.schema.parse(input);
    return this.guestMutation(id, token, dto.expectedRevision, async (_value, recipient, row) => {
      await this.selection(
        row,
        recipient,
        dto.captureIds,
        recipient.choices.length !== dto.captureIds.length ||
          recipient.choices.some((id) => !dto.captureIds.includes(id)),
      );
      await this.selection(
        row,
        recipient,
        dto.notes.map((n) => n.captureId),
        false,
      );
      if (new Set(dto.notes.map((note) => note.captureId)).size !== dto.notes.length)
        throw new BadRequestException('Duplicate photograph notes');
      recipient.choices = dto.captureIds;
      recipient.notes = dto.notes;
    });
  }
  async submit(id: string, token: string | undefined, input: PhotographyWorkflowMutationDto) {
    const dto = PhotographyWorkflowMutationDto.schema.parse(input);
    return this.guestMutation(id, token, dto.expectedRevision, async (value, recipient, row) => {
      if (recipient.choices.length === 0) throw new BadRequestException('Choose photographs first');
      if (value.rounds.length >= 2000) throw new ConflictException('Selection round limit reached');
      await this.selection(row, recipient, recipient.choices);
      value.rounds.push({
        id: randomUUID(),
        recipientId: recipient.id,
        number: value.rounds.filter((r) => r.recipientId === recipient.id).length + 1,
        captureIds: [...recipient.choices],
        notes: structuredClone(recipient.notes),
        createdAt: iso(),
      });
      for (const capture of value.captures)
        if (recipient.choices.includes(capture.id) && capture.state === 'imported') capture.state = 'selected';
    });
  }
  async order(auth: AuthDto, id: string, input: PhotographyOrderCreateDto) {
    const dto = PhotographyOrderCreateDto.schema.parse(input);
    const owner = await this.owner(auth, id);
    const result = await this.mutate(auth, id, dto.expectedRevision, async (value) => {
      const round = value.rounds.find((r) => r.id === dto.roundId && r.recipientId === dto.recipientId);
      if (!round && value.config.mode !== 'edited-delivery')
        throw new BadRequestException('Selection round unavailable');
      if (value.orders.length >= 2000) throw new ConflictException('Order history limit reached');
      const captureIds =
        dto.pricing === 'collection'
          ? (value.published?.photos.map((p) => p.captureId) ?? [])
          : round
            ? [...round.captureIds]
            : (dto.captureIds ?? value.published?.photos.map((p) => p.captureId) ?? []);
      if (captureIds.length === 0) throw new BadRequestException('Empty order');
      const recipient = this.requireRecipient({ id, ...owner, value, revision: '' }, dto.recipientId);
      await this.selection({ id, ...owner, value, revision: '' }, recipient, captureIds, false);
      const total = priceSelection(value.config, captureIds.length, dto.pricing, dto.bundleCount);
      const includedDelivery = !round && value.config.mode === 'edited-delivery' && total === 0;
      const definitions = dto.outputs ??
        value.config.downloadOutputs?.map((output) => ({ ...output, revisions: [] })) ?? [
          {
            key: 'print',
            label: 'Print',
            kind: 'print' as const,
            maxEdge: 65_535,
            watermark: structuredClone(value.config.downloadWatermark),
            revisions: [],
          },
        ];
      for (const definition of definitions) {
        if (definition.revisions.some((mapping) => !captureIds.includes(mapping.captureId)))
          throw new BadRequestException('Output mapping is outside the order');
        if (definition.watermark?.logoAssetId) await this.logo(owner, definition.watermark);
      }
      const items: OrderItem[] = [];
      for (const captureId of captureIds) {
        const capture = value.captures.find((capture) => capture.id === captureId)!;
        const outputs: DeliveryOutput[] = [];
        for (const definition of definitions) {
          const mapping = definition.revisions.find((mapping) => mapping.captureId === captureId);
          const revisionId =
            mapping?.revisionId ?? (capture.approvalRequested ? capture.proofRevisionId : capture.approvedRevisionId);
          const clientApprovalRequired =
            !!revisionId &&
            ((capture.approvalRequested && capture.proofRevisionId === revisionId) ||
              value.approvals.some(
                (approval) => approval.captureId === captureId && approval.revisionId === revisionId,
              ));
          const recipientApproval =
            value.approvals.findLast(
              (approval) =>
                approval.recipientId === recipient.id &&
                approval.captureId === captureId &&
                approval.revisionId === revisionId,
            )?.approved === true;
          const approved = !!revisionId && (!clientApprovalRequired || recipientApproval);
          if (mapping && !this.approvedVersion(value, captureId, mapping.revisionId))
            throw new BadRequestException('Approve the mapped version before adding it to an order');
          if (revisionId) await this.requireRevision({ id, ...owner, value, revision: '' }, capture, revisionId);
          outputs.push({
            id: randomUUID(),
            key: definition.key,
            label: definition.label,
            kind: definition.kind,
            revisionId,
            approved,
            clientApprovalRequired,
            explicitRevision: !!mapping || approved,
            finalPath: null,
            proofWatermark: structuredClone(value.config.proofWatermark),
            approvalPreviewPath: null,
            exportWatermark: structuredClone(definition.watermark),
            exportSpec: { format: 'jpeg', quality: 90, maxEdge: definition.maxEdge },
          });
        }
        const item: OrderItem = {
          captureId,
          revisionId: null,
          approved: false,
          clientApprovalRequired: false,
          finalPath: null,
          exportWatermark: null,
          exportSpec: { format: 'jpeg', quality: 90, maxEdge: 65_535 },
          outputs,
        };
        this.primary(item);
        items.push(item);
      }
      value.orders.push({
        id: randomUUID(),
        recipientId: dto.recipientId,
        roundId: dto.roundId,
        status: includedDelivery ? 'free' : 'quoted',
        currency: value.config.currency,
        total,
        captureIds,
        terms: value.config.terms,
        paymentTiming: value.config.paymentTiming,
        pricing: {
          includedCount: value.config.includedCount,
          additionalPrice: value.config.additionalPrice,
          collectionPrice: value.config.collectionPrice,
          bundles: structuredClone(value.config.bundles),
          option: dto.pricing,
        },
        items,
        createdAt: iso(),
        acceptedAt: includedDelivery ? iso() : null,
        checkoutId: null,
        paymentIntentId: null,
      });
      if (includedDelivery) {
        this.receipt(value, value.orders.at(-1)!, 'included', 'Studio confirmed the included edited delivery');
        this.prepareDeliveries(value);
      }
    });
    await this.jobs.queue({ name: JobName.PhotographyWorkflowRender, data: { id } });
    return result;
  }
  async accept(id: string, token: string | undefined, orderId: string, input: PhotographyOrderAcceptDto) {
    const dto = PhotographyOrderAcceptDto.schema.parse(input);
    const result = await this.guestMutation(id, token, dto.expectedRevision, async (value, recipient, row) => {
      const order = value.orders.find((o) => o.id === orderId && o.recipientId === recipient.id);
      if (!order) throw new NotFoundException();
      if (order.status !== 'quoted') throw new ConflictException('Quote already accepted or withdrawn');
      await this.selection({ ...row, value }, recipient, order.captureIds, false);
      order.status = order.total === 0 ? 'free' : 'accepted';
      order.acceptedAt = iso();
      this.receipt(value, order, 'accepted', 'Client accepted the immutable quote');
      this.prepareDeliveries(value);
    });
    await this.jobs.queue({ name: JobName.PhotographyWorkflowRender, data: { id } });
    return result;
  }
  private receipt(value: PhotographyWorkflow, order: Order, action: string, reference: string) {
    if (value.receipts.length >= 5000) throw new ConflictException('Receipt history limit reached');
    value.receipts.push({
      id: randomUUID(),
      orderId: order.id,
      recipientId: order.recipientId,
      action,
      reference,
      createdAt: iso(),
    });
  }
  async payment(auth: AuthDto, id: string, orderId: string, input: PhotographyPaymentDto) {
    const dto = PhotographyPaymentDto.schema.parse(input);
    return this.mutate(auth, id, dto.expectedRevision, (value) => {
      const order = value.orders.find((o) => o.id === orderId);
      if (!order) throw new NotFoundException();
      if (order.checkoutId) throw new ConflictException('Reconcile the hosted checkout through its provider');
      if (dto.action === 'settle' && order.status !== 'accepted')
        throw new ConflictException('Only an accepted unpaid order can settle');
      if (dto.action === 'refund' && order.status !== 'settled')
        throw new ConflictException('Only a settled order can refund');
      if (dto.action === 'cancel' && !['quoted', 'accepted'].includes(order.status))
        throw new ConflictException('Settled orders require a refund');
      order.status = dto.action === 'settle' ? 'settled' : dto.action === 'refund' ? 'refunded' : 'cancelled';
      this.receipt(value, order, dto.action, dto.reference);
    });
  }
  async approval(auth: AuthDto, id: string, input: PhotographyApprovalDto) {
    const dto = PhotographyApprovalDto.schema.parse(input);
    const owner = await this.owner(auth, id);
    const result = await this.mutate(auth, id, dto.expectedRevision, async (value) => {
      const capture = value.captures.find((c) => c.id === dto.captureId);
      if (!capture) throw new NotFoundException();
      if (
        value.orders.some(
          (order) =>
            order.captureIds.includes(dto.captureId) &&
            order.paymentTiming === 'before-editing' &&
            !['settled', 'free', 'cancelled', 'refunded'].includes(order.status),
        )
      )
        throw new ConflictException('Settle the order before approving its edit');
      const revision = await this.revisions.get(dto.revisionId);
      if (
        !revision ||
        revision.ownerId !== owner.ownerId ||
        !capture.assetIds.includes(revision.assetId) ||
        revision.status !== AssetDevelopRevisionStatus.Rendered ||
        !revision.masterPath
      )
        throw new BadRequestException('A rendered owned edit is required');
      await this.requireRevision({ id, ...owner, value, revision: '' }, capture, revision.id);
      if (capture.approvedRevisionId) this.approveVersion(value, capture.id, capture.approvedRevisionId);
      if (!dto.requestClientApproval) this.approveVersion(value, capture.id, revision.id);
      capture.proofRevisionId = revision.id;
      capture.approvalRequested = dto.requestClientApproval;
      capture.approvedRevisionId = dto.requestClientApproval ? null : revision.id;
      capture.state = dto.requestClientApproval ? 'approval-requested' : 'approved';
      for (const order of value.orders)
        for (const item of order.items) {
          if (item.captureId !== capture.id) continue;
          for (const output of this.outputs(order, item))
            if (!output.approved && !output.explicitRevision) {
              output.revisionId = revision.id;
              output.approved = !dto.requestClientApproval;
              output.clientApprovalRequired = dto.requestClientApproval;
              output.explicitRevision = !dto.requestClientApproval;
              output.finalPath = null;
              output.approvalPreviewPath = null;
            }
          this.primary(item);
        }
      if (!dto.requestClientApproval) this.prepareDeliveries(value);
    });
    if (!dto.requestClientApproval) await this.jobs.queue({ name: JobName.PhotographyWorkflowRender, data: { id } });
    return result;
  }
  async guestApproval(id: string, token: string | undefined, input: PhotographyGuestApprovalDto) {
    const dto = PhotographyGuestApprovalDto.schema.parse(input);
    const result = await this.guestMutation(id, token, dto.expectedRevision, async (value, recipient, row) => {
      await this.selection(row, recipient, [dto.captureId], false);
      const capture = value.captures.find((c) => c.id === dto.captureId);
      if (
        !capture ||
        !(
          value.published?.photos.some((p) => p.captureId === capture.id && p.revisionId === dto.revisionId) ||
          value.orders
            .filter((order) => order.recipientId === recipient.id && !['cancelled', 'refunded'].includes(order.status))
            .some((order) =>
              order.items.some(
                (item) =>
                  item.captureId === capture.id &&
                  this.outputs(order, item).some(
                    (output) =>
                      output.revisionId === dto.revisionId &&
                      output.clientApprovalRequired &&
                      output.approvalPreviewPath,
                  ),
              ),
            )
        )
      )
        throw new ConflictException('Approval proof changed; reload');
      await this.requireRevision({ ...row, value }, capture, dto.revisionId);
      const items = value.orders
        .filter((order) => order.recipientId === recipient.id && !['cancelled', 'refunded'].includes(order.status))
        .flatMap((order) =>
          order.items.filter((item) => item.captureId === capture.id).flatMap((item) => this.outputs(order, item)),
        )
        .filter((output) => output.revisionId === dto.revisionId && output.clientApprovalRequired && !output.approved);
      if (items.length === 0) throw new ForbiddenException('No approval request for this recipient');
      if (value.approvals.length >= 5000) throw new ConflictException('Approval history limit reached');
      value.approvals.push({
        recipientId: recipient.id,
        captureId: dto.captureId,
        revisionId: dto.revisionId,
        approved: dto.approved,
        note: dto.note,
        createdAt: iso(),
      });
      for (const output of items) {
        output.approved = dto.approved;
        if (dto.approved) output.explicitRevision = true;
      }
      for (const order of value.orders) for (const item of order.items) this.primary(item);
      if (dto.approved) {
        this.approveVersion(value, capture.id, dto.revisionId);
        if (capture.proofRevisionId === dto.revisionId) {
          capture.approvedRevisionId = dto.revisionId;
          capture.state = 'approved';
        }
        this.prepareDeliveries(value);
      }
    });
    if (dto.approved) await this.jobs.queue({ name: JobName.PhotographyWorkflowRender, data: { id } });
    return result;
  }
  async publish(auth: AuthDto, id: string, input: PhotographyPublicationDto) {
    const dto = PhotographyPublicationDto.schema.parse(input);
    const owner = await this.owner(auth, id);
    const result = await this.mutate(auth, id, dto.expectedRevision, async (value) => {
      if (value.publication && ['queued', 'rendering'].includes(value.publication.status))
        throw new ConflictException('Publication already in progress');
      const selected = new Set(value.rounds.flatMap((round) => round.captureIds));
      const eligible = await this.eligible(
        { id, ...owner, value, revision: '' },
        value.captures.map((c) => c.id),
      );
      const captures = value.captures.filter(
        (c) => eligible.has(c.id) && (dto.scope === 'all-eligible' || selected.has(c.id)),
      );
      const studio = (await this.workspace.get(owner.ownerId))?.value.brand;
      const brand = {
        name: studio?.name ?? value.config.title,
        tagline: studio?.tagline ?? '',
        email: studio?.email ?? '',
        phone: studio?.phone ?? '',
        color: studio?.color ?? '#577059',
        background: studio?.background ?? '#f5f3ed',
        textColor: studio?.textColor ?? '#263329',
        font: studio?.font ?? 'editorial',
        logoAssetId: studio?.logoAssetId ?? null,
      };
      if (captures.length === 0) throw new BadRequestException('No eligible photographs');
      value.publication = {
        id: randomUUID(),
        status: 'queued',
        completed: 0,
        total: captures.length,
        error: null,
        failedCaptureId: null,
        captureIds: captures.map((c) => c.id),
        config: structuredClone(value.config),
        updatedAt: iso(),
        claim: null,
        photos: [],
        sources: captures.map((c) => ({
          captureId: c.id,
          revisionId: c.proofRevisionId,
          approved: !!c.approvedRevisionId && c.approvedRevisionId === c.proofRevisionId && !c.approvalRequested,
          number: c.number,
          chapterId: c.chapterId,
        })),
        brand,
        logoPath: null,
        chapters: structuredClone(value.chapters),
      };
    });
    await this.jobs.queue({ name: JobName.PhotographyWorkflowRender, data: { id } });
    return result;
  }
  private prepareDeliveries(value: PhotographyWorkflow) {
    if (!value.publication) return;
    value.publication = {
      ...value.publication,
      id: randomUUID(),
      status: 'queued',
      claim: null,
      error: null,
      failedCaptureId: null,
      photos: [],
      completed: 0,
      updatedAt: iso(),
    };
  }
  async retry(auth: AuthDto, id: string, input: PhotographyWorkflowMutationDto) {
    const dto = PhotographyWorkflowMutationDto.schema.parse(input);
    const result = await this.mutate(auth, id, dto.expectedRevision, (value) => {
      if (!value.publication) throw new BadRequestException('Publish photographs first');
      if (
        value.publication.status === 'rendering' &&
        Date.parse(value.publication.updatedAt) > Date.now() - 10 * 60_000
      )
        throw new ConflictException('Publication is still rendering');
      this.prepareDeliveries(value);
    });
    await this.jobs.queue({ name: JobName.PhotographyWorkflowRender, data: { id } });
    return result;
  }
  private async logo(
    owner: { ownerId: string; albumId: string },
    watermark: PhotographyWatermark,
  ): Promise<Buffer | undefined> {
    if (!watermark.logoAssetId) {
      if (watermark.type !== 'text') throw new BadRequestException('A logo is required');
      return;
    }
    // Logo eligibility is owner-scoped and independent of gallery inclusion; its decoded bytes never become a guest source URL.
    const assets = await this.repository.logo(owner.ownerId, watermark.logoAssetId);
    const asset = assets[0];
    if (!asset || asset.isOffline) throw new ForbiddenException('Logo is unavailable');
    const bytes = await this.logoBytes(asset.originalPath);
    await preparePhotographyLogo(bytes);
    return bytes;
  }
  private async logoBytes(file: string) {
    const handle = await open(file, 'r');
    try {
      const bytes = Buffer.alloc(512_001);
      const result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 512_000) throw new BadRequestException('Logo exceeds the decoded input limit');
      return bytes.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }
  private renditionFolder(row: WorkflowRow, publicationId: string) {
    return path.join(
      StorageCore.getFolderLocation(StorageFolder.Exports, row.ownerId),
      'photography',
      row.id,
      publicationId,
    );
  }
  private async atomicFile(file: string, bytes: Buffer) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  }
  @OnJob({ name: JobName.PhotographyWorkflowRender, queue: QueueName.ThumbnailGeneration })
  async render({ id }: JobOf<JobName.PhotographyWorkflowRender>): Promise<JobStatus> {
    let row = await this.repository.get(id);
    if (!row || !row.value.publication) return JobStatus.Skipped;
    const claim = randomUUID();
    const publicationId = row.value.publication.id;
    const claimed = await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, (value) => {
      const p = value.publication;
      if (
        !p ||
        p.id !== publicationId ||
        (p.status === 'rendering' && Date.parse(p.updatedAt) > Date.now() - 10 * 60_000) ||
        p.status === 'ready'
      )
        return false;
      p.status = 'rendering';
      p.claim = claim;
      p.updatedAt = iso();
      return true;
    });
    if (!claimed.result) {
      const p = claimed.row.value.publication;
      if (p?.status === 'rendering')
        await this.jobs.queue({
          name: JobName.PhotographyWorkflowRender,
          data: { id, delay: Math.max(1000, Date.parse(p.updatedAt) + 10 * 60_000 - Date.now()) },
        });
      return JobStatus.Skipped;
    }
    row = claimed.row;
    const publication = row.value.publication!;
    const folder = this.renditionFolder(row, publicationId);
    let activeCaptureId: string | null = null;
    const preparedApprovals: {
      orderId: string;
      captureId: string;
      outputId: string;
      revisionId: string;
      path: string;
      watermark: PhotographyWatermark;
    }[] = [];
    const preparedFinals: { orderId: string; captureId: string; outputId: string; revisionId: string; path: string }[] =
      [];
    // ponytail: one decoder per job and at most 10000 captures; normalize JSON progress if very large studios need higher write throughput.
    try {
      if (publication.brand.logoAssetId) {
        const logo = (await this.repository.logo(row.ownerId, publication.brand.logoAssetId))[0];
        if (!logo || logo.isOffline) throw new ForbiddenException('Studio logo unavailable');
        const file = path.join(folder, 'studio-logo.png');
        await this.atomicFile(file, (await preparePhotographyLogo(await this.logoBytes(logo.originalPath))).original);
        await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, (value) => {
          if (value.publication?.claim !== claim) throw new ConflictException('Publication superseded');
          value.publication.logoPath = file;
        });
      }
      for (const captureId of publication.captureIds) {
        activeCaptureId = captureId;
        row = (await this.repository.get(id))!;
        if (row.value.publication?.claim !== claim) return JobStatus.Skipped;
        const capture = row.value.captures.find((c) => c.id === captureId)!;
        if (!(await this.eligible(row, [captureId])).has(captureId))
          throw new ForbiddenException('Capture is no longer eligible');
        let source: string | undefined;
        const pinned = publication.sources.find((source) => source.captureId === captureId)!;
        const revisionId = pinned.revisionId;
        if (revisionId) {
          const revision = await this.revisions.get(revisionId);
          await this.requireRevision(row, capture, revisionId);
          source = revision?.masterPath ?? undefined;
        } else source = (await this.repository.proofSource(capture.assetId))?.path;
        if (!source) throw new ConflictException('Base proof processing is not ready');
        // Every public size is rendered from local prepared pixels; there is no original fallback.
        const watermark =
          revisionId && pinned.approved
            ? (publication.config.webWatermark ?? publication.config.proofWatermark)
            : publication.config.proofWatermark;
        const logo = await this.logo(row, watermark);
        const previewPath = path.join(folder, `${captureId}-preview.jpg`);
        const thumbnailPath = path.join(folder, `${captureId}-thumbnail.jpg`);
        await this.atomicFile(previewPath, await renderPhotographyRendition(source, watermark, logo, 2400));
        await this.atomicFile(thumbnailPath, await renderPhotographyRendition(source, watermark, logo, 480));
        // Existing successful files remain until the entire new proof set is ready.
        await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, (value) => {
          const p = value.publication;
          if (!p || p.claim !== claim) throw new ConflictException('Publication superseded');
          p.photos = p.photos.filter((photo) => photo.captureId !== captureId);
          p.photos.push({
            captureId,
            number: pinned.number,
            chapterId: pinned.chapterId,
            previewPath,
            thumbnailPath,
            revisionId,
          });
          p.completed = p.photos.length;
          p.updatedAt = iso();
        });
      }
      activeCaptureId = null;
      row = (await this.repository.get(id))!;
      await this.hydrateOutputFiles(row.value);
      // Renditions pin each approved order item rather than following the currently selected edit.
      for (const order of row.value.orders)
        for (const item of order.items)
          for (const output of this.outputs(order, item)) {
            if (!output.revisionId || ['cancelled', 'refunded'].includes(order.status)) continue;
            if (output.clientApprovalRequired && (!output.approvalPreviewPath || !output.proofWatermark)) {
              activeCaptureId = item.captureId;
              const capture = row.value.captures.find((capture) => capture.id === item.captureId)!;
              const revision = await this.requireRevision(row, capture, output.revisionId);
              const watermark = output.proofWatermark ?? publication.config.proofWatermark;
              const file = path.join(folder, `${order.id}-${output.id}-${output.revisionId}-approval.jpg`);
              await this.atomicFile(
                file,
                await renderPhotographyRendition(
                  revision.masterPath!,
                  watermark,
                  await this.logo(row, watermark),
                  2400,
                ),
              );
              preparedApprovals.push({
                orderId: order.id,
                captureId: item.captureId,
                outputId: output.id,
                revisionId: output.revisionId,
                path: file,
                watermark,
              });
            }
            if (!output.approved) continue;
            if (output.finalPath) {
              try {
                await access(output.finalPath, constants.R_OK);
                continue;
              } catch {
                /* Recover missing prepared output. */
              }
            }
            activeCaptureId = item.captureId;
            const capture = row.value.captures.find((c) => c.id === item.captureId)!;
            const revision = await this.requireRevision(row, capture, output.revisionId);
            const logo = output.exportWatermark ? await this.logo(row, output.exportWatermark) : undefined;
            const file = path.join(folder, `${order.id}-${item.captureId}-${output.id}-${output.revisionId}-final.jpg`);
            await this.atomicFile(
              file,
              await renderPhotographyRendition(
                revision.masterPath!,
                output.exportWatermark,
                logo,
                output.exportSpec.maxEdge,
              ),
            );
            preparedFinals.push({
              orderId: order.id,
              captureId: item.captureId,
              outputId: output.id,
              revisionId: output.revisionId,
              path: file,
            });
          }
      activeCaptureId = null;
      row = (await this.repository.get(id))!;
      await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, async (value) => {
        const p = value.publication;
        if (!p || p.claim !== claim) throw new ConflictException('Publication superseded');
        const eligible = await this.eligible({ ...row!, value }, p.captureIds);
        if (p.photos.length !== p.captureIds.length || p.captureIds.some((id) => !eligible.has(id)))
          throw new ConflictException('Proof eligibility changed');
        const pinnedRevisionIds = [
          ...new Set([
            ...p.photos.flatMap((photo) => (photo.revisionId ? [photo.revisionId] : [])),
            ...preparedFinals.map((final) => final.revisionId),
            ...preparedApprovals.map((approval) => approval.revisionId),
          ]),
        ];
        const currentRevisions = await this.repository.eligibleRevisions({ ...row!, value }, pinnedRevisionIds);
        if (pinnedRevisionIds.some((id) => !currentRevisions.has(id)))
          throw new ConflictException('Pinned source eligibility changed');
        for (const final of preparedFinals) {
          const item = value.orders
            .find((order) => order.id === final.orderId)
            ?.items.find((item) => item.captureId === final.captureId);
          const order = value.orders.find((order) => order.id === final.orderId);
          const output = order && item && this.outputs(order, item).find((output) => output.id === final.outputId);
          if (output?.approved && output.revisionId === final.revisionId) {
            output.finalPath = final.path;
            this.primary(item!);
          }
        }
        for (const prepared of preparedApprovals) {
          const order = value.orders.find((order) => order.id === prepared.orderId);
          const item = order?.items.find((item) => item.captureId === prepared.captureId);
          const output = order && item && this.outputs(order, item).find((output) => output.id === prepared.outputId);
          if (output?.clientApprovalRequired && output.revisionId === prepared.revisionId) {
            output.approvalPreviewPath = prepared.path;
            output.proofWatermark = prepared.watermark;
          }
        }
        value.published = {
          generationId: p.id,
          config: structuredClone(p.config),
          chapters: structuredClone(p.chapters),
          photos: structuredClone(p.photos),
          brand: structuredClone(p.brand),
          logoPath: p.logoPath,
        };
        p.status = 'ready';
        p.claim = null;
        p.updatedAt = iso();
      });
      return JobStatus.Success;
    } catch {
      const current = await this.repository.get(id);
      if (current)
        await this.repository.mutate(id, current.ownerId, current.albumId, undefined, current.value, (value) => {
          if (value.publication?.claim !== claim) {
            return;
          }

          value.publication.status = 'failed';
          value.publication.failedCaptureId = activeCaptureId;
          const failed = value.captures.find((capture) => capture.id === activeCaptureId);
          if (failed) failed.processing = 'failed';
          value.publication.claim = null;
          value.publication.error =
            'Photograph preparation failed. Check source processing, edit revisions and watermark logo, then retry.';
          value.publication.updatedAt = iso();
        });
      return JobStatus.Failed;
    }
  }
  private async requireRevision(row: WorkflowRow, capture: PhotographyCapture, revisionId: string) {
    const revision = await this.revisions.get(revisionId);
    if (
      !revision ||
      revision.ownerId !== row.ownerId ||
      !capture.assetIds.includes(revision.assetId) ||
      revision.status !== AssetDevelopRevisionStatus.Rendered ||
      !revision.masterPath
    )
      throw new ForbiddenException('Approved edit is unavailable');
    const assets = await this.repository.assets(row.ownerId, row.albumId, [revision.assetId]);
    const source = assets[0];
    if (
      !source ||
      source.isOffline ||
      source.rating === -1 ||
      (revision.sourceChecksum && !revision.sourceChecksum.equals(source.checksum))
    )
      throw new ForbiddenException('Approved source is unavailable');
    return revision;
  }
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async recover() {
    let cursor: string | null = null;
    for (;;) {
      const rows = await this.repository.unfinished(cursor);
      for (const row of rows)
        await this.jobs.queue({
          name: JobName.PhotographyWorkflowRender,
          data: {
            id: row.id,
            delay:
              row.value.publication?.status === 'rendering'
                ? Math.max(0, Date.parse(row.value.publication.updatedAt) + 10 * 60_000 - Date.now())
                : 0,
          },
        });
      if (rows.length < 200) return;
      cursor = rows.at(-1)!.id;
    }
  }
  private outputBlock(
    recipient: Recipient,
    captureId: string,
    order: Order,
    output: DeliveryOutput,
    revisions: Set<string>,
  ) {
    return deliveryBlock(recipient, recipient.id, captureId, [
      {
        ...order,
        items: [
          {
            captureId,
            approved: output.approved && !!output.revisionId && revisions.has(output.revisionId),
            revisionId: output.revisionId,
            finalPath: output.finalPath,
          },
        ],
      },
    ]);
  }
  private async downloadItem(
    row: WorkflowRow,
    recipient: Recipient,
    captureId: string,
    outputId?: string,
    pinned?: { orderId: string; revisionId: string },
  ) {
    if (!(await this.eligible(row, [captureId])).has(captureId))
      throw new ForbiddenException('Photograph is unavailable');
    const candidates = row.value.orders
      .filter((order) => order.recipientId === recipient.id && (!pinned || order.id === pinned.orderId))
      .toReversed()
      .flatMap((order) =>
        order.items
          .filter((item) => item.captureId === captureId)
          .flatMap((item) => {
            const outputs = this.outputs(order, item);
            const selected = outputId
              ? outputs.filter((output) => output.id === outputId)
              : [outputs.find((output) => output.kind === 'print') ?? outputs[0]];
            return selected.filter(Boolean).map((output) => ({ order, item, output }));
          }),
      );
    const revisions = await this.repository.eligibleRevisions(
      row,
      candidates.flatMap(({ output }) => (output.revisionId ? [output.revisionId] : [])),
    );
    const candidate = candidates.find(
      ({ order, output }) =>
        (!pinned || output.revisionId === pinned.revisionId) &&
        this.outputBlock(recipient, captureId, order, output, revisions) === null,
    );
    if (!candidate) throw new ForbiddenException('Approved output is not available for download');
    const { order, output } = candidate;
    if ((await this.lockedWatermarkLogos(row.ownerId, [output.exportWatermark])).size > 0)
      throw new ForbiddenException('Output logo is unavailable');
    await this.requireRevision(
      row,
      row.value.captures.find((capture) => capture.id === captureId)!,
      output.revisionId!,
    );
    try {
      await access(output.finalPath!, constants.R_OK);
    } catch {
      throw new ConflictException('Final rendition is unavailable; the studio must prepare it again');
    }
    return { ...output, orderId: order.id };
  }
  async outputPreview(
    id: string,
    token: string | undefined,
    captureId: string,
    outputId: string,
  ): Promise<ImmichFileResponse> {
    const { row, recipient } = await this.guest(id, token);
    if (!this.proofPermission(recipient, captureId) || !(await this.eligible(row, [captureId])).has(captureId))
      throw new ForbiddenException();
    const output = row.value.orders
      .filter((order) => order.recipientId === recipient.id && !['cancelled', 'refunded'].includes(order.status))
      .flatMap((order) =>
        order.items.filter((item) => item.captureId === captureId).flatMap((item) => this.outputs(order, item)),
      )
      .find((output) => output.id === outputId && output.clientApprovalRequired && output.approvalPreviewPath);
    if (!output?.revisionId) throw new NotFoundException('Approval proof is preparing');
    if (!output.proofWatermark)
      throw new ConflictException('Regenerate this approval proof to establish its watermark source');
    if ((await this.lockedWatermarkLogos(row.ownerId, [output.proofWatermark])).size > 0)
      throw new ForbiddenException('Proof logo is unavailable');
    await this.requireRevision(
      row,
      row.value.captures.find((capture) => capture.id === captureId)!,
      output.revisionId,
    );
    return new ImmichFileResponse({
      path: output.approvalPreviewPath!,
      contentType: 'image/jpeg',
      cacheControl: CacheControl.None,
    });
  }
  async outputFile(
    id: string,
    token: string | undefined,
    captureId: string,
    outputId: string,
  ): Promise<ImmichFileResponse> {
    const { row, recipient } = await this.guest(id, token);
    const output = await this.downloadItem(row, recipient, captureId, outputId);
    const capture = row.value.captures.find((capture) => capture.id === captureId)!;
    return new ImmichFileResponse({
      path: output.finalPath!,
      contentType: 'image/jpeg',
      fileName: `Photo-${capture.number}-${output.key}.jpg`,
      cacheControl: CacheControl.None,
    });
  }
  async file(id: string, token: string | undefined, captureId: string, kind: string): Promise<ImmichFileResponse> {
    const { row, recipient } = await this.guest(id, token);
    const capture = row.value.captures.find((c) => c.id === captureId);
    if (!capture) throw new NotFoundException();
    let file: string;
    if (kind === 'download') file = (await this.downloadItem(row, recipient, captureId)).finalPath!;
    else {
      if (
        !['thumbnail', 'preview'].includes(kind) ||
        !this.proofPermission(recipient, captureId) ||
        !(await this.eligible(row, [captureId], true)).has(captureId)
      )
        throw new ForbiddenException();
      const photo = row.value.published?.photos.find((p) => p.captureId === captureId);
      if (!photo) throw new NotFoundException('Proof is preparing');
      if (photo.revisionId) await this.requireRevision(row, capture, photo.revisionId);
      file = kind === 'thumbnail' ? photo.thumbnailPath : photo.previewPath;
    }
    return new ImmichFileResponse({
      path: file,
      contentType: 'image/jpeg',
      fileName: `Photo-${capture.number}.jpg`,
      cacheControl: CacheControl.None,
    });
  }
  async zip(id: string, token: string | undefined, input: PhotographyZipDto) {
    const dto = PhotographyZipDto.schema.parse(input);
    const { row, recipient } = await this.guest(id, token);
    const requests = dto.outputs ?? dto.captureIds.map((captureId) => ({ captureId, outputId: undefined }));
    const zipId = randomUUID();
    await this.repository.mutate(id, row.ownerId, row.albumId, row.revision, row.value, async (value) => {
      const current = this.requireRecipient({ ...row, value }, recipient.id);
      const entries = [];
      for (const request of requests) {
        const output = await this.downloadItem({ ...row, value }, current, request.captureId, request.outputId);
        entries.push({
          captureId: request.captureId,
          orderId: output.orderId,
          outputId: output.id,
          revisionId: output.revisionId!,
        });
      }
      value.zips = value.zips.filter((zip) => !expired(zip.expiresAt));
      if (value.zips.length >= 2000) throw new ConflictException('Archive request limit reached');
      value.zips.push({
        id: zipId,
        recipientId: recipient.id,
        captureIds: [...new Set(requests.map((request) => request.captureId))],
        entries,
        createdAt: iso(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    });
    return { id: zipId, status: 'ready', url: `/api/photography/galleries/${id}/zip/${zipId}` };
  }
  private zipRequest(row: WorkflowRow, recipient: Recipient, zipId: string) {
    const request = row.value.zips.find(
      (zip) => zip.id === zipId && zip.recipientId === recipient.id && !expired(zip.expiresAt),
    );
    if (!request) throw new NotFoundException('Archive request expired');
    if (!request.entries?.length) throw new ConflictException('Create this archive again to pin its approved outputs');
    return request;
  }
  async archive(id: string, token: string | undefined, zipId: string) {
    const { row, recipient } = await this.guest(id, token);
    const request = this.zipRequest(row, recipient, zipId);
    const files = [];
    for (const entry of request.entries ??
      request.captureIds.map((captureId) => ({ captureId, outputId: undefined }))) {
      const output = await this.downloadItem(
        row,
        recipient,
        entry.captureId,
        entry.outputId,
        'orderId' in entry ? entry : undefined,
      );
      const capture = row.value.captures.find((capture) => capture.id === entry.captureId)!;
      files.push({ file: output.finalPath!, name: `Photo-${capture.number}-${output.key}-${output.id}.jpg` });
    }
    const zip = this.storage.createZipStream();
    for (const file of files) zip.addFile(file.file, file.name);
    void zip.finalize().catch((error) => zip.stream.destroy(error));
    return { stream: zip.stream, disposition: 'attachment; filename="Photographs.zip"', type: 'application/zip' };
  }
  async recordDelivery(id: string, token: string | undefined, captureId?: string, zipId?: string, outputId?: string) {
    const { row, recipient } = await this.guest(id, token);
    const request = captureId ? undefined : this.zipRequest(row, recipient, zipId!);
    const entries = captureId
      ? [{ captureId, outputId }]
      : (request!.entries ?? request!.captureIds.map((captureId) => ({ captureId, outputId: undefined })));
    await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, async (value) => {
      const current = this.requireRecipient({ ...row, value }, recipient.id);
      for (const entry of entries) {
        const delivered = await this.downloadItem(
          { ...row, value },
          current,
          entry.captureId,
          entry.outputId,
          'orderId' in entry ? entry : undefined,
        );
        const order = value.orders.find((order) => order.id === delivered.orderId)!;
        const reference = entry.outputId ? `${entry.captureId}:${delivered.id}` : entry.captureId;
        if (
          value.receipts.every(
            (receipt) =>
              !(receipt.orderId === order.id && receipt.action === 'delivered' && receipt.reference === reference),
          )
        )
          this.receipt(value, order, 'delivered', reference);
        value.captures.find((capture) => capture.id === entry.captureId)!.state = 'delivered';
      }
    });
  }
  private checkoutAvailable(ownerId: string) {
    return (
      process.env.PHOTOGRAPHY_STRIPE_STUDIO_OWNER_ID === ownerId &&
      /^sk_(test|live)_/.test(process.env.PHOTOGRAPHY_STRIPE_SECRET_KEY ?? '') &&
      !!process.env.PHOTOGRAPHY_STRIPE_WEBHOOK_SECRET &&
      /^https:\/\//.test(process.env.PHOTOGRAPHY_CHECKOUT_SUCCESS_URL ?? '') &&
      /^https:\/\//.test(process.env.PHOTOGRAPHY_CHECKOUT_CANCEL_URL ?? '')
    );
  }
  private stripeConfig() {
    const secret = process.env.PHOTOGRAPHY_STRIPE_SECRET_KEY;
    if (!secret || !/^sk_(test|live)_/.test(secret))
      throw new ServiceUnavailableException('Studio hosted checkout is not configured');
    return secret;
  }
  private async stripe(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.stripeConfig()}`, ...options.headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ServiceUnavailableException('Payment provider could not reconcile this order');
    return response.json() as Promise<Record<string, any>>;
  }
  async checkout(id: string, token: string | undefined, orderId: string) {
    const { row, recipient } = await this.guest(id, token);
    const order = row.value.orders.find((o) => o.id === orderId && o.recipientId === recipient.id);
    if (!order || order.status !== 'accepted' || order.total <= 0)
      throw new ConflictException('An accepted unpaid order is required');
    if (
      order.paymentTiming === 'after-approval' &&
      order.items.some((item) => this.outputs(order, item).some((output) => !output.approved || !output.revisionId))
    )
      throw new ConflictException('Awaiting photographer and client approval');
    if (!this.checkoutAvailable(row.ownerId))
      throw new ServiceUnavailableException('No studio-owned checkout account is configured for this photographer');
    if (!recipient.canDownload) throw new ForbiddenException('This recipient cannot purchase downloads');
    await this.selection(row, recipient, order.captureIds, false);
    const success = process.env.PHOTOGRAPHY_CHECKOUT_SUCCESS_URL;
    const cancel = process.env.PHOTOGRAPHY_CHECKOUT_CANCEL_URL;
    if (!success || !cancel || !/^https:\/\//.test(success) || !/^https:\/\//.test(cancel))
      throw new ServiceUnavailableException('Hosted checkout return URLs are not configured');
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: success,
      cancel_url: cancel,
      client_reference_id: order.id,
      'metadata[orderId]': order.id,
      'payment_intent_data[metadata][orderId]': order.id,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': order.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(order.total),
      'line_items[0][price_data][product_data][name]': 'Digital photograph order',
    });
    const session = await this.stripe('checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `photography-${order.id}` },
      body: form,
    });
    if (
      typeof session.id !== 'string' ||
      typeof session.url !== 'string' ||
      !session.url.startsWith('https://checkout.stripe.com/')
    )
      throw new ServiceUnavailableException('Invalid hosted checkout response');
    await this.repository.mutate(id, row.ownerId, row.albumId, undefined, row.value, (value) => {
      const currentRecipient = this.requireRecipient({ ...row, value }, recipient.id);
      const current = value.orders.find((o) => o.id === orderId && o.recipientId === currentRecipient.id);
      if (!current || current.status !== 'accepted') throw new ConflictException('Order changed during checkout');
      if (current.checkoutId && current.checkoutId !== session.id)
        throw new ConflictException('Checkout identity changed');
      current.checkoutId = session.id;
    });
    return { url: session.url };
  }
  async callback(raw: Buffer, signature: string | undefined) {
    const secret = process.env.PHOTOGRAPHY_STRIPE_WEBHOOK_SECRET;
    if (!secret || !signature || !verifyStripeSignature(raw, signature, secret))
      throw new ForbiddenException('Invalid payment callback');
    let event: { id: string; type: string; data: { object: Record<string, any> } };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid payment event');
    }
    if (
      !event.id ||
      !event.data?.object ||
      ![
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
        'checkout.session.expired',
        'charge.refunded',
        'charge.dispute.created',
      ].includes(event.type)
    )
      return { received: true };
    const object = event.data.object;
    let orderId = object.client_reference_id ?? object.metadata?.orderId;
    if (!orderId && typeof object.payment_intent === 'string') {
      const intent = await this.stripe(`payment_intents/${encodeURIComponent(object.payment_intent)}`);
      orderId = intent.metadata?.orderId;
    }
    if (typeof orderId !== 'string' || !/^[a-f0-9-]{36}$/.test(orderId))
      throw new BadRequestException('Unbound payment event');
    const row = await this.repository.paymentOrder(orderId);
    if (!row) throw new NotFoundException('Order unavailable');
    if (process.env.PHOTOGRAPHY_STRIPE_STUDIO_OWNER_ID !== row.ownerId)
      throw new ForbiddenException('Callback studio ownership mismatch');
    const order = row.value.orders.find((o) => o.id === orderId)!;
    if (!order.checkoutId) throw new ConflictException('Checkout has not been recorded; retry callback');
    if (row.value.receipts.some((receipt) => receipt.reference === event.id)) return { received: true };
    const session = await this.stripe(
      `checkout/sessions/${encodeURIComponent(order.checkoutId)}?expand[]=payment_intent.latest_charge`,
    );
    if (
      session.id !== order.checkoutId ||
      session.client_reference_id !== order.id ||
      session.amount_total !== order.total ||
      session.currency?.toUpperCase() !== order.currency
    )
      throw new ForbiddenException('Provider order amount or currency mismatch');
    const intent = session.payment_intent;
    const charge = typeof intent === 'object' ? intent.latest_charge : null;
    const refund =
      charge && (charge.refunded === true || Number(charge.amount_refunded) > 0 || charge.disputed === true);
    const state = refund
      ? 'refunded'
      : session.payment_status === 'paid' && intent?.status === 'succeeded'
        ? 'settled'
        : session.status === 'expired'
          ? 'cancelled'
          : null;
    await this.repository.mutate(row.id, row.ownerId, row.albumId, undefined, row.value, (value) => {
      if (value.receipts.some((receipt) => receipt.reference === event.id)) return;
      const current = value.orders.find((o) => o.id === orderId)!;
      if (current.checkoutId !== order.checkoutId) throw new ConflictException('Checkout identity changed');
      if (state && current.status !== 'refunded' && current.status !== 'cancelled') {
        current.status = state;
        current.paymentIntentId = typeof intent === 'object' ? intent.id : (intent ?? null);
      }
      this.receipt(value, current, `provider:${state ?? 'pending'}`, event.id);
    });
    return { received: true };
  }
  async galleryLogo(id: string, token: string | undefined) {
    const { row } = await this.guest(id, token);
    const p = row.value.published;
    if (!p?.logoPath || !p.brand.logoAssetId || !(await this.repository.logo(row.ownerId, p.brand.logoAssetId))[0])
      throw new NotFoundException();
    return new ImmichFileResponse({ path: p.logoPath, contentType: 'image/png', cacheControl: CacheControl.None });
  }
  private studioSession(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) throw new ForbiddenException('Studio session required');
    return auth.user.id;
  }
  async site(auth: AuthDto) {
    const ownerId = this.studioSession(auth);
    const stored = await this.repository.site(ownerId);
    return {
      revision: stored?.revision ?? null,
      site: stored?.value ?? {
        presentation: { layout: 'editorial', spacing: 'comfortable', font: 'editorial', palette: 'studio' },
        enabled: false,
        title: auth.user.name,
        about: '',
        services: '',
        contact: '',
        portfolio: [],
      },
      url: `/studio/${ownerId}`,
    };
  }
  private async portfolio(ownerId: string, shootId: string, captureId: string) {
    const row = await this.repository.get(shootId);
    if (!row || row.ownerId !== ownerId) throw new NotFoundException();
    await this.repository.live(row);
    if (expired(row.value.config.expiresAt) || !(await this.eligible(row, [captureId], true)).has(captureId))
      throw new NotFoundException();
    const photo = row.value.published?.photos.find((p) => p.captureId === captureId);
    const capture = row.value.captures.find((c) => c.id === captureId);
    if (!photo?.revisionId || !capture?.approvedRevisionId || photo.revisionId !== capture.approvedRevisionId)
      throw new NotFoundException('Publish an approved web photograph first');
    await this.requireRevision(row, capture, photo.revisionId);
    return { row, photo };
  }
  async saveSite(auth: AuthDto, input: PhotographySiteSaveDto) {
    const ownerId = this.studioSession(auth);
    const dto = PhotographySiteSaveDto.schema.parse(input);
    if (new Set(dto.site.portfolio.map((p) => `${p.shootId}:${p.captureId}`)).size !== dto.site.portfolio.length)
      throw new BadRequestException('Duplicate portfolio photographs');
    for (const item of dto.site.portfolio) await this.portfolio(ownerId, item.shootId, item.captureId);
    return this.repository.saveSite(ownerId, dto.expectedRevision, dto.site);
  }
  async publicSite(ownerId: string) {
    await this.repository.studioLive(ownerId);
    const site = await this.repository.site(ownerId);
    if (!site?.value?.enabled) throw new NotFoundException();
    const portfolio: { shootId: string; captureId: string; url: string }[] = [];
    for (const item of site.value.portfolio) {
      try {
        await this.portfolio(ownerId, item.shootId, item.captureId);
      } catch (error) {
        if (error instanceof NotFoundException || error instanceof ForbiddenException) continue;
        throw error;
      }
      portfolio.push({
        shootId: item.shootId,
        captureId: item.captureId,
        url: `/api/photography/studios/${ownerId}/photos/${item.shootId}/${item.captureId}`,
      });
    }
    const brand = (await this.workspace.get(ownerId))?.value.brand;
    const eligibleLogo = brand?.logoAssetId && (await this.repository.logo(ownerId, brand.logoAssetId))[0];
    return {
      ...site.value,
      portfolio,
      brand: brand
        ? {
            name: brand.name,
            tagline: brand.tagline,
            email: brand.email,
            phone: brand.phone,
            color: brand.color,
            background: brand.background,
            textColor: brand.textColor,
            font: brand.font,
            logoUrl: eligibleLogo ? `/api/photography/studios/${ownerId}/logo` : null,
          }
        : {
            name: site.value.title,
            tagline: '',
            email: '',
            phone: '',
            color: '#577059',
            background: '#f5f3ed',
            textColor: '#263329',
            font: 'editorial',
            logoUrl: null,
          },
    };
  }
  async publicPhoto(ownerId: string, shootId: string, captureId: string) {
    const site = await this.repository.site(ownerId);
    if (
      !site?.value?.enabled ||
      site.value.portfolio.every((p) => !(p.shootId === shootId && p.captureId === captureId && p.consent))
    )
      throw new NotFoundException();
    const { photo } = await this.portfolio(ownerId, shootId, captureId);
    return new ImmichFileResponse({
      path: photo.previewPath,
      contentType: 'image/jpeg',
      cacheControl: CacheControl.None,
    });
  }
  async publicLogo(ownerId: string) {
    await this.repository.studioLive(ownerId);
    if (!(await this.repository.site(ownerId))?.value?.enabled) throw new NotFoundException();
    const brand = (await this.workspace.get(ownerId))?.value.brand;
    const asset = brand?.logoAssetId && (await this.repository.logo(ownerId, brand.logoAssetId))[0];
    if (!asset) throw new NotFoundException();
    return (await preparePhotographyLogo(await this.logoBytes(asset.originalPath))).original;
  }
}
