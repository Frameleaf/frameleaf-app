import { BadRequestException } from '@nestjs/common';
import {
  AssetDevelopMaskKind,
  type AssetDevelopRecipe,
  AssetDevelopRecipeSchema,
  AssetDevelopRevisionStatus,
  DarktableDevelopRecipeSchema,
  HdrAssetDevelopRecipeSchema,
  type KnownAssetDevelopRecipe,
  KnownAssetDevelopRecipeSchema,
} from 'src/dtos/asset-develop.dto.js';

/** Route only explicitly supported native recipes; opaque future/imported recipes remain saveable. */
export function assertRenderableDevelopRecipe(value: unknown) {
  const envelope = developEnvelope(value);
  if (envelope.version === 3 || envelope.version === 4) return renderHdrDevelopProjection(envelope);
  if (envelope.version !== 2) {
    return renderDevelopProjection(envelope);
  }
  const parsed = DarktableDevelopRecipeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new BadRequestException({
      message: 'This native recipe contains unsupported render fields',
      code: 'develop_renderer_unsupported',
    });
  }
  return parsed.data;
}

/** Validate/clone JSON before storage or response; never project away opaque content. */
export function developEnvelope(value: unknown): AssetDevelopRecipe {
  const parsed = AssetDevelopRecipeSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid or oversized develop recipe');
  return JSON.parse(JSON.stringify(parsed.data));
}

/** A named source is explicit. Objects preserve omissions; arrays are complete replacements.
 * Matching mask IDs preserve nested opaque properties, while omitted IDs are deliberate removals.
 */
export function preserveDevelopEnvelope(source: AssetDevelopRecipe, incoming: AssetDevelopRecipe): AssetDevelopRecipe {
  if (source.version !== incoming.version)
    throw new BadRequestException('Preserving a recipe requires the same contract version');
  const merge = (base: unknown, next: unknown): unknown => {
    if (
      !base ||
      !next ||
      typeof base !== 'object' ||
      typeof next !== 'object' ||
      Array.isArray(base) ||
      Array.isArray(next)
    )
      return next;
    const result = { ...base } as Record<string, unknown>;
    for (const [key, value] of Object.entries(next)) result[key] = merge(result[key], value);
    return result;
  };
  const result = merge(source, incoming) as AssetDevelopRecipe;
  if (Array.isArray(incoming.masks) && Array.isArray(source.masks)) {
    const sourceMasks = source.masks as Record<string, unknown>[];
    const incomingMasks = incoming.masks as Record<string, unknown>[];
    if ([1, 3, 4].includes(source.version)) {
      for (const masks of [sourceMasks, incomingMasks]) {
        const ids = masks.map((mask) => (mask && typeof mask.id === 'string' ? mask.id.trim() : undefined));
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
          throw new BadRequestException(
            'Preserving masks requires unique stable identifiers; explicitly replace ambiguous arrays',
          );
      }
    }
    result.masks = incoming.masks.map((mask) => {
      if (!mask || typeof mask !== 'object' || Array.isArray(mask)) return mask;
      const old = (source.masks as unknown[]).find(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).id === 'string' &&
          ((item as Record<string, unknown>).id as string).trim() ===
            (typeof (mask as Record<string, unknown>).id === 'string'
              ? ((mask as Record<string, unknown>).id as string).trim()
              : undefined),
      );
      return merge(old, mask);
    });
    if ([1, 3, 4].includes(source.version)) {
      const ids = new Set(incomingMasks.map((mask) => (mask.id as string).trim()));
      for (const mask of sourceMasks) {
        if (
          !Object.values(AssetDevelopMaskKind).includes(mask.kind as AssetDevelopMaskKind) &&
          !ids.has((mask.id as string).trim())
        ) {
          (result.masks as unknown[]).push(mask);
        }
      }
    }
  }
  return developEnvelope(result);
}

/** Fail closed on any unknown render semantics, including nested mask keys/kinds. */
export function renderDevelopProjection(value: unknown): KnownAssetDevelopRecipe {
  const envelope = developEnvelope(value);
  const parsed = KnownAssetDevelopRecipeSchema.safeParse(envelope);
  if (!parsed.success)
    throw new BadRequestException({
      message: 'This recipe requires a newer renderer',
      code: 'develop_renderer_unsupported',
    });
  const unknownKeys = (input: unknown, known: unknown): boolean => {
    if (Array.isArray(input))
      return !Array.isArray(known) || input.some((item, index) => unknownKeys(item, known[index]));
    if (input && typeof input === 'object') {
      if (!known || typeof known !== 'object') return true;
      return Object.entries(input).some(
        ([key, item]) => !Object.hasOwn(known, key) || unknownKeys(item, (known as Record<string, unknown>)[key]),
      );
    }
    return false;
  };
  if (unknownKeys(envelope, parsed.data))
    throw new BadRequestException({
      message: 'This recipe contains unsupported render fields',
      code: 'develop_renderer_unsupported',
    });
  return parsed.data;
}

/** Validate the HDR policy, then reuse the existing adjustment shape without accepting unknown semantics. */
export function renderHdrDevelopProjection(value: unknown) {
  const envelope = developEnvelope(value);
  const parsed = HdrAssetDevelopRecipeSchema.safeParse(envelope);
  if (!parsed.success)
    throw new BadRequestException({
      message: 'This HDR recipe requires a supported preservation policy and renderer',
      code: 'develop_renderer_unsupported',
    });
  const { version: _version, renderer: _renderer, hdr: _hdr, ...fields } = envelope;
  renderDevelopProjection({ ...fields, version: 1 });
  return parsed.data;
}

/** A failed or cancelled HDR regeneration retains the previously accepted four-file set. */
export function hasPublishedDevelopRendition(revision: {
  status: AssetDevelopRevisionStatus;
  masterPath: string | null;
  previewPath: string | null;
  hdrMasterPath?: string | null;
  hdrPreviewPath?: string | null;
  hdrRenditionChecksum?: Buffer | null;
  renderedAt?: Date | null;
}) {
  return (
    revision.status === AssetDevelopRevisionStatus.Rendered ||
    !!(
      revision.masterPath &&
      revision.previewPath &&
      revision.hdrMasterPath &&
      revision.hdrPreviewPath &&
      revision.hdrRenditionChecksum?.length === 32 &&
      revision.renderedAt
    )
  );
}
