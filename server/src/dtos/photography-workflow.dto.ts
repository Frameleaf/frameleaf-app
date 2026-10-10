import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PhotographyWatermarkSchema } from 'src/dtos/photography-rendition.dto.js';

const blockedReasons = ['permission', 'order', 'payment', 'approval', 'render'] as const;
// Keep runtime null validation while avoiding a null member in generated TypeScript string enums.
const BlockedReason = z
  .enum(blockedReasons)
  .nullable()
  .meta({ type: 'string', enum: [...blockedReasons], nullable: true, anyOf: undefined });
const Id = z.uuidv4();
const Revision = z.uuid().nullable();
const Instant = z.iso.datetime({ offset: true }).nullable();
const Money = z.int().min(0).max(100_000_000);
const Ids = z
  .array(Id)
  .max(10_000)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate IDs');
export const PhotographyDownloadOutputSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['print', 'web', 'social']),
    maxEdge: z.int().min(320).max(65_535),
    watermark: PhotographyWatermarkSchema.nullable(),
  })
  .refine(
    (output) => (output.kind === 'print' ? output.maxEdge === 65_535 : output.maxEdge <= 4096),
    'Output size does not match its kind',
  );
export const PhotographyConfigSchema = z.strictObject({
  presentation: z.strictObject({
    template: z.enum(['wedding', 'portrait', 'fine-art', 'proofing']),
    coverCaptureId: Id.nullable(),
    coverTreatment: z.enum(['full', 'split', 'quiet']),
    coverFocal: z.number().min(0).max(100),
    font: z.enum(['editorial', 'modern', 'script']),
    palette: z.enum(['studio', 'ivory', 'charcoal']),
    spacing: z.enum(['compact', 'comfortable', 'airy']),
    introduction: z.string().max(5000),
    showChapters: z.boolean(),
    showNumbers: z.boolean(),
    blocks: z
      .array(
        z.strictObject({
          id: Id,
          type: z.enum(['chapter', 'grid', 'full', 'pair', 'caption', 'slideshow']),
          chapterId: Id.nullable(),
          selection: z.enum(['automatic', 'explicit']).optional(),
          captureIds: Ids.max(1000),
          text: z.string().max(2000),
        }),
      )
      .max(100)
      .refine((blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length, 'Duplicate block ID')
      .optional(),
  }),
  title: z.string().trim().min(1).max(200),
  mode: z.enum(['edited-delivery', 'select-before-editing', 'sell-by-photo']),
  paymentTiming: z.enum(['before-editing', 'after-approval']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  includedCount: z.int().min(0).max(10_000),
  additionalPrice: Money,
  collectionPrice: Money.nullable(),
  bundles: z.array(z.strictObject({ count: z.int().min(1).max(10_000), price: Money })).max(20),
  terms: z.string().max(5000),
  selectionDeadline: Instant,
  expiresAt: Instant,
  turnaroundDays: z.int().min(0).max(365),
  proofWatermark: PhotographyWatermarkSchema,
  webWatermark: PhotographyWatermarkSchema.nullable(),
  downloadWatermark: PhotographyWatermarkSchema.nullable(),
  downloadOutputs: z
    .array(PhotographyDownloadOutputSchema)
    .min(1)
    .max(6)
    .refine((outputs) => new Set(outputs.map((output) => output.key)).size === outputs.length, 'Duplicate output key')
    .optional(),
});
export type PhotographyConfig = z.infer<typeof PhotographyConfigSchema>;
export const PhotographyChapterSchema = z.strictObject({
  id: Id,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
  position: z.int().min(0).max(10_000),
  coverCaptureId: Id.nullable(),
});
export type PhotographyChapter = z.infer<typeof PhotographyChapterSchema>;
export class PhotographyWorkflowMutationDto extends createZodDto(z.strictObject({ expectedRevision: Revision })) {}
export class PhotographyIntakeDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, expandCaptureIds: Ids.default([]) }),
) {}
export class PhotographyPresetSaveDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    id: Id.nullable(),
    name: z.string().trim().min(1).max(200),
    config: PhotographyConfigSchema,
  }),
) {}
export class PhotographyWorkflowConfigDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, config: PhotographyConfigSchema }),
) {}
export class PhotographyAssemblyDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    chapters: z.array(PhotographyChapterSchema).max(200),
    ordering: z.enum(['chronological', 'photographer', 'manual', 'chapters']),
    captures: z
      .array(
        z.strictObject({
          id: Id,
          chapterId: Id.nullable(),
          position: z.int().min(0).max(10_000),
          offsetSeconds: z.int().min(-86_400).max(86_400),
          photographer: z.string().max(200),
          withheld: z.boolean(),
        }),
      )
      .max(10_000),
  }),
) {}
const RecipientRights = {
  expiresAt: Instant,
  canProof: z.boolean(),
  canDownload: z.boolean(),
  captureIds: Ids.nullable(),
};
export class PhotographyRecipientCreateDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    name: z.string().trim().min(1).max(200),
    password: z.string().min(8).max(72).nullable(),
    ...RecipientRights,
  }),
) {}
export class PhotographyRecipientUpdateDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, revoked: z.boolean(), ...RecipientRights }),
) {}
export const PhotographyOutputDefinitionSchema = PhotographyDownloadOutputSchema.safeExtend({
  revisions: z
    .array(z.strictObject({ captureId: Id, revisionId: Id }))
    .max(10_000)
    .refine((items) => new Set(items.map((item) => item.captureId)).size === items.length, 'Duplicate revision mapping')
    .default([]),
});
export type PhotographyOutputDefinition = z.infer<typeof PhotographyOutputDefinitionSchema>;
export const PhotographyStudioPresetSchema = z.object({ id: Id, name: z.string(), config: PhotographyConfigSchema });
export type PhotographyStudioPreset = z.infer<typeof PhotographyStudioPresetSchema>;
export class PhotographyStudioPresetsDto extends createZodDto(
  z.object({ revision: Revision, presets: z.array(PhotographyStudioPresetSchema) }),
) {}
export class PhotographyStudioPresetApplyDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, expectedPresetRevision: Id }),
) {}
export class PhotographyOrderCreateDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    roundId: Id.nullable().default(null),
    captureIds: Ids.optional(),
    recipientId: Id,
    pricing: z.enum(['package', 'collection', 'bundle']),
    bundleCount: z.int().min(1).max(10_000).optional(),
    outputs: z
      .array(PhotographyOutputDefinitionSchema)
      .min(1)
      .max(6)
      .refine((outputs) => new Set(outputs.map((output) => output.key)).size === outputs.length, 'Duplicate output key')
      .optional(),
  }),
) {}
export class PhotographyPaymentDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    action: z.enum(['settle', 'refund', 'cancel']),
    reference: z.string().trim().min(1).max(200),
  }),
) {}
export class PhotographyApprovalDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, captureId: Id, revisionId: Id, requestClientApproval: z.boolean() }),
) {}
export class PhotographyPublicationDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, scope: z.enum(['all-eligible', 'selected']) }),
) {}
export class PhotographyGallerySessionDto extends createZodDto(
  z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().max(72).optional() }),
) {}
export class PhotographyChoicesDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    captureIds: Ids,
    notes: z
      .array(
        z.strictObject({
          captureId: Id,
          text: z.string().trim().max(2000),
          annotations: z
            .array(
              z
                .strictObject({
                  x: z.number().min(0).max(1),
                  y: z.number().min(0).max(1),
                  width: z.number().min(0).max(1),
                  height: z.number().min(0).max(1),
                  text: z.string().max(500),
                })
                .refine((a) => a.x + a.width <= 1 && a.y + a.height <= 1, 'Annotation must fit the photograph'),
            )
            .max(20)
            .optional(),
        }),
      )
      .max(10_000),
  }),
) {}
export class PhotographyGuestApprovalDto extends createZodDto(
  z.strictObject({
    expectedRevision: Revision,
    captureId: Id,
    revisionId: Id,
    approved: z.boolean(),
    note: z.string().max(2000),
  }),
) {}
export class PhotographyZipDto extends createZodDto(
  z
    .strictObject({
      captureIds: Ids.max(1000).default([]),
      outputs: z
        .array(z.strictObject({ captureId: Id, outputId: Id }))
        .min(1)
        .max(1000)
        .refine(
          (entries) => new Set(entries.map((entry) => entry.outputId)).size === entries.length,
          'Duplicate output ID',
        )
        .optional(),
    })
    .refine(
      (dto) => (dto.outputs ? dto.captureIds.length === 0 : dto.captureIds.length > 0),
      'Choose photographs or outputs',
    ),
) {}
const NoteSchema = PhotographyChoicesDto.schema.shape.notes.element;
const RoundSchema = z.object({
  id: Id,
  recipientId: Id,
  number: z.int(),
  captureIds: Ids,
  notes: z.array(NoteSchema),
  createdAt: z.string(),
});
const PublicationSchema = z
  .object({
    id: Id,
    status: z.enum(['queued', 'rendering', 'ready', 'failed']),
    completed: z.int(),
    total: z.int(),
    error: z.string().nullable(),
    failedCaptureId: Id.nullable(),
  })
  .nullable();
