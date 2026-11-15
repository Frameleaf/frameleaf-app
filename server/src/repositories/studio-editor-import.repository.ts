import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { InterchangeCandidate } from 'src/utils/studio-interchange/media.js';
import { AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { isNotLocked } from 'src/utils/locked.js';

const kindOf = (type: string): InterchangeCandidate['kind'] =>
  type === AssetType.Video
    ? 'video'
    : type === AssetType.Audio
      ? 'audio'
      : type === AssetType.Image
        ? 'image'
        : 'other';

/**
 * Library lookups for the editor import (FL-1543). Only the owner's own active items in the timeline
 * or the archive are ever offered: a Locked item, a hidden part of a live photo or anything in the
 * trash is never revealed as a match.
 */
@Injectable()
export class StudioEditorImportRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private owned(ownerId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.originalFileName',
        'asset.type',
        'asset.duration',
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
      ])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where(isNotLocked('asset'));
  }

  private static toCandidate(row: {
    id: string;
    originalFileName: string;
    type: string;
    duration: number | null;
    exifImageWidth: number | null;
    exifImageHeight: number | null;
  }): InterchangeCandidate {
    return {
      id: row.id,
      name: row.originalFileName,
      kind: kindOf(row.type),
      durationSeconds: typeof row.duration === 'number' && row.duration > 0 ? row.duration / 1000 : null,
      width: row.exifImageWidth,
      height: row.exifImageHeight,
    };
  }

  /** The owner's items named like any of these files, with or without the extension. */
  async getCandidates(ownerId: string, names: readonly string[]): Promise<InterchangeCandidate[]> {
    const stems = [...new Set(names.map((name) => name.replace(/\.[^./\\]+$/, '').toLowerCase()))].filter(Boolean);
    if (stems.length === 0) {
      return [];
    }
    const rows = await this.owned(ownerId)
      .where(sql<boolean>`lower(regexp_replace(asset."originalFileName", '\\.[^.]*$', '')) in (${sql.join(stems)})`)
      .limit(20_000)
      .execute();
    return rows.map((row) => StudioEditorImportRepository.toCandidate(row));
  }

  /** The owner's items with exactly these bytes (SHA-256), by checksum in hex. */
  async getByChecksums(ownerId: string, checksums: readonly Buffer[]): Promise<Map<string, string>> {
    if (checksums.length === 0) {
      return new Map();
    }
    const rows = await this.owned(ownerId)
      .select('asset.checksum')
      .where('asset.checksum', 'in', [...checksums])
      .execute();
    return new Map(rows.map((row) => [row.checksum.toString('hex'), row.id]));
  }

  /** Which of these items the owner can still use as a match (theirs, active, not Locked), with what is known of them. */
  async getUsableFacts(ownerId: string, ids: readonly string[]): Promise<Map<string, InterchangeCandidate>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.owned(ownerId)
      .where('asset.id', 'in', [...ids])
      .execute();
    return new Map(rows.map((row) => [row.id, StudioEditorImportRepository.toCandidate(row)]));
  }

  async getUsable(ownerId: string, ids: readonly string[]): Promise<Set<string>> {
    return new Set((await this.getUsableFacts(ownerId, ids)).keys());
  }
}
