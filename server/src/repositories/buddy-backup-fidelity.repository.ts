import { type Kysely, type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { AssetType } from 'src/enum.js';
import { DEVELOP_ARTIFACT_PER_ASSET } from 'src/repositories/asset-develop.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import {
  type BuddyAssetFidelity,
  buddyArtifactSchema,
  buddyAssetFidelitySchema,
  buddyDevelopExportSchema,
  buddyDevelopRevisionSchema,
  buddyFidelityPaths,
  buddyRestorationSchema,
  buddyVideoVersionSchema,
} from 'src/utils/buddy-backup-fidelity.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';
import { canonicalJson } from 'src/utils/object.js';

type Row = Record<string, unknown>;
const tables = {
  video: 'public.video_edit_version',
  develop: 'public.asset_develop_revision',
  artifact: 'public.asset_develop_artifact',
  exported: 'public.develop_export',
  restoration: 'public.asset_restoration',
} as const;
type Table = (typeof tables)[keyof typeof tables];
const jsonColumns = new Set(['recipe', 'files', 'previewRegion', 'provenance']);
const checksumColumns = new Set(['sourceChecksum', 'renditionChecksum']);
/** Internal snapshot/publication adapter. Publication requires the caller's live Buddy guard transaction. */
export class BuddyBackupFidelityRepository {
  constructor(private db: Kysely<DB>) {}
  private async rows(table: Table, assetId: string) {
    const result = await sql<{
      record: Row;
    }>`SELECT to_jsonb(item) AS record FROM ${sql.table(table)} item
      WHERE "assetId"=${assetId}::uuid ORDER BY id`.execute(this.db);
    return result.rows.map(({ record }) => record);
  }
  async capture(
    assetId: string,
    originalSha256: string,
    projection: BuddyAssetFidelity['projection'],
    edits: BuddyAssetFidelity['edits'],
  ): Promise<BuddyAssetFidelity> {
    const asset = await this.db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'checksum', 'checksumAlgorithm', 'type'])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
    const selection = await sql<{
      requestedVersionId: string | null;
      currentVersionId: string | null;
    }>`
      SELECT "requestedVersionId", "currentVersionId" FROM public.video_edit_selection
      WHERE "assetId"=${assetId}::uuid AND "ownerId"=${asset.ownerId}::uuid`.execute(this.db);
    return buddyAssetFidelitySchema.parse({
      version: 1,
      assetId,
      ownerId: asset.ownerId,
      source: {
        checksum: asset.checksum.toString('hex'),
        checksumAlgorithm: asset.checksumAlgorithm,
        sha256: originalSha256,
        type: asset.type,
      },
      videoVersions: await this.rows(tables.video, assetId),
      videoSelection: selection.rows[0] ?? null,
      edits,
      developRevisions: await this.rows(tables.develop, assetId),
      artifacts: await this.rows(tables.artifact, assetId),
      developExports: await this.rows(tables.exported, assetId),
      restorations: (await this.rows(tables.restoration, assetId)).filter(
        (row) => row.status === 'restored' && row.resultPath,
      ),
      projection,
      files: [],
    });
  }
  /** Called only after all files in the same exported snapshot have been hashed and encrypted. */
  bindFiles(state: BuddyAssetFidelity, inventory: ReadonlyMap<string, CloudBackupManifestFile>) {
    const paths = new Set(buddyFidelityPaths(state));
    for (const master of [
      ...state.projection.map((file) => file.path),
      ...state.videoVersions.flatMap((row) => (row.masterPath ? [row.masterPath] : [])),
    ]) {
      const lineage = getEditedMasterLineagePath(master);
      if (inventory.has(lineage)) paths.add(lineage);
    }
    state.files = [...paths].sort().map((path) => {
      const file = inventory.get(path);
      if (!file) throw new Error('Buddy retained version file was not captured');
      return file;
    });
  }
  async publish(options: {
    state: BuddyAssetFidelity;
    ownerId: string;
    originalSha256: string;
    mode: 'keep' | 'replace';
    paths: ReadonlyMap<string, string>;
    verify: () => Promise<void>;
  }): Promise<'restored' | 'preserved-source'> {
    if (!this.db.isTransaction) throw new Error('Buddy metadata publication requires its authorization transaction');
    const trx = this.db as Transaction<DB>;
    const { ownerId, mode } = options;
    const state = buddyAssetFidelitySchema.parse(options.state);
    if (state.ownerId !== ownerId) throw new Error('Buddy version ownership changed');
    for (const row of [
      ...state.videoVersions,
      ...state.developRevisions,
      ...state.artifacts,
      ...state.developExports,
      ...state.restorations,
    ])
      if (row.ownerId !== ownerId || row.assetId !== state.assetId) throw new Error('Buddy version ownership changed');
    const asset = await trx
      .selectFrom('asset')
      .select(['id', 'ownerId', 'checksum', 'originalPath', 'type'])
      .where('id', '=', state.assetId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (asset.ownerId !== ownerId || asset.type !== state.source.type) throw new Error('Buddy version asset changed');
    // Keeping a changed original must never attach a snapshot's edit to different source pixels.
    if (options.originalSha256 !== state.source.sha256) {
      if (mode === 'replace') throw new Error('Buddy version original has not been restored');
      return 'preserved-source';
    }
    for (const name of ['asset_develop_revision', 'asset_develop_artifact']) {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${name}:${asset.id}`}, 0)) AS locked`.execute(trx);
      if (!lock.rows[0]?.locked) throw new Error('An edit is changing; retry this restore');
    }
    for (const path of [...new Set(options.paths.values())].sort()) await lockFilePath(trx, path);
    await options.verify();
    const path = (value: string | null): string | null => {
      if (value === null) return null;
      const target = options.paths.get(value);
      if (!target) throw new Error('Buddy version file closure is incomplete');
      return target;
    };
    // Video/restoration source checksums historically used the asset's stored checksum, including SHA-1.
    // Only an exact captured identity is translated. History of an older original remains inactive.
    const sourceChecksum = (value: string) =>
      value === state.source.checksum ? asset.checksum.toString('hex') : value;
    const currentVideos = await sql<{
      ownerId: string;
      requestedVersionId: string | null;
      currentVersionId: string | null;
    }>`
      SELECT "ownerId", "requestedVersionId", "currentVersionId" FROM public.video_edit_selection
      WHERE "assetId"=${asset.id}::uuid FOR UPDATE`.execute(trx);
    const previousDevelop = await this.rows(tables.develop, asset.id);
    const previousRestorations = await this.rows(tables.restoration, asset.id);
    if ([...currentVideos.rows, ...previousDevelop, ...previousRestorations].some((row) => row.ownerId !== ownerId))
      throw new Error('Buddy current version ownership changed');
    const previousProjection = await trx
      .selectFrom('asset_file')
      .select('id')
      .where('assetId', '=', asset.id)
      .where('isEdited', '=', true)
      .forUpdate()
      .execute();
    const previousEdits = await trx
      .selectFrom('asset_edit')
      .select(['action', 'parameters'])
      .where('assetId', '=', asset.id)
      .orderBy('sequence')
      .forUpdate()
      .execute();
    for (const version of state.videoVersions) {
      const value = {
        ...version,
        sourcePath: asset.originalPath,
        sourceChecksum: sourceChecksum(version.sourceChecksum),
        status: version.status === 'pending' ? 'failed' : version.status,
        masterPath: path(version.masterPath),
        proxyPath: path(version.proxyPath),
        files: version.files.map((file) => ({ ...file, assetId: asset.id, path: path(file.path)! })),
      };
      await this.put(
        tables.video,
        value,
        ['id'],
        ['assetId', 'ownerId', 'createdAt', 'recipe', 'purpose', 'sourceChecksum'],
        (row) => ({
          ...buddyVideoVersionSchema.parse(row),
          sourceChecksum: sourceChecksum(buddyVideoVersionSchema.parse(row).sourceChecksum),
        }),
        version.status === 'ready'
          ? ['masterPath', 'proxyPath', 'files', 'status', 'sourceChecksum', 'sourcePath']
          : [],
      );
    }
    for (const exported of state.developExports)
      await this.put(
        tables.exported,
        exported,
        ['id'],
        ['assetId', 'ownerId', 'createdAt', 'sourceChecksum', 'fileName'],
        (row) => buddyDevelopExportSchema.parse(row),
        [],
      );
    for (const artifact of state.artifacts) {
      const inserted = await this.put(
        tables.artifact,
        { ...artifact, path: path(artifact.path) },
        ['assetId', 'id'],
        ['ownerId', 'kind', 'bytes', 'width', 'height'],
        (row) => buddyArtifactSchema.parse(row),
        ['path'],
      );
      if (inserted) {
        const charged = await trx
          .updateTable('user')
          .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${artifact.bytes}` })
          .where('id', '=', ownerId)
          .where(
            sql<boolean>`"quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${artifact.bytes} <= "quotaSizeInBytes"`,
          )
          .returning('id')
          .executeTakeFirst();
        if (!charged) throw new Error('More storage quota is needed to restore these edit artifacts');
      }
    }
    const count = await sql<{
      count: string;
    }>`SELECT count(*) AS count FROM public.asset_develop_artifact
      WHERE "assetId"=${asset.id}::uuid`.execute(trx);
    if (Number(count.rows[0].count) > DEVELOP_ARTIFACT_PER_ASSET)
      throw new Error('Too many retained develop artifacts');
    for (const revision of state.developRevisions) {
      const value = {
        ...revision,
        masterPath: path(revision.masterPath),
        previewPath: path(revision.previewPath),
        isCurrent: false,
        status: ['queued', 'rendering'].includes(revision.status) ? 'saved' : revision.status,
      };
      await this.put(
        tables.develop,
        value,
        ['id'],
        [
          'assetId',
          'ownerId',
          'createdAt',
          'revision',
          'recipeVersion',
          'recipe',
          'kind',
          'exportId',
          ...(revision.kind === 'external' ? ['sourceChecksum', 'renditionChecksum'] : []),
        ],
        (row) => buddyDevelopRevisionSchema.parse(row),
        (row) => {
          const current = buddyDevelopRevisionSchema.parse(row);
          if (['queued', 'rendering'].includes(current.status)) {
            if (mode === 'replace') throw new Error('An edit is changing; retry this restore');
            return [];
          }
          // Recipe renders may finish after the snapshot or use a later renderer. Keep that
          // output; replacing it is explicit. External import checksums are immutable above.
          if (
            revision.status !== 'rendered' ||
            (mode === 'keep' &&
              current.status === 'rendered' &&
              current.renditionChecksum !== revision.renditionChecksum)
          )
            return [];
          return [
            'masterPath',
            'previewPath',
            'status',
            'rendererVersion',
            'width',
            'height',
            'renderedAt',
            'sourceChecksum',
            'renditionChecksum',
          ];
        },
      );
    }
    for (const restoration of state.restorations) {
      const value = {
        ...restoration,
        sourceChecksum: sourceChecksum(restoration.sourceChecksum),
        isCurrent: false,
        resultPath: path(restoration.resultPath),
        resultPreviewPath: path(restoration.resultPreviewPath),
        resultExpiresAt: null,
      };
      await this.put(
        tables.restoration,
        value,
        ['id'],
        [
          'assetId',
          'ownerId',
          'createdAt',
          'revision',
          'mode',
          'upscale',
          'keepGrain',
          'workload',
          'sourceChecksum',
          'provenance',
        ],
        (row) => {
          const parsed = buddyRestorationSchema.parse({
            ...row,
            status: 'restored',
            resultPath: row.resultPath ?? restoration.resultPath,
          });
          return { ...parsed, sourceChecksum: sourceChecksum(parsed.sourceChecksum) };
        },
        (row) =>
          mode === 'replace' || row.status === 'restored'
            ? ['resultPath', 'resultPreviewPath', 'status', 'sourceChecksum', 'resultExpiresAt']
            : [],
      );
    }
    if (mode === 'replace' || previousDevelop.length === 0) {
      const current = state.developRevisions.find(
        (row) =>
          row.isCurrent &&
          row.status === 'rendered' &&
          (row.sourceChecksum === null || row.sourceChecksum === state.source.sha256),
      );
      await sql`UPDATE public.asset_develop_revision SET "isCurrent"=false WHERE "assetId"=${asset.id}::uuid`.execute(
        trx,
      );
      if (current)
        await sql`UPDATE public.asset_develop_revision SET "isCurrent"=true
        WHERE id=${current.id}::uuid AND "assetId"=${asset.id}::uuid AND "ownerId"=${ownerId}::uuid`.execute(trx);
    }
    if (mode === 'replace' || previousRestorations.length === 0) {
      const current = state.restorations.find(
        (row) => row.isCurrent && sourceChecksum(row.sourceChecksum) === asset.checksum.toString('hex'),
      );
      await trx.updateTable('asset_restoration').set({ isCurrent: false }).where('assetId', '=', asset.id).execute();
      if (current)
        await trx
          .updateTable('asset_restoration')
          .set({ isCurrent: true })
          .where('id', '=', current.id)
          .where('assetId', '=', asset.id)
          .where('ownerId', '=', ownerId)
          .execute();
    }
    const restoreVideoChoice =
      mode === 'replace' ||
      (currentVideos.rows.length === 0 && previousProjection.length === 0 && previousEdits.length === 0);
    if (state.source.type === AssetType.Video && restoreVideoChoice) {
      const ready = (id: string | null | undefined) =>
        state.videoVersions.find(
          (row) =>
            row.id === id &&
            row.status === 'ready' &&
            sourceChecksum(row.sourceChecksum) === asset.checksum.toString('hex'),
        )?.id ?? null;
      if (state.videoSelection) {
        const current = ready(state.videoSelection.currentVersionId);
        // In-flight recipes stay in history, but cannot become a requested background render.
        const requested = ready(state.videoSelection.requestedVersionId) ?? current;
        await sql`INSERT INTO public.video_edit_selection ("assetId","ownerId","requestedVersionId","currentVersionId")
          VALUES (${asset.id}::uuid,${ownerId}::uuid,${requested}::uuid,${current}::uuid)
          ON CONFLICT ("assetId") DO UPDATE SET "requestedVersionId"=excluded."requestedVersionId", "currentVersionId"=excluded."currentVersionId"
          WHERE public.video_edit_selection."ownerId"=excluded."ownerId"`.execute(trx);
      } else {
        // An unedited video has no selection row. A null selection instead means a refused
        // version source to the normal renderer and would break later thumbnail generation.
        await sql`DELETE FROM public.video_edit_selection
          WHERE "assetId"=${asset.id}::uuid AND "ownerId"=${ownerId}::uuid`.execute(trx);
      }
      // Write the captured recipe without replaceAll(), which would enqueue a new historical render version.
      await trx.deleteFrom('asset_edit').where('assetId', '=', asset.id).execute();
      if (state.edits.length > 0)
        await sql`INSERT INTO public.asset_edit ("assetId",sequence,action,parameters)
        VALUES ${sql.join(state.edits.map((edit, sequence) => sql`(${asset.id}::uuid,${sequence},${edit.action},${JSON.stringify(edit.parameters)}::text::jsonb)`))}`.execute(
          trx,
        );
    }
    if (
      mode === 'replace' ||
      (previousProjection.length === 0 &&
        (state.source.type === AssetType.Video
          ? restoreVideoChoice
          : canonicalJson(previousEdits) === canonicalJson(state.edits)))
    ) {
      await trx.deleteFrom('asset_file').where('assetId', '=', asset.id).where('isEdited', '=', true).execute();
      if (state.projection.length > 0)
        await trx
          .insertInto('asset_file')
          .values(
            state.projection.map((file) => ({
              ...file,
              assetId: asset.id,
              path: path(file.path)!,
              physicalFileId: null,
            })),
          )
          .execute();
    }
    return 'restored';
  }
  /** Immutable identity conflicts stop the transaction. Only already verified file locations may be rebound. */
  private async put(
    table: Table,
    row: Row,
    keys: string[],
    immutable: string[],
    normalize: (row: Row) => Row,
    update: string[] | ((row: Row) => string[]),
  ): Promise<boolean> {
    const columns = Object.keys(row);
    const value = (column: string) =>
      jsonColumns.has(column)
        ? sql`${JSON.stringify(row[column])}::text::jsonb`
        : checksumColumns.has(column) && row[column] !== null
          ? sql`${Buffer.from(String(row[column]), 'hex')}`
          : sql`${row[column]}`;
    const where = sql.join(
      keys.map((key) => sql`${sql.ref(key)}=${row[key]}`),
      sql` AND `,
    );
    const result = await sql`INSERT INTO ${sql.table(table)} (${sql.join(columns.map((column) => sql.ref(column)))})
      VALUES (${sql.join(columns.map((column) => value(column)))}) ON CONFLICT DO NOTHING RETURNING id`.execute(
      this.db,
    );
    const stored = await sql<{
      record: Row;
    }>`SELECT to_jsonb(item) AS record FROM ${sql.table(table)} item
      WHERE ${where} FOR UPDATE`.execute(this.db);
    if (!stored.rows[0]) throw new Error('Buddy version revision identity conflicts with a current version');
    const current = normalize(stored.rows[0].record);
    if (immutable.some((key) => canonicalJson(current[key]) !== canonicalJson(row[key])))
      throw new Error('Buddy immutable version identity changed');
    const updates = typeof update === 'function' ? update(stored.rows[0].record) : update;
    if (updates.length > 0)
      await sql`UPDATE ${sql.table(table)} SET
      ${sql.join(updates.map((column) => sql`${sql.ref(column)}=${value(column)}`))} WHERE ${where}`.execute(this.db);
    return result.rows.length > 0;
  }
}
