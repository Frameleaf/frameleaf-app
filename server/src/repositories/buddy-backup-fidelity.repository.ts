import { type Kysely, type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { AssetStatus, AssetType, ChecksumAlgorithm } from 'src/enum.js';
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
  readBuddyImageEditSource,
} from 'src/utils/buddy-backup-fidelity.js';
import { type ImageEditSource, imageEditSourceSchema } from 'src/utils/image-edit-source.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';
import { canonicalJson } from 'src/utils/object.js';
import { sourceReferenceSchema } from 'src/utils/source-reference.js';

type Row = Record<string, unknown>;
export type BuddyRestoreOriginal = {
  source: BuddyAssetFidelity['source'];
  path: string;
  verify: () => Promise<void>;
};
const tables = {
  video: 'public.video_edit_version',
  develop: 'public.asset_develop_revision',
  artifact: 'public.asset_develop_artifact',
  exported: 'public.develop_export',
  restoration: 'public.asset_restoration',
} as const;
type Table = (typeof tables)[keyof typeof tables];
const jsonColumns = new Set(['recipe', 'files', 'previewRegion', 'provenance', 'sourceReference', 'sourceBinding']);
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
      .select(['id', 'ownerId', 'originalPath', 'checksum', 'checksumAlgorithm', 'type'])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
    const selection = await sql<{
      requestedVersionId: string | null;
      currentVersionId: string | null;
    }>`
      SELECT "requestedVersionId", "currentVersionId" FROM public.video_edit_selection
      WHERE "assetId"=${assetId}::uuid AND "ownerId"=${asset.ownerId}::uuid`.execute(this.db);
    const videoVersions = await this.rows(tables.video, assetId);
    const hasReferences = videoVersions.some(
      (row) =>
        (row.sourceReference !== null && row.sourceReference !== undefined) ||
        (typeof row.sourcePath === 'string' && row.sourcePath.toLowerCase().startsWith('frameleaf-source:')),
    );
    const developRevisions = await this.rows(tables.develop, assetId);
    const hasDevelopBindings = developRevisions.some(
      (row) =>
        (row.sourceBinding !== null && row.sourceBinding !== undefined) ||
        (row.sourceAssetId !== null && row.sourceAssetId !== undefined && row.sourceAssetId !== assetId),
    );
    let imageEditSource: ImageEditSource | null = null;
    if (asset.type === AssetType.Image && edits.length > 0) {
      const rows = await this.db
        .selectFrom('asset_edit')
        .select(['action', 'parameters', 'sourceReference'])
        .where('assetId', '=', assetId)
        .orderBy('sequence')
        .execute();
      if (
        canonicalJson(rows.map(({ action, parameters }) => ({ action, parameters }))) !==
        canonicalJson(edits.map(({ action, parameters }) => ({ action, parameters })))
      )
        throw new Error('Buddy image edit snapshot changed');
      const reference = asset.originalPath.toLowerCase().startsWith('frameleaf-source:');
      const bindings = rows.map(
        (row) => row.sourceReference ?? (reference ? { kind: 'unbound-reference' as const } : null),
      );
      imageEditSource = bindings[0] ? imageEditSourceSchema.parse(bindings[0]) : null;
      if (bindings.some((binding) => canonicalJson(binding) !== canonicalJson(imageEditSource)))
        throw new Error('Buddy image edit source bindings disagree');
    }
    return buddyAssetFidelitySchema.parse({
      version: imageEditSource ? 4 : hasDevelopBindings ? 3 : hasReferences ? 2 : 1,
      assetId,
      ownerId: asset.ownerId,
      source: {
        checksum: asset.checksum.toString('hex'),
        checksumAlgorithm: asset.checksumAlgorithm,
        sha256: originalSha256,
        type: asset.type,
      },
      videoVersions,
      videoSelection: selection.rows[0] ?? null,
      edits,
      ...(imageEditSource && { imageEditSource }),
      developRevisions,
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
    originals?: ReadonlyMap<string, BuddyRestoreOriginal>;
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
      .select(['id', 'ownerId', 'checksum', 'originalPath', 'type', 'livePhotoVideoId'])
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
    for (const path of [
      ...new Set([
        ...options.paths.values(),
        ...[...(options.originals?.values() ?? [])].map((original) => original.path),
      ]),
    ].sort())
      await lockFilePath(trx, path);
    await options.verify();
    const inputs = new Map<string, { original: BuddyRestoreOriginal; checksum: string }>();
    for (const revision of state.developRevisions) {
      const binding = revision.sourceBinding;
      if (binding?.kind !== 'bound' || binding.input.assetId === asset.id || inputs.has(binding.input.assetId))
        continue;
      const original = options.originals?.get(binding.input.assetId);
      if (
        !original ||
        revision.recipe.version !== 1 ||
        !revision.recipe.keyFrame ||
        asset.livePhotoVideoId !== binding.input.assetId
      )
        continue;
      const input = await trx
        .selectFrom('asset')
        .select(['checksum', 'checksumAlgorithm', 'originalPath'])
        .where('id', '=', binding.input.assetId)
        .where('ownerId', '=', ownerId)
        .where('type', '=', AssetType.Video)
        .where('status', '=', AssetStatus.Active)
        .where('deletedAt', 'is', null)
        .where('isExternal', '=', false)
        .where('isOffline', '=', false)
        .where('libraryId', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirst();
      if (
        !input ||
        input.originalPath !== original.path ||
        original.source.type !== AssetType.Video ||
        input.checksumAlgorithm === ChecksumAlgorithm.sha1Path ||
        input.checksum.toString('hex') !==
          (input.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? original.source.sha256
            : original.source.checksum) ||
        (input.checksumAlgorithm !== ChecksumAlgorithm.sha256File &&
          input.checksumAlgorithm !== original.source.checksumAlgorithm)
      )
        continue;
      await original.verify();
      inputs.set(binding.input.assetId, { original, checksum: input.checksum.toString('hex') });
    }
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
    const referenceMatches = (version: BuddyAssetFidelity['videoVersions'][number]) =>
      version.sourceReference
        ? version.sourceReference.sha256 === state.source.sha256
        : !version.sourcePath.toLowerCase().startsWith('frameleaf-source:');
    const videoSourceChecksum = (version: BuddyAssetFidelity['videoVersions'][number]) =>
      referenceMatches(version) ? sourceChecksum(version.sourceChecksum) : version.sourceChecksum;
    const restoredReference = (version: BuddyAssetFidelity['videoVersions'][number]) =>
      !asset.originalPath.toLowerCase().startsWith('frameleaf-source:') && referenceMatches(version)
        ? null
        : version.sourceReference;
    const restoredDevelopBinding = (revision: BuddyAssetFidelity['developRevisions'][number]) => {
      const binding = revision.sourceBinding;
      if (binding?.kind !== 'bound' || asset.originalPath.toLowerCase().startsWith('frameleaf-source:')) return binding;
      const restored = (source: typeof binding.input) => {
        const input = inputs.get(source.assetId);
        const captured = source.assetId === asset.id ? state.source : input?.original.source;
        if (
          !captured ||
          source.checksum !== captured.checksum ||
          (source.reference && source.reference.sha256 !== captured.sha256)
        )
          return;
        return {
          assetId: source.assetId,
          path: source.assetId === asset.id ? asset.originalPath : input!.original.path,
          checksum: source.assetId === asset.id ? asset.checksum.toString('hex') : input!.checksum,
          reference: null,
        };
      };
      const parent = restored(binding.parent);
      const input = restored(binding.input);
      return parent && input ? { kind: 'bound' as const, parent, input } : binding;
    };
    const restoredDevelopSourceAsset = (revision: BuddyAssetFidelity['developRevisions'][number]) => {
      // A legacy null and the parent asset id both mean the still itself.
      if (
        revision.sourceBinding === null &&
        (revision.sourceAssetId === null || revision.sourceAssetId === state.assetId)
      )
        return null;
      return revision.sourceAssetId === state.assetId ? asset.id : revision.sourceAssetId;
    };
    const canRestoreDevelop = (revision: BuddyAssetFidelity['developRevisions'][number]) => {
      const binding = restoredDevelopBinding(revision);
      if (binding === null)
        return (
          (revision.sourceAssetId === null || revision.sourceAssetId === state.assetId) &&
          (state.source.checksumAlgorithm !== ChecksumAlgorithm.sha1Path ||
            revision.sourceChecksum === state.source.sha256)
        );
      return (
        binding.kind === 'bound' &&
        binding.parent.assetId === asset.id &&
        (binding.input.assetId === asset.id ||
          (revision.recipe.version === 1 &&
            !!revision.recipe.keyFrame &&
            asset.livePhotoVideoId === binding.input.assetId &&
            inputs.has(binding.input.assetId))) &&
        binding.parent.reference === null &&
        binding.input.reference === null &&
        binding.parent.checksum === asset.checksum.toString('hex') &&
        binding.input.checksum ===
          (binding.input.assetId === asset.id
            ? asset.checksum.toString('hex')
            : inputs.get(binding.input.assetId)?.checksum)
      );
    };
    const developSourceSha256 = (revision: BuddyAssetFidelity['developRevisions'][number]) =>
      revision.sourceBinding?.kind === 'bound' && revision.sourceBinding.input.assetId !== asset.id
        ? inputs.get(revision.sourceBinding.input.assetId)?.original.source.sha256
        : state.source.sha256;
    const archivedImageSource = readBuddyImageEditSource(state);
    const imageEditSource =
      archivedImageSource &&
      'sha256' in archivedImageSource &&
      archivedImageSource.sha256 === state.source.sha256 &&
      !asset.originalPath.toLowerCase().startsWith('frameleaf-source:')
        ? null
        : archivedImageSource;
    const restorationMatches = (restoration: BuddyAssetFidelity['restorations'][number]) => {
      if (
        state.source.checksumAlgorithm !== ChecksumAlgorithm.sha1Path ||
        restoration.sourceChecksum === state.source.sha256
      )
        return true;
      const full = restoration.provenance.full;
      if (!full || typeof full !== 'object' || Array.isArray(full)) return false;
      const epochs = (full as Record<string, unknown>).sourceEpochs;
      if (!Array.isArray(epochs) || epochs.length !== 1) return false;
      const epoch: unknown = epochs[0];
      if (!epoch || typeof epoch !== 'object' || Array.isArray(epoch)) return false;
      const proof = epoch as Record<string, unknown>;
      const reference = sourceReferenceSchema.safeParse(proof.reference);
      return (
        proof.assetId === state.assetId &&
        proof.ownerId === ownerId &&
        reference.success &&
        reference.data.sha256 === state.source.sha256
      );
    };
    const restorationSourceChecksum = (restoration: BuddyAssetFidelity['restorations'][number]) =>
      restorationMatches(restoration) ? sourceChecksum(restoration.sourceChecksum) : restoration.sourceChecksum;
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
        sourcePath: referenceMatches(version) ? asset.originalPath : version.sourcePath,
        sourceChecksum: videoSourceChecksum(version),
        sourceReference: restoredReference(version),
        status: version.status === 'pending' ? 'failed' : version.status,
        masterPath: path(version.masterPath),
        proxyPath: path(version.proxyPath),
        files: version.files.map((file) => ({ ...file, assetId: asset.id, path: path(file.path)! })),
      };
      await this.put(
        tables.video,
        value,
        ['id'],
        ['assetId', 'ownerId', 'createdAt', 'recipe', 'purpose', 'sourceChecksum', 'sourceReference'],
        (row) => ({
          ...buddyVideoVersionSchema.parse(row),
          sourceChecksum: videoSourceChecksum(buddyVideoVersionSchema.parse(row)),
          sourceReference: restoredReference(buddyVideoVersionSchema.parse(row)),
        }),
        version.status === 'ready'
          ? ['masterPath', 'proxyPath', 'files', 'status', 'sourceChecksum', 'sourcePath', 'sourceReference']
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
        sourceBinding: restoredDevelopBinding(revision),
        sourceAssetId: restoredDevelopSourceAsset(revision),
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
          'sourceBinding',
          'sourceAssetId',
          'exportId',
          ...(revision.kind === 'external' ? ['sourceChecksum', 'renditionChecksum'] : []),
        ],
        (row) => {
          const revision = buddyDevelopRevisionSchema.parse(row);
          return {
            ...revision,
            sourceBinding: restoredDevelopBinding(revision),
            sourceAssetId: restoredDevelopSourceAsset(revision),
          };
        },
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
            return ['sourceBinding', 'sourceAssetId'];
          return [
            'masterPath',
            'previewPath',
            'sourceBinding',
            'sourceAssetId',
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
        sourceChecksum: restorationSourceChecksum(restoration),
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
          return { ...parsed, sourceChecksum: restorationSourceChecksum(parsed) };
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
          canRestoreDevelop(row) &&
          (row.sourceChecksum === null || row.sourceChecksum === developSourceSha256(row)),
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
        (row) =>
          row.isCurrent && restorationMatches(row) && restorationSourceChecksum(row) === asset.checksum.toString('hex'),
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
    const previousImageSources =
      state.source.type === AssetType.Image
        ? await trx
            .selectFrom('asset_edit')
            .select('sourceReference')
            .where('assetId', '=', asset.id)
            .orderBy('sequence')
            .execute()
        : [];
    const restoreImageChoice =
      state.source.type === AssetType.Image &&
      (mode === 'replace' ||
        (previousProjection.length === 0 &&
          (previousEdits.length === 0 ||
            (canonicalJson(previousEdits) === canonicalJson(state.edits) &&
              previousImageSources.every(
                (row) => canonicalJson(row.sourceReference) === canonicalJson(imageEditSource),
              )))));
    if (restoreImageChoice) {
      await trx.deleteFrom('asset_edit').where('assetId', '=', asset.id).execute();
      if (state.edits.length > 0)
        await trx
          .insertInto('asset_edit')
          .values(
            state.edits.map((edit, sequence) => ({
              assetId: asset.id,
              sequence,
              action: edit.action as never,
              parameters: edit.parameters as never,
              sourceReference: imageEditSource,
            })),
          )
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
            referenceMatches(row) &&
            videoSourceChecksum(row) === asset.checksum.toString('hex'),
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
        (state.source.type === AssetType.Video ? restoreVideoChoice : restoreImageChoice))
    ) {
      await trx.deleteFrom('asset_file').where('assetId', '=', asset.id).where('isEdited', '=', true).execute();
      const currentVideo = state.videoVersions.find((row) => row.id === state.videoSelection?.currentVersionId);
      const currentDevelop = state.developRevisions.find((row) => row.isCurrent);
      const invalidDevelop =
        currentDevelop &&
        (!canRestoreDevelop(currentDevelop) ||
          (currentDevelop.sourceChecksum !== null &&
            currentDevelop.sourceChecksum !== developSourceSha256(currentDevelop)));
      const projection =
        (currentVideo && !referenceMatches(currentVideo)) ||
        invalidDevelop ||
        (state.source.type === AssetType.Image && imageEditSource !== null)
          ? []
          : state.projection;
      if (projection.length > 0)
        await trx
          .insertInto('asset_file')
          .values(
            projection.map((file) => ({
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
        ? (column === 'sourceReference' || column === 'sourceBinding') && row[column] === null
          ? sql`NULL`
          : sql`${JSON.stringify(row[column])}::text::jsonb`
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
