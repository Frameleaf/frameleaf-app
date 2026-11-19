import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { DesktopQualificationRequestSchema } from 'src/dtos/desktop-qualification.dto.js';
import { MlWorkload } from 'src/enum.js';

export const DesktopModelInventoryRequestSchema = DesktopQualificationRequestSchema.pick({
  provider: true,
  runtimeSourceRevision: true,
}).extend({
  // 2: the reply also carries each eligible task's catalogue profiles, so the desktop runs exactly the
  // server's catalogue and keeps no copy of its own (docs/desktop-worker-setup-protocol.md in frameleaf-desktop).
  // 1, or nothing, asks for the protocol 1 reply.
  protocolVersion: z.union([z.literal(1), z.literal(2)]).optional(),
});
export const desktopInventoryWorkloads = [
  MlWorkload.Clip,
  MlWorkload.Ocr,
  MlWorkload.Face,
  MlWorkload.Enrichment,
] as const;
const entry = z
  .strictObject({
    workload: z.enum(desktopInventoryWorkloads).meta({ id: 'DesktopLibraryWorkload' }),
    state: z
      .enum(['eligible', 'disabled', 'pinned', 'legacy', 'unavailable', 'unsupported'])
      .meta({ id: 'DesktopModelAvailability' }),
    modelNames: z.array(z.string().min(1).max(512)).max(8),
    modelKeys: z.array(z.string().regex(/^(clip|ocr|face):[a-f0-9]{64}$/)).max(8),
    /** Protocol 2: the catalogue profile of each model key, in the same order, exactly as the server ships it. */
    profiles: z.array(z.record(z.string(), z.unknown())).max(8).optional(),
  })
  .refine((value) =>
    value.state === 'eligible'
      ? value.workload !== MlWorkload.Enrichment &&
        value.modelKeys.length === (value.workload === MlWorkload.Clip ? 3 : 1) &&
        new Set(value.modelKeys).size === value.modelKeys.length &&
        value.modelKeys.every((key) => key.startsWith(value.workload + ':'))
      : value.modelKeys.length === 0,
  )
  .refine(
    (value) =>
      !value.profiles ||
      (value.profiles.length === value.modelKeys.length &&
        value.profiles.every((profile, index) => profile.modelKey === value.modelKeys[index])),
  );
export type DesktopModelAvailability = z.infer<typeof entry>;
export class DesktopModelInventoryDto extends createZodDto(
  z.strictObject({
    protocolVersion: z.number().int().min(1).max(2),
    provider: DesktopModelInventoryRequestSchema.shape.provider,
    runtimeSourceRevision: DesktopModelInventoryRequestSchema.shape.runtimeSourceRevision,
    workloads: z
      .array(entry)
      .length(4)
      .refine((items) => new Set(items.map((item) => item.workload)).size === 4),
  }),
) {}
