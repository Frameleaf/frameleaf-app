import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { ImportManifest, parseImportManifest } from 'src/library-import/manifest.js';
import { LibraryImportBinding, LibraryImportJournal, LibraryImportRefused } from 'src/library-import/state.js';

/** Internal role grants require a source inventory already qualified for equivalent destination permissions. */
export class CanonicalAlbumWriter {
  private readonly binding: LibraryImportBinding;
  private readonly albums: Map<string, ImportManifest['albums'][number]>;
  private readonly owners: Map<string, string>;
  private readonly locked: Set<string>;
  constructor(
    private readonly db: ImportDatabase,
    context: {
      binding: LibraryImportBinding;
      manifest: unknown;
      plan: unknown;
      destinationId: string;
    },
  ) {
    this.binding = structuredClone(context.binding);
    const plan = bindDestinationImportPlan(context.plan, this.binding, context.manifest, context.destinationId);
    const manifest = parseImportManifest(context.manifest);
    this.albums = new Map(manifest.albums.map((album) => [album.id, album]));
    this.owners = new Map(plan.owners.map((owner) => [owner.sourceId, owner.destinationId.toLowerCase()]));
    this.locked = new Set(manifest.assets.filter((asset) => asset.visibility === 'locked').map((asset) => asset.id));
  }

  async write(sourceAlbumId: unknown): Promise<string> {
    const parsed = z.string().min(1).max(1024).safeParse(sourceAlbumId);
    if (!parsed.success) throw new LibraryImportRefused('ALBUM_SOURCE_INVALID');
    const album = this.albums.get(parsed.data);
    if (!album) throw new LibraryImportRefused('ALBUM_SOURCE_MISSING');
    if (album.members.some((member) => member.userId === album.ownerId))
      throw new LibraryImportRefused('ALBUM_OWNER_MEMBER_CONFLICT');
    const ownerId = this.owners.get(album.ownerId)!;
    const grants = [
      { sourceId: album.ownerId, role: 'owner' },
      ...album.members.map((member) => ({ sourceId: member.userId, role: member.role })),
    ];
    const recordSha256 = createHash('sha256').update(JSON.stringify(album)).digest('hex');
    try {
      return await new LibraryImportJournal(this.db).create(
        this.binding,
        {
          kind: 'album',
          sourceId: album.id,
          recordSha256,
        },
        async (tx, destinationId) => {
          const owners = await tx.query(
            `SELECT m.source_id,m.destination_id::text FROM public.frameleaf_library_import_mapping m
          JOIN public."user" u ON u.id=m.destination_id WHERE m.operation_id=$1::uuid AND m.entity_kind='owner'
          AND m.source_id=ANY($2::text[]) AND u.status='active' AND u."deletedAt" IS NULL ORDER BY u.id FOR SHARE OF u`,
            [this.binding.operationId, grants.map((grant) => grant.sourceId)],
          );
          if (
            owners.length !== grants.length ||
            owners.some((owner) => this.owners.get(String(owner.source_id)) !== owner.destination_id)
          )
            throw new LibraryImportRefused('ALBUM_OWNERS_INCOMPLETE');
          const assets = await tx.query(
            `SELECT m.source_id,a.id::text,EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id) AS locked
          FROM public.frameleaf_library_import_mapping m
          JOIN public.asset a ON a.id=m.destination_id WHERE m.operation_id=$1::uuid AND m.entity_kind='asset'
          AND m.source_id=ANY($2::text[]) AND a."ownerId"=$3::uuid ORDER BY a.id FOR SHARE OF a`,
            [this.binding.operationId, album.assetIds, ownerId],
          );
          // A Locked item keeps its albums (owner 2026-09-27); only the source's private items are Locked.
          if (
            assets.length !== album.assetIds.length ||
            assets.some((asset) => asset.locked !== this.locked.has(String(asset.source_id)))
          )
            throw new LibraryImportRefused('ALBUM_ASSETS_INCOMPLETE');
          // Source comments/activities need their own preservation contract before enabling new ones.
          await tx.query(
            `INSERT INTO public.album(id,"albumName",description,"isActivityEnabled") VALUES($1::uuid,$2,$3,false)`,
            [destinationId, album.name, album.description ?? null],
          );
          for (const grant of grants)
            await tx.query(
              `INSERT INTO public.album_user("albumId","userId",role)
          VALUES($1::uuid,$2::uuid,$3::album_user_role_enum)`,
              [destinationId, this.owners.get(grant.sourceId), grant.role],
            );
          if (assets.length > 0)
            await tx.query(
              `INSERT INTO public.album_asset("albumId","assetId")
          SELECT $1::uuid,unnest($2::uuid[])`,
              [destinationId, assets.map((asset) => asset.id)],
            );
        },
      );
    } catch (error) {
      if (error instanceof LibraryImportRefused) throw error;
      // Driver diagnostics can contain names or private membership details.
      throw new LibraryImportRefused('ALBUM_WRITE_FAILED');
    }
  }
}
