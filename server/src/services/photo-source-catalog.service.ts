import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  type PhotoSourceCatalogField,
  type PhotoSourceCatalogItem,
  type PhotoSourceCatalogItemStatus,
  PhotoSourceCatalogMetadataDto,
  PhotoSourceCatalogMetadataResponseDto,
} from 'src/dtos/photo-source.dto.js';
import { AlbumKind, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CATALOG_METADATA_KEY,
  type CatalogTarget,
  PhotoSourceRepository,
} from 'src/repositories/photo-source.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { photoSourceAuthority } from 'src/services/photo-source.service.js';
import { TagService } from 'src/services/tag.service.js';
import { checkAccess } from 'src/utils/access.js';

/** What a catalog read-in last wrote to an item: the `frameleaf.catalog` asset metadata value. */
export type CatalogApplied = {
  /** -1 (rejected), 0 (unrated) or 1–5 */
  rating?: number;
  description?: string;
  /** Tag values (`a/b/c`) added at some read-in; never added again once the person removes one. */
  tags?: string[];
  /** Collection paths (sets outermost first, then the collection's name) whose album the item was added to. */
  collections?: string[][];
};

export const CATALOG_COLOUR_LABEL_TAG = 'Colour label';
export const CATALOG_PICK_TAG = 'Flag/Pick';

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

/** Read back a stored record, ignoring anything that is not what this service writes. */
export const parseCatalogApplied = (value: unknown): CatalogApplied => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const rating =
    typeof record.rating === 'number' &&
    Number.isSafeInteger(record.rating) &&
    record.rating >= -1 &&
    record.rating <= 5
      ? record.rating
      : undefined;
  const description = typeof record.description === 'string' ? record.description : undefined;
  const tags = strings(record.tags);
  const collections = Array.isArray(record.collections)
    ? record.collections.map((path) => strings(path)).filter((path): path is string[] => !!path && path.length > 0)
    : undefined;
  return {
    ...(rating !== undefined && { rating }),
    ...(description !== undefined && { description }),
    ...(tags && { tags }),
    ...(collections && { collections }),
  };
};

/** One tag level: a `/` inside a catalog keyword would start a new level, so it becomes `|`, as the XMP reader does. */
const tagLevel = (value: string) => value.trim().replaceAll('/', '|');

/** A catalog keyword (`Places|France|Paris`) as a nested tag value (`Places/France/Paris`). */
export const catalogKeywordTag = (keyword: string): string | undefined => {
  const levels = keyword
    .split('|')
    .map((level) => tagLevel(level))
    .filter(Boolean);
  return levels.length > 0 ? levels.join('/') : undefined;
};

/** Every tag the catalog gives an item: its keywords, its colour label and a pick. */
export const catalogTags = (item: PhotoSourceCatalogItem): string[] => {
  const tags = new Set<string>();
  for (const keyword of item.keywords ?? []) {
    const tag = catalogKeywordTag(keyword);
    if (tag) {
      tags.add(tag);
    }
  }
  const label = item.colorLabel ? tagLevel(item.colorLabel) : '';
  if (label) {
    tags.add(`${CATALOG_COLOUR_LABEL_TAG}/${label}`);
  }
  if (item.flag === 'pick') {
    tags.add(CATALOG_PICK_TAG);
  }
  return [...tags];
};

/** The rating the catalog asks for: a reject wins over stars; taking a reject back with no stars unrates. */
export const catalogRating = (item: PhotoSourceCatalogItem, previous: CatalogApplied): number | undefined => {
  if (item.flag === 'reject') {
    return -1;
  }
  if (item.rating !== undefined) {
    return item.rating;
  }
  if (item.flag !== undefined && previous.rating === -1) {
    return 0;
  }
  return undefined;
};

/** The description the catalog asks for: the caption, or the title when there is no caption. */
export const catalogDescription = (item: PhotoSourceCatalogItem): string | undefined =>
  item.caption?.trim() || item.title?.trim() || undefined;

const pathKey = (path: string[]) => JSON.stringify(path);

type ItemPlan = {
  itemId: string;
  assetId: string;
  previous: CatalogApplied;
  next: CatalogApplied;
  update: { rating?: number | null; description?: string };
  tags: string[];
  collections: string[][];
  applied: PhotoSourceCatalogField[];
  keptEdits: PhotoSourceCatalogField[];
};

type ItemResult = {
  itemId: string;
  status: PhotoSourceCatalogItemStatus;
  applied: PhotoSourceCatalogField[];
  keptEdits: PhotoSourceCatalogField[];
};

/**
 * Decide one scalar field. The catalog's value is written when the item still holds what the last read-in wrote
 * (or, before any read-in, holds nothing); otherwise the person changed it in Frameleaf and their change stays.
 */