const ExportSpecSchema = z.object({
  format: z.literal('jpeg'),
  quality: z.literal(90),
  maxEdge: z.int().min(320).max(65_535),
});
const OutputViewSchema = z.object({
  id: Id,
  label: z.string(),
  kind: z.enum(['print', 'web', 'social']),
  revisionId: Id.nullable(),
  approved: z.boolean(),
  clientApprovalRequired: z.boolean(),
  ready: z.boolean(),
  renderStatus: z.enum(['awaiting-approval', 'preparing', 'ready']),
  branded: z.boolean(),
  approvalPreviewUrl: z.string().nullable(),
  exportSpec: ExportSpecSchema,
  url: z.string(),
  canDownload: z.boolean().optional(),
  blockedReason: BlockedReason.optional(),
});
const OrderSchema = z.object({
  id: Id,
  recipientId: Id,
  roundId: Id.nullable(),
  status: z.enum(['quoted', 'accepted', 'settled', 'free', 'refunded', 'cancelled']),
  currency: z.string(),
  total: Money,
  captureIds: Ids,
  terms: z.string(),
  paymentTiming: PhotographyConfigSchema.shape.paymentTiming,
  pricing: z.object({
    includedCount: z.int(),
    additionalPrice: Money,
    collectionPrice: Money.nullable(),
    bundles: PhotographyConfigSchema.shape.bundles,
    option: z.string(),
  }),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  items: z.array(
    z.object({
      captureId: Id,
      revisionId: Id.nullable(),
      approved: z.boolean(),
      clientApprovalRequired: z.boolean(),
      ready: z.boolean(),
      exportSpec: ExportSpecSchema,
      outputs: z.array(OutputViewSchema),
    }),
  ),
  readyCount: z.int(),
  editingBlocked: z.boolean(),
});
const ReceiptSchema = z.object({
  id: Id,
  orderId: Id.nullable(),
  recipientId: Id,
  action: z.string(),
  reference: z.string(),
  createdAt: z.string(),
});
const ApprovalSchema = z.object({
  recipientId: Id,
  captureId: Id,
  revisionId: Id,
  approved: z.boolean(),
  note: z.string(),
  createdAt: z.string(),
});
const PublicBrandSchema = z.object({
  name: z.string(),
  tagline: z.string(),
  email: z.string(),
  phone: z.string(),
  color: z.string(),
  background: z.string(),
  textColor: z.string(),
  font: z.string(),
  logoUrl: z.string().nullable(),
});
export const PhotographyWorkflowViewSchema = z.object({
  revision: Revision,
  shootId: Id,
  config: PhotographyConfigSchema,
  presets: z.array(z.object({ id: Id, name: z.string(), config: PhotographyConfigSchema })),
  studioPresets: PhotographyStudioPresetsDto.schema,
  pendingEdits: z.int().min(0),
  approvedVersions: z.array(z.object({ captureId: Id, revisionId: Id, approvedAt: z.string() })),
  ordering: PhotographyAssemblyDto.schema.shape.ordering,
  captures: z.array(
    z.object({
      id: Id,
      number: z.int(),
      assetId: Id.nullable(),
      assetIds: Ids,
      checksum: z.string().nullable(),
      fileName: z.string().nullable(),
      camera: z.string().nullable(),
      capturedAt: z.string().nullable(),
      offsetSeconds: z.int(),
      photographer: z.string(),
      chapterId: Id.nullable(),
      position: z.int(),
      withheld: z.boolean(),
      rating: z.int().nullable(),
      isRaw: z.boolean().nullable(),
      eligible: z.boolean(),
      exclusion: z.string().nullable(),
      processing: z.enum(['ready', 'pending', 'failed']),
      proofRevisionId: Id.nullable(),
      approvedRevisionId: Id.nullable(),
      approvalRequested: z.boolean(),
      state: z.enum(['imported', 'selected', 'approval-requested', 'approved', 'delivered']),
    }),
  ),
  chapters: z.array(PhotographyChapterSchema),
  recipients: z.array(
    z.object({
      id: Id,
      name: z.string(),
      revoked: z.boolean(),
      expiresAt: Instant,
      canProof: z.boolean(),
      canDownload: z.boolean(),
      captureIds: Ids.nullable(),
      choices: Ids,
      notes: z.array(NoteSchema),
      passwordProtected: z.boolean(),
    }),
  ),
  rounds: z.array(RoundSchema),
  orders: z.array(OrderSchema),
  publication: PublicationSchema,
  receipts: z.array(ReceiptSchema),
  approvals: z.array(ApprovalSchema),
});
export class PhotographyWorkflowDto extends createZodDto(PhotographyWorkflowViewSchema) {}
export class PhotographyInvitationDto extends createZodDto(
  z.object({ workflow: PhotographyWorkflowViewSchema, invitation: z.object({ recipientId: Id, token: z.string() }) }),
) {}
export class PhotographyGallerySessionResponseDto extends createZodDto(
  z.object({ session: z.string(), expiresAt: z.string(), recipientId: Id }),
) {}
export class PhotographyGalleryDto extends createZodDto(
  z.object({
    revision: Revision,
    title: z.string(),
    mode: PhotographyConfigSchema.shape.mode,
    presentation: PhotographyConfigSchema.shape.presentation,
    brand: PublicBrandSchema,
    checkoutAvailable: z.boolean(),
    publishedGenerationId: Id.nullable(),
    chapters: z.array(PhotographyChapterSchema),
    recipient: z.object({ id: Id, name: z.string(), canDownload: z.boolean() }),
    choices: Ids,
    notes: z.array(NoteSchema),
    receipts: z.array(ReceiptSchema),
    rounds: z.array(RoundSchema),
    orders: z.array(OrderSchema),
    publication: PublicationSchema,
    photos: z.array(
      z.object({
        id: Id,
        number: z.int(),
        chapterId: Id.nullable(),
        status: z.enum(['imported', 'selected', 'approval-requested', 'approved', 'delivered']),
        previewUrl: z.string(),
        thumbnailUrl: z.string(),
        canDownload: z.boolean(),
        blockedReason: BlockedReason,
        approvalRevisionId: Id.nullable(),
        outputs: z.array(OutputViewSchema),
      }),
    ),
    pricing: z.object({
      currency: z.string(),
      includedCount: z.int(),
      additionalPrice: Money,
      collectionPrice: Money.nullable(),
      bundles: PhotographyConfigSchema.shape.bundles,
      terms: z.string(),
      selectionDeadline: Instant,
    }),
  }),
) {}
export class PhotographyCheckoutDto extends createZodDto(z.object({ url: z.string() })) {}
export class PhotographyZipResponseDto extends createZodDto(
  z.object({ id: Id, status: z.literal('ready'), url: z.string() }),
) {}
export class PhotographyCallbackDto extends createZodDto(z.object({ received: z.boolean() })) {}

