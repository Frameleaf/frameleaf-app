import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { DesktopQualificationRequestSchema } from 'src/dtos/desktop-qualification.dto.js';
import { MlWorkload } from 'src/enum.js';

export const DesktopModelInventoryRequestSchema = DesktopQualificationRequestSchema.pick({
  provider: true,
  runtimeSourceRevision: true,
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
  })
  .refine((value) =>
    value.state === 'eligible'
      ? value.workload !== MlWorkload.Enrichment &&
        value.modelKeys.length === (value.workload === MlWorkload.Clip ? 3 : 1) &&
        new Set(value.modelKeys).size === value.modelKeys.length &&
        value.modelKeys.every((key) => key.startsWith(value.workload + ':'))
      : value.modelKeys.length === 0,
  );
export type DesktopModelAvailability = z.infer<typeof entry>;
export class DesktopModelInventoryDto extends createZodDto(
  z.strictObject({
    protocolVersion: z.number().int().min(1).max(1),
    ...DesktopModelInventoryRequestSchema.shape,
    workloads: z
      .array(entry)
      .length(4)
      .refine((items) => new Set(items.map((item) => item.workload)).size === 4),
  }),
) {}
