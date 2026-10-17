import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import {
  AssetFileType,
  AssetStatus,
  AssetType,
  AssetVisibility,
  MediaHealthCategory,
  MediaHealthStatus,
} from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { asUuid, withHiddenContentFilter } from 'src/utils/database.js';
import { revealedLockScope } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const execFile = promisify(execFileCallback);

/** The sensor decoder `renderRawWithLibRaw` runs (utils/raw-renderer.ts). */
export const RAW_DECODER_PATH = '/usr/local/bin/dcraw_emu';

/** RAW extensions, without the dot. PSD sits in the legacy list but is a layered image, not sensor data. */
export const RAW_EXTENSIONS = Object.keys(mimeTypes.raw)
  .map((extension) => extension.slice(1))
  .filter((extension) => extension !== 'psd');

const RAW_NAME_PATTERN = String.raw`\.(${RAW_EXTENSIONS.join('|')})$`;

/** The open Library Care findings that say something about decoding a RAW file. */
const DECODE_FINDINGS = [
  MediaHealthStatus.UnsupportedRaw,
  MediaHealthStatus.CorruptSuspect,
  MediaHealthStatus.CorruptConfirmed,
];

export type RawSupportQueryOptions = HiddenContentQueryOptions & { ownerId: string; limit: number };

/** What decides a file's state; the service turns it into a `RawSupportStatus`. */
export type RawSupportFacts = {
  healthStatus: MediaHealthStatus | null;
  healthReason: string | null;
  hasPreview: boolean;
  hasFullsize: boolean;
};

export type RawSupportGroup = RawSupportFacts & { extension: string; count: number };

export type RawSupportRow = RawSupportFacts & {
  assetId: string;
  fileName: string;
  make: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  renderedAt: Date | null;
  pairedFileName: string | null;
};

@Injectable()
export class RawSupportRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * The caller's RAW originals: one aggregate row per combination of extension and state facts (to
   * count every file cheaply), and the first `limit` files, those with a decode finding or without a
   * preview first, then the newest. The same privacy as Library Care: the owner's own media, Locked
   * only when revealed in this session, and the viewer's hidden-content settings.
   */
  async getSummary(options: RawSupportQueryOptions): Promise<{ groups: RawSupportGroup[]; items: RawSupportRow[] }> {
    const fileExists = (type: AssetFileType) =>
      sql<boolean>`exists (select 1 from asset_file where asset_file."assetId" = asset.id and asset_file.type = ${sql.lit(type)} and asset_file."isEdited" = false)`;
    const extension = sql<string>`lower(substring(asset."originalFileName" from '\.([^.]+)$'))`;
    const base = this.db
      .selectFrom('asset')
      .leftJoin('asset_health', (join) =>
        join
          .onRef('asset_health.assetId', '=', 'asset.id')
          .on('asset_health.category', '=', sql.lit(MediaHealthCategory.Corrupt))
          .on(
            'asset_health.status',
            'in',
            DECODE_FINDINGS.map((status) => sql.lit(status)),
          )
          .on('asset_health.resolvedAt', 'is', null)
          .on('asset_health.dismissedAt', 'is', null),
      )
      .where('asset.ownerId', '=', asUuid(options.ownerId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', sql.lit(AssetStatus.Active))
      .where('asset.type', '=', sql.lit(AssetType.Image))
      .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Timeline), sql.lit(AssetVisibility.Archive)])
      .where(revealedLockScope(options.revealLockedOwnerId, 'asset'))
      .where(sql<boolean>`lower(asset."originalFileName") ~ ${RAW_NAME_PATTERN}`)
      .$call((qb) => withHiddenContentFilter(qb, options));

    const facts = base.select([
      extension.as('extension'),
      'asset_health.status as healthStatus',
      sql<string | null>`asset_health.evidence->>'reason'`.as('healthReason'),
      fileExists(AssetFileType.Preview).as('hasPreview'),
      fileExists(AssetFileType.FullSize).as('hasFullsize'),
    ]);
    const [groups, items] = await Promise.all([
      this.db
        .selectFrom(facts.as('facts'))
        .select(['extension', 'healthStatus', 'healthReason', 'hasPreview', 'hasFullsize'])
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .groupBy(['extension', 'healthStatus', 'healthReason', 'hasPreview', 'hasFullsize'])
        .execute(),
      base
        .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select([
          'asset.id as assetId',
          'asset.originalFileName as fileName',
          'asset_exif.make',
          'asset_exif.model',
          'asset_exif.exifImageWidth as width',
          'asset_exif.exifImageHeight as height',
          'asset_health.status as healthStatus',
          sql<string | null>`asset_health.evidence->>'reason'`.as('healthReason'),
          fileExists(AssetFileType.Preview).as('hasPreview'),
          fileExists(AssetFileType.FullSize).as('hasFullsize'),
          sql<Date | null>`(select asset_file."updatedAt" from asset_file where asset_file."assetId" = asset.id and asset_file.type = ${sql.lit(AssetFileType.Preview)} and asset_file."isEdited" = false)`.as(
            'renderedAt',
          ),
          sql<
            string | null
          >`(select other."originalFileName" from asset as other where asset."stackId" is not null and other."stackId" = asset."stackId" and other.id <> asset.id and other."deletedAt" is null order by other."originalFileName" limit 1)`.as(
            'pairedFileName',
          ),
        ])
        .orderBy(
          sql`case when asset_health.id is not null then 0 when not ${fileExists(AssetFileType.Preview)} then 1 else 2 end`,
        )
        .orderBy('asset.fileCreatedAt', 'desc')
        .orderBy('asset.id')
        .limit(options.limit)
        .execute(),
    ]);
    return {
      groups: groups.map((group) => ({ ...group, count: Number(group.count) })),
      items,
    };
  }

  /** The sensor decoder is installed and executable. */
  async hasDecoder(): Promise<boolean> {
    try {
      await access(RAW_DECODER_PATH, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** The first line of `darktable-cli --version`, or null when it is not installed. */
  async getDeveloperVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFile('darktable-cli', ['--version'], { timeout: 10_000, killSignal: 'SIGKILL' });
      return stdout.trim().split('\n', 1)[0] || null;
    } catch {
      return null;
    }
  }
}