export class PhotographyOrderAcceptDto extends createZodDto(z.strictObject({ expectedRevision: Revision })) {}
export const PhotographySiteSchema = z.strictObject({
  presentation: z
    .strictObject({
      layout: z.enum(['editorial', 'grid', 'slideshow']),
      spacing: z.enum(['compact', 'comfortable', 'airy']),
      font: z.enum(['editorial', 'modern', 'script']),
      palette: z.enum(['studio', 'ivory', 'charcoal']),
    })
    .default({ layout: 'editorial', spacing: 'comfortable', font: 'editorial', palette: 'studio' }),
  enabled: z.boolean(),
  title: z.string().trim().min(1).max(200),
  about: z.string().max(10_000),
  services: z.string().max(10_000),
  contact: z.string().max(5000),
  portfolio: z.array(z.strictObject({ shootId: Id, captureId: Id, consent: z.literal(true) })).max(200),
});
export type PhotographySite = z.infer<typeof PhotographySiteSchema>;
export class PhotographySiteSaveDto extends createZodDto(
  z.strictObject({ expectedRevision: Revision, site: PhotographySiteSchema }),
) {}

export class PhotographySiteDto extends createZodDto(
  z.object({ revision: Revision, site: PhotographySiteSchema, url: z.string().optional() }),
) {}
export class PhotographyPublicSiteDto extends createZodDto(
  PhotographySiteSchema.omit({ portfolio: true }).extend({
    portfolio: z.array(z.object({ shootId: Id, captureId: Id, url: z.string() })),
    brand: PublicBrandSchema,
  }),
) {}

export class PhotographyWorkflowListDto extends createZodDto(
  z.object({
    galleries: z.array(
      z.object({
        shootId: Id,
        revision: Revision,
        title: z.string(),
        mode: z.string(),
        selectionDeadline: Instant,
        expiresAt: Instant,
        published: z.boolean(),
        submittedRounds: z.int(),
        unpaidOrders: z.int(),
        readyCount: z.int(),
        pendingEdits: z.int(),
      }),
    ),
  }),
) {}