const decide = <T>(
  field: PhotoSourceCatalogField,
  desired: T | undefined,
  current: T,
  previous: T | undefined,
  empty: T,
  plan: Pick<ItemPlan, 'applied' | 'keptEdits'>,
): 'write' | 'record' | 'keep' | 'skip' => {
  if (desired === undefined) {
    return 'skip';
  }
  if (current === desired) {
    return 'record';
  }
  if (previous === undefined ? current === empty : current === previous) {
    plan.applied.push(field);
    return 'write';
  }
  plan.keptEdits.push(field);
  return 'keep';
};

/**
 * FL-1030: turns what Frameleaf Desktop reads from a Lightroom Classic, Capture One or Apple Photos catalog into
 * Frameleaf ratings, tags, descriptions and albums on the photos a source copied.
 *
 * - **Additive.** Tags and albums are only ever added; a read-in never removes a tag, an album membership or a
 *   rating.
 * - **Repeatable.** What was written is remembered per item (`frameleaf.catalog` asset metadata). Sending the same
 *   batch again changes nothing, and a field the person changed in Frameleaf since is left as they made it. A tag or
 *   album the person took an item out of is not added back.
 * - **The owner's photo session only**, through the same checks as the rest of the source; a revoked source refuses.
 *   Every write goes through the services a person's own edit uses, so partners see the result only through normal
 *   sharing.
 */
