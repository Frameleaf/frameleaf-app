import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumUserRole, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { holdSourceAdmission } from 'src/repositories/studio-source-admission.js';
import type { DB } from 'src/schema/index.js';
import type { StudioAuthorizedEntry, StudioAuthorizedManifest } from 'src/services/studio-resource.service.js';
import { checkAccess } from 'src/utils/access.js';

export type StudioSourceAuthorizedAuth = AuthDto & {
  session: NonNullable<AuthDto['session']> & { expiresAt: Date | null; pinExpiresAt: Date | null };
};

export type StudioSourceAdmission = {
  projectId: string;
  revision: number;
  graphDigest: string;
  manifest: StudioAuthorizedManifest;
  inputs: readonly StudioAuthorizedEntry[];
  expiresAt: number;
};

/** Short publication transactions; no file I/O or materialization runs while these locks are held. */
@Injectable()
export class StudioSourceResolutionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async guard(auth: AuthDto, admission: StudioSourceAdmission): Promise<StudioSourceAuthorizedAuth> {
    const unavailable = (): never => {
      throw new NotFoundException('Studio source unavailable');
    };
    const changed = (): never => {
      throw new ConflictException('studio_source_superseded');
    };
    if (!auth.session || auth.sharedLink || auth.apiKey || auth.system) unavailable();
    return this.db.transaction().execute(async (tx) => {
      const project = await tx
        .selectFrom('studio_project')
        .selectAll()
        .where('id', '=', admission.projectId)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!project) unavailable();
      if (project!.currentRevision !== admission.revision) changed();
      if (project!.ownerId !== auth.user.id) {
        if (project!.archivedAt || !project!.spaceId) unavailable();
        const member = await tx
          .selectFrom('album_user')
          .innerJoin('album', 'album.id', 'album_user.albumId')
          .select('album.id')
          .where('album.id', '=', project!.spaceId!)
          .where('album.deletedAt', 'is', null)
          .where('album_user.userId', '=', auth.user.id)
          .where('album_user.role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor, AlbumUserRole.Viewer])
          .forShare()
          .executeTakeFirst();
        if (!member) unavailable();
      }
      const revision = await tx
        .selectFrom('studio_project_revision')
        .select('digest')
        .where('projectId', '=', admission.projectId)
        .where('revision', '=', admission.revision)
        .forShare()
        .executeTakeFirst();
      if (revision?.digest !== admission.graphDigest) changed();
      await holdSourceAdmission(
        tx,
        {
          kind: 'studio-preview',
          sourceEpochs: admission.manifest.sourceEpochs,
          interactiveAdmissionView: admission.manifest.interactiveAdmissionView,
        },
        auth.user.id,
      );
      const library = admission.inputs.filter(
        (entry) => entry.sourceAccess === 'owner' || entry.sourceAccess === 'shared',
      );
      const ids = library.map((entry) => entry.id);
      const privacy = new DerivativePrivacyRepository(tx);
      const sourceIds = admission.manifest.sourceEpochs?.map((row) => row.assetId) ?? [];
      const sources = await privacy.lockSources(tx, sourceIds);
      const shared = await privacy.lockSharedAccess(tx, auth.user.id, [...sources.values()]);
      if (
        sourceIds.some((id) => {
          const source = sources.get(id);
          return !source || source.deleted || source.offline || (source.ownerId !== auth.user.id && !shared.has(id));
        })
      )
        unavailable();
      if (
        library.some((entry) => {
          const source = sources.get(entry.id);
          return (
            !source ||
            source.deleted ||
            source.offline ||
            source.ownerId !== entry.ownerId ||
            source.checksum !== entry.checksum ||
            (source.ownerId !== auth.user.id && !shared.has(entry.id))
          );
        })
      )
        unavailable();
      for (const entry of admission.inputs.filter((entry) => entry.sourceAccess === 'project')) {
        const { rows } = await sql<{ path: string; checksum: string; ownerId: string }>`
          SELECT path, checksum, "ownerId" FROM public.studio_project_import
          WHERE "projectId"=${admission.projectId}::uuid AND id=${entry.id}::uuid FOR SHARE`.execute(tx);
        if (
          rows.length !== 1 ||
          rows[0].ownerId !== project!.ownerId ||
          rows[0].path !== entry.path ||
          rows[0].checksum !== entry.checksum
        )
          changed();
      }
      // All source, project and granting-row waits precede actual session/download admission.
      const live = await currentAuth(tx, auth.user.id, auth.session!.id, true);
      if (!live) unavailable();
      const allowed = await checkAccess(new AccessRepository(tx), {
        auth: live!,
        permission: Permission.AssetDownload,
        ids: new Set(ids),
      });
      const originals = await new AssetRepository(tx).getByIds(ids);
      if (
        library.some(
          (entry) =>
            !allowed.has(entry.id) ||
            !originals.some(
              (row) =>
                row.id === entry.id &&
                row.ownerId === entry.ownerId &&
                row.originalPath === entry.path &&
                row.checksum.toString('base64') === entry.checksum,
            ),
        )
      )
        unavailable();
      await holdSourceAdmission(
        tx,
        {
          kind: 'studio-preview',
          sourceEpochs: admission.manifest.sourceEpochs,
          interactiveAdmissionView: admission.manifest.interactiveAdmissionView,
        },
        auth.user.id,
      );
      // currentAuth returns the persisted session fields as well as public AuthSession authority.
      const final = (await currentAuth(tx, auth.user.id, auth.session!.id, true)) as
        StudioSourceAuthorizedAuth | undefined;
      if (!final || final.session!.hasElevatedPermission !== live!.session!.hasElevatedPermission) unavailable();
      const now = Date.now();
      if (admission.expiresAt <= now || Date.parse(admission.manifest.expiresAt) <= now)
        throw new ConflictException('studio_source_expired');
      if (final!.session!.expiresAt && new Date(final!.session!.expiresAt).getTime() <= now) unavailable();
      if (
        final!.session!.hasElevatedPermission &&
        (!final!.session!.pinExpiresAt || new Date(final!.session!.pinExpiresAt).getTime() <= now)
      )
        unavailable();
      return final!;
    });
  }
}
