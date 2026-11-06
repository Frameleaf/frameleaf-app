import { createHash } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { importsLocked, parseImportManifest } from 'src/library-import/manifest.js';
import {
  LibraryImportBinding,
  LibraryImportJournal,
  LibraryImportRefused,
  parseLibraryImportBinding,
} from 'src/library-import/state.js';
import { beginLibraryImportReadback } from 'src/library-import/verification.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mismatch = (): never => {
  throw new LibraryImportRefused('ALBUM_RECONCILIATION_MISMATCH');
};

/** Album evidence only: owners, original bytes, other photo records and activation need separate reconciliation. */
export async function reconcileImportedAlbums(
  db: ImportDatabase,
  context: { binding: LibraryImportBinding; manifest: unknown; plan: unknown; destinationId: string },
) {
  const binding = parseLibraryImportBinding(context.binding);
  const plan = bindDestinationImportPlan(context.plan, binding, context.manifest, context.destinationId);
  const manifest = parseImportManifest(context.manifest);
  try {
    return await db.transaction(async (tx) => {
      await beginLibraryImportReadback(tx);
      const { run } = await new LibraryImportJournal(tx).status();
      if (!run || JSON.stringify(run.binding) !== JSON.stringify(binding))
        throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
      if (run.status !== 'verifying') throw new LibraryImportRefused('IMPORT_NOT_VERIFYING');
      const mappings = await tx.query(
        `SELECT entity_kind,source_id,destination_id::text,record_sha256
        FROM public.frameleaf_library_import_mapping WHERE operation_id=$1::uuid`,
        [binding.operationId],
      );
      const owners = new Map(
        mappings.filter((row) => row.entity_kind === 'owner').map((row) => [row.source_id, row.destination_id]),
      );
      const assets = new Map(
        mappings.filter((row) => row.entity_kind === 'asset').map((row) => [row.source_id, row.destination_id]),
      );
      if (plan.owners.some((owner) => owners.get(owner.sourceId) !== owner.destinationId.toLowerCase())) mismatch();
      // A Locked item keeps its albums (owner 2026-09-27); only the source's private items are Locked.
      const locked = new Set(
        manifest.assets.filter((asset) => importsLocked(asset)).map((asset) => assets.get(asset.id)),
      );
      const albumMappings = new Map(
        mappings.filter((row) => row.entity_kind === 'album').map((row) => [row.source_id, row]),
      );
      if (albumMappings.size !== manifest.albums.length) mismatch();
      const expected = manifest.albums
        .map((album) => {
          const mapping = albumMappings.get(album.id);
          if (!mapping || mapping.record_sha256 !== fingerprint(album)) return mismatch();
          const ownerId = owners.get(album.ownerId);
          if (typeof ownerId !== 'string') return mismatch();
          const grants = [
            { userId: ownerId, role: 'owner' },
            ...album.members.map((member) => {
              const userId = owners.get(member.userId);
              if (typeof userId !== 'string') return mismatch();
              return { userId, role: member.role };
            }),
          ].sort((a, b) => a.userId.localeCompare(b.userId));
          const assetIds = album.assetIds
            .map((id) => {
              const destinationId = assets.get(id);
              if (typeof destinationId !== 'string') return mismatch();
              return destinationId;
            })
            .sort();
          return {
            id: mapping.destination_id,
            name: album.name,
            ...(album.description === undefined ? {} : { description: album.description }),
            ownerId,
            assetIds,
            grants,
          };
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      // A fresh destination has no independently created albums or sharing to exempt.
      if (
        (await tx.query('SELECT 1 FROM public.shared_link LIMIT 1')).length > 0 ||
        (await tx.query('SELECT 1 FROM public.shared_space_album LIMIT 1')).length > 0
      )
        mismatch();
      const albums = await tx.query(
        `SELECT id::text,"albumName" AS name,kind,"parentId"::text,"deletedAt","isActivityEnabled",
        "albumThumbnailAssetId"::text,description,"order","libraryScope",icon,color,"sortOrder"
        FROM public.album ORDER BY id`,
      );
      const memberships = await tx.query(
        `SELECT aa."albumId"::text,aa."assetId"::text,a."ownerId"::text,
        EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id) AS locked
        FROM public.album_asset aa JOIN public.asset a ON a.id=aa."assetId" ORDER BY aa."albumId",aa."assetId"`,
      );
      const grants = await tx.query(
        `SELECT au."albumId"::text,au."userId"::text,au.role::text,
        (u.status='active' AND u."deletedAt" IS NULL AND NOT u."isAdmin") AS eligible
        FROM public.album_user au JOIN public."user" u ON u.id=au."userId" ORDER BY au."albumId",au."userId"`,
      );
      const membersByAlbum = Map.groupBy(grants, (grant) => grant.albumId);
      const photosByAlbum = Map.groupBy(memberships, (membership) => membership.albumId);
      const expectedById = new Map(expected.map((album) => [album.id, album]));
      const actual = albums.map((album) => {
        const wanted = expectedById.get(album.id);
        if (
          !wanted ||
          album.kind !== 'album' ||
          album.parentId !== null ||
          album.deletedAt !== null ||
          album.isActivityEnabled !== false ||
          album.albumThumbnailAssetId !== null ||
          album.description !== (wanted.description ?? null) ||
          album.order !== 'desc' ||
          album.libraryScope !== 'personal' ||
          album.icon !== null ||
          album.color !== null ||
          album.sortOrder !== null
        )
          return mismatch();
        const members = membersByAlbum.get(album.id) ?? [];
        if (members.some((member) => member.eligible !== true)) return mismatch();
        const owner = members.filter((member) => member.role === 'owner');
        if (owner.length !== 1) return mismatch();
        const photos = photosByAlbum.get(album.id) ?? [];
        if (
          photos.some(
            (photo) => photo.ownerId !== owner[0].userId || photo.locked !== locked.has(String(photo.assetId)),
          )
        )
          return mismatch();
        return {
          id: album.id,
          name: album.name,
          ...(wanted.description === undefined ? {} : { description: album.description }),
          ownerId: owner[0].userId,
          assetIds: photos.map((photo) => photo.assetId),
          grants: members.map((member) => ({ userId: member.userId, role: member.role })),
        };
      });
      if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatch();
      return {
        format: 'frameleaf-album-reconciliation' as const,
        version: 1 as const,
        operationId: binding.operationId,
        manifestSha256: binding.manifestSha256,
        planSha256: binding.planSha256,
        albums: actual.length,
        memberships: memberships.length,
        grants: grants.length,
        sha256: fingerprint(actual),
      };
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    // Driver diagnostics may contain private album names or membership identities.
    throw new LibraryImportRefused('ALBUM_RECONCILIATION_FAILED');
  }
}