@Injectable()
export class PhotoSourceCatalogService {
  constructor(
    private repository: PhotoSourceRepository,
    private access: AccessRepository,
    private assetRepository: AssetRepository,
    private assets: AssetService,
    private tags: TagService,
    private albums: AlbumService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PhotoSourceCatalogService.name);
  }

  async apply(
    auth: AuthDto,
    sourceId: string,
    input: PhotoSourceCatalogMetadataDto,
  ): Promise<PhotoSourceCatalogMetadataResponseDto> {
    const authority = photoSourceAuthority(auth);
    const { items } = PhotoSourceCatalogMetadataDto.schema.parse(input);
    const targets = await this.repository.catalogTargets(
      authority,
      sourceId,
      items.map(({ itemId }) => itemId),
    );
    const byId = new Map(targets.map((target) => [target.id.toLowerCase(), target]));
    const assetIds = targets.flatMap((target) =>
      target.state === 'verified' && target.assetId ? [target.assetId] : [],
    );
    const writable = await checkAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: assetIds });

    const results = new Map<string, ItemResult>();
    const plans: ItemPlan[] = [];
    for (const item of items) {
      const target = byId.get(item.itemId.toLowerCase());
      const status = this.readiness(target, writable);
      if (status) {
        results.set(item.itemId, { itemId: item.itemId, status, applied: [], keptEdits: [] });
        continue;
      }
      plans.push(this.plan(item, target!));
    }

    await this.addTags(auth, plans);
    await this.addToAlbums(auth, plans);
    for (const plan of plans) {
      if (plan.update.rating !== undefined || plan.update.description !== undefined) {
        await this.assets.update(auth, plan.assetId, plan.update);
      }
      if (JSON.stringify(plan.next) !== JSON.stringify(plan.previous)) {
        await this.assetRepository.upsertMetadata(plan.assetId, [
          { key: CATALOG_METADATA_KEY, value: plan.next as Record<string, unknown> },
        ]);
      }
      const status = plan.applied.length > 0 ? 'applied' : plan.keptEdits.length > 0 ? 'keptEdits' : 'unchanged';
      results.set(plan.itemId, { itemId: plan.itemId, status, applied: plan.applied, keptEdits: plan.keptEdits });
    }

    const ordered = items.map(({ itemId }) => results.get(itemId)!);
    const summary = { applied: 0, unchanged: 0, keptEdits: 0, notReady: 0, notFound: 0 };
    for (const { status } of ordered) {
      summary[status]++;
    }
    this.logger.log(
      `Catalog read-in for source ${sourceId}: ${summary.applied} applied, ${summary.unchanged} unchanged, ` +
        `${summary.keptEdits} kept edits, ${summary.notReady} not ready, ${summary.notFound} not found`,
    );
    return PhotoSourceCatalogMetadataResponseDto.schema.parse({ summary, items: ordered });
  }

  private readiness(
    target: CatalogTarget | undefined,
    writable: Set<string>,
  ): PhotoSourceCatalogItemStatus | undefined {
    if (!target) {
      return 'notFound';
    }
    if (target.state !== 'verified' || !target.copiedAssetId) {
      return 'notReady';
    }
    if (!target.assetId || !writable.has(target.assetId)) {
      return 'notFound';
    }
  }

  private plan(item: PhotoSourceCatalogItem, target: CatalogTarget): ItemPlan {
    const previous = parseCatalogApplied(target.applied);
    const plan: ItemPlan = {
      itemId: item.itemId,
      assetId: target.assetId!,
      previous,
      next: { ...previous },
      update: {},
      tags: [],
      collections: [],
      applied: [],
      keptEdits: [],
    };

    const rating = catalogRating(item, previous);
    const ratingDecision = decide('rating', rating, target.rating ?? 0, previous.rating, 0, plan);
    if (ratingDecision === 'write') {
      // a rating of 0 is stored as unrated
      plan.update.rating = rating === 0 ? null : rating;
    }
    if (ratingDecision === 'write' || ratingDecision === 'record') {
      plan.next.rating = rating;
    }

    const description = catalogDescription(item);
    const descriptionDecision = decide(
      'description',
      description,
      target.description ?? '',
      previous.description,
      '',
      plan,
    );
    if (descriptionDecision === 'write') {
      plan.update.description = description;
    }
    if (descriptionDecision === 'write' || descriptionDecision === 'record') {
      plan.next.description = description;
    }

    // Lists only grow: a value added at an earlier read-in is not added again, so one the person removed stays gone.
    const tags = catalogTags(item);
    const appliedTags = new Set(previous.tags);
    plan.tags = tags.filter((tag) => !appliedTags.has(tag));
    if (plan.tags.length > 0) {
      plan.next.tags = [...appliedTags, ...plan.tags];
      plan.applied.push('tags');
    }

    const appliedCollections = new Set((previous.collections ?? []).map((path) => pathKey(path)));
    const collections = new Map<string, string[]>();
    for (const { path, name } of item.collections ?? []) {
      const full = [...path, name];
      const key = pathKey(full);
      if (!appliedCollections.has(key)) {
        collections.set(key, full);
      }
    }
    plan.collections = collections.values().toArray();
    if (plan.collections.length > 0) {
      plan.next.collections = [...(previous.collections ?? []), ...plan.collections];
      plan.applied.push('albums');
    }
    return plan;
  }

  /** Make (or reuse, by name) each tag once, then tag the items, one call per distinct set of tags. */
  private async addTags(auth: AuthDto, plans: ItemPlan[]) {
    const values = [...new Set(plans.flatMap((plan) => plan.tags))];
    if (values.length === 0) {
      return;
    }
    const tags = await this.tags.upsert(auth, { tags: values });
    const ids = new Map(tags.map((tag) => [tag.value, tag.id]));
    const groups = new Map<string, { tagIds: string[]; assetIds: string[] }>();
    for (const plan of plans) {
      const tagIds = [...new Set(plan.tags.map((value) => ids.get(value)).filter((id): id is string => !!id))].sort();
      if (tagIds.length === 0) {
        continue;
      }
      const key = tagIds.join(',');
      const group = groups.get(key) ?? { tagIds, assetIds: [] };
      // two items of different runs can name the same photo
      if (!group.assetIds.includes(plan.assetId)) {
        group.assetIds.push(plan.assetId);
      }
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await this.tags.bulkTagAssets(auth, group);
    }
  }

  /** Find or make the album for each collection (collection sets become collections), then add the items to it. */
  private async addToAlbums(auth: AuthDto, plans: ItemPlan[]) {
    const resolved = new Map<string, string>();
    const members = new Map<string, Set<string>>();
    for (const plan of plans) {
      for (const path of plan.collections) {
        const albumId = await this.resolveAlbum(auth, path, resolved);
        const assetIds = members.get(albumId) ?? new Set<string>();
        assetIds.add(plan.assetId);
        members.set(albumId, assetIds);
      }
    }
    for (const [albumId, assetIds] of members) {
      await this.albums.addAssets(auth, albumId, { ids: [...assetIds] });
    }
  }

  private async resolveAlbum(auth: AuthDto, path: string[], resolved: Map<string, string>): Promise<string> {
    let parentId: string | null = null;
    for (let depth = 1; depth <= path.length; depth++) {
      const leaf = depth === path.length;
      const key = `${leaf ? 'album' : 'collection'}:${pathKey(path.slice(0, depth))}`;
      let albumId = resolved.get(key);
      if (!albumId) {
        const albumName = path[depth - 1];
        const existing = await this.repository.findCatalogAlbum(auth.user.id, albumName, parentId, leaf);
        albumId =
          existing?.id ??
          (
            await this.albums.create(auth, {
              albumName,
              ...(parentId === null ? {} : { parentId }),
              kind: leaf ? AlbumKind.Album : AlbumKind.Collection,
            })
          ).id;
        resolved.set(key, albumId);
      }
      parentId = albumId;
    }
    return parentId!;
  }
}
