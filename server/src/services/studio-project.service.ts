import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  StudioCommentCreateDto,
  StudioCommentDto,
  StudioCommentListResponseDto,
  StudioCommentUpdateDto,
  StudioProjectCreateDto,
  StudioProjectDeleteQueryDto,
  StudioProjectDetailDto,
  StudioProjectDiffDto,
  StudioProjectDto,
  StudioProjectDuplicateDto,
  StudioProjectHistoryResponseDto,
  StudioProjectLeaseDto,
  StudioProjectLeaseRequestDto,
  StudioProjectLibrarySearchDto,
  StudioProjectListResponseDto,
  StudioProjectResourcesDto,
  StudioProjectRestoreDto,
  StudioProjectRevisionDetailDto,
  StudioProjectRevisionDto,
  StudioProjectSaveDto,
  StudioProjectSaveResponseDto,
  StudioProjectSearchDto,
  StudioProjectTrashEmptyResponseDto,
  StudioProjectUpdateDto,
} from 'src/dtos/studio-project.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  StudioProject,
  StudioProjectComment,
  StudioProjectRepository,
  StudioProjectRevision,
  StudioProjectRevisionSummary,
} from 'src/repositories/studio-project.repository.js';
import {
  StudioAuthorizedManifest,
  StudioRefusedReference,
  StudioResourceService,
} from 'src/services/studio-resource.service.js';
import {
  STUDIO_AUTOSAVE_DEBOUNCE_MS,
  STUDIO_LEASE_MS,
  STUDIO_LEASE_RENEW_MS,
  StudioProjectEnvelope,
  checkStudioEnvelope,
  diffStudioGraphs,
  isStudioLeaseHeld,
  mergeCommandSummaries,
  normalizeCommandSummary,
  normalizeStudioTime,
  studioEnvelopeDigest,
  studioProjectShelf,
  studioPurgeAfter,
} from 'src/utils/studio-project.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';

const DEFAULT_TAKE = 50;
const MANIFEST_CACHE_LIMIT = 2000;

export type StudioProjectAccess = 'owner' | 'reviewer';

/**
 * Why a write was refused with `409 Conflict`. The body carries the reason and what the client
 * needs to recover: the current head for a stale save, the lease expiry for a lost lease.
 */
export type StudioConflictReason =
  | 'stale-revision'
  | 'lease-lost'
  | 'lease-held'
  | 'request-key-reused'
  | 'revision-missing'
  /** FL-91: the project is in the trash; restore it before changing it. */
  | 'project-trashed'
  /** FL-91: the project is archived and read-only; bring it back before editing. */
  | 'project-archived';

export type StudioConflictBody = {
  statusCode: 409;
  error: 'Conflict';
  message: string;
  reason: StudioConflictReason;
  currentRevision?: number;
  lease?: StudioProjectLeaseDto;
};

/** Fired after a revision commits. FL-96 subscribes to supersede previews of the old head. */
export type StudioRevisionEvent = {
  projectId: string;
  ownerId: string;
  revision: number;
  digest: string;
  /** Set when the commit was a restore of an earlier revision. */
  restoredFromRevision: number | null;
};

export type StudioRevisionListener = (event: StudioRevisionEvent) => void | Promise<void>;

/**
 * A stored revision resolved for the acting account: the lasting entry point the preview (FL-96)
 * and render (FL-95) paths call instead of accepting a graph from a request body.
 */
export type StudioRevisionAuthorization = {
  project: StudioProject;
  access: StudioProjectAccess;
  revision: StudioProjectRevision;
  envelope: StudioProjectEnvelope;
  manifest: StudioAuthorizedManifest;
  refused: StudioRefusedReference[];
  /** True when an unexpired manifest for the same project, revision, account and destination was reused. */
  cached: boolean;
};

type CachedResolution = { manifest: StudioAuthorizedManifest; refused: StudioRefusedReference[] };

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const asRequiredIso = (value: Date | string): string => asIso(value) as string;

const envelopeOf = (revision: Pick<StudioProjectRevision, 'envelope'>): StudioProjectEnvelope =>
  revision.envelope as unknown as StudioProjectEnvelope;

/**
 * Studio projects: storage, autosave, history, leases and review (FL-89, `STU-202`).
 *
 * Access is decided once per request from the project row and the acting account, never from a
 * client claim:
 *
 * - The owner may write. Nobody else, not an administrator and not a shared-space editor, ever
 *   writes to a project; the space grants review only.
 * - A member of the project's shared space may read and comment. Membership is the live
 *   `album_user` row, so leaving or being removed from the space revokes access on the next call.
 * - Anybody else, and any shared-link session, gets `404`: the same answer as for a project that
 *   does not exist, which is the only honest answer about somebody else's work.
 *
 * Saving never inspects the graph beyond its shape and size (the storage boundary), so a graph
 * that references Locked, sensitive or hidden media the owner holds is stored and restorable like
 * any other; access to those sources is decided where the graph is *executed*, by the resource
 * resolver, for the account doing the executing. Review reads fail closed: a reviewer for whom any
 * referenced source is unavailable is shown that the graph exists and nothing else.
 */
@Injectable()
export class StudioProjectService {
  private manifests = new Map<string, CachedResolution>();
  private listeners: StudioRevisionListener[] = [];

  constructor(
    private logger: LoggingRepository,
    private repository: StudioProjectRepository,
    private access: AccessRepository,
    private resources: StudioResourceService,
  ) {
    this.logger.setContext(StudioProjectService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Integration seams                                                    */
  /* ------------------------------------------------------------------ */

  /** Subscribe to revision commits. Listener failures are logged and never fail the save. */
  registerRevisionListener(listener: StudioRevisionListener): void {
    this.listeners.push(listener);
  }

  /**
   * The head revision number of a project the account may read right now, or null when it may
   * not (or the project is gone). FL-96 calls this on every preview frame read, so a reviewer
   * who leaves the space, or a project that is deleted, stops receiving frames at once, and a
   * frame rendered for an earlier revision is refused. Reads one row; no graph, no resolution.
   */
  async getReadableRevision(projectId: string, userId: string): Promise<number | null> {
    const project = await this.repository.getById(projectId);
    if (!project || project.deletedAt) {
      // A trashed project previews nothing, for its owner included (FL-91).
      return null;
    }
    const reviewable = !project.archivedAt && !!project.spaceId && (await this.isSpaceMember(userId, project.spaceId));
    if (project.ownerId !== userId && !reviewable) {
      return null;
    }
    return project.currentRevision;
  }

  /**
   * Resolve a stored revision for the acting account and destination.
   *
   * The graph comes from storage, never from the request, and an unexpired manifest for the same
   * project, revision, account and destination is reused rather than minted again, so a preview
   * keyed by manifest digest is not superseded by a second identical resolution. A cloud
   * destination is never cached: consent is recorded per job, so each job resolves afresh.
   */
  async authorizeRevision(
    auth: AuthDto,
    options: { projectId: string; revision?: number; destination?: StudioDestination; cloudConsent?: boolean },
  ): Promise<StudioRevisionAuthorization> {
    const { project, access } = await this.findAccessible(auth, options.projectId);
    if (project.deletedAt) {
      // Nothing is previewed, rendered or exported from a project its owner has thrown away.
      throw this.conflict('project-trashed', 'This project is in the trash; restore it first');
    }
    const number = options.revision ?? project.currentRevision;
    const revision = number > 0 ? await this.repository.getRevision(project.id, number) : undefined;
    if (!revision) {
      throw new NotFoundException('Studio project revision not found');
    }

    const destination = options.destination ?? StudioDestination.Local;
    const resolution = await this.resolve(auth, project, revision, destination, options.cloudConsent);

    return {
      project,
      access,
      revision,
      envelope: envelopeOf(revision),
      manifest: resolution.manifest,
      refused: resolution.refused,
      cached: resolution.cached,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Projects                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The project library (FL-91): one shelf at a time. The active shelf includes projects shared
   * with a space the account belongs to; the archive and the trash hold the account's own only.
   */
  async search(auth: AuthDto, dto: StudioProjectLibrarySearchDto): Promise<StudioProjectListResponseDto> {
    this.requireInteractive(auth);
    const { items, total } = await this.repository.listVisible(auth.user.id, {
      take: dto.take ?? DEFAULT_TAKE,
      skip: dto.skip ?? 0,
      state: dto.shelf ?? 'active',
      query: dto.query ?? null,
      sort: dto.sort ?? 'updated',
    });

    return {
      items: items.map((project) =>
        this.mapProject(project, project.ownerId === auth.user.id ? 'owner' : 'reviewer', auth.user.id, null),
      ),
      total,
    };
  }

  async create(auth: AuthDto, dto: StudioProjectCreateDto): Promise<StudioProjectDetailDto> {
    this.requireInteractive(auth);

    if (dto.spaceId) {
      await this.assertSpaceUsable(auth, dto.spaceId);
    }

    let project = await this.repository.create({ ownerId: auth.user.id, name: dto.name, spaceId: dto.spaceId ?? null });

    const leased = await this.repository.acquireLease(project.id, {
      userId: auth.user.id,
      clientId: dto.clientId,
      leaseMs: STUDIO_LEASE_MS,
      takeover: false,
    });
    project = leased ?? project;

    if (dto.envelope) {
      await this.save(auth, project.id, {
        clientId: dto.clientId,
        requestKey: dto.requestKey ?? `create:${project.id}`,
        expectedRevision: 0,
        envelope: dto.envelope,
      });
    }

    this.logger.log(`Studio project ${project.id} created`);
    return this.get(auth, project.id, dto.clientId);
  }

  async get(auth: AuthDto, id: string, clientId: string | null = null): Promise<StudioProjectDetailDto> {
    const { project, access } = await this.findAccessible(auth, id);
    const head =
      project.currentRevision > 0 ? await this.repository.getRevision(project.id, project.currentRevision) : undefined;

    if (!head) {
      return {
        ...this.mapProject(project, access, auth.user.id, clientId),
        envelope: null,
        digest: null,
        withheld: false,
        resources: null,
      };
    }

    const exposure = await this.decideExposure(auth, project, access, head);
    return {
      ...this.mapProject(project, access, auth.user.id, clientId),
      envelope: exposure.withheld ? null : (envelopeOf(head) as StudioProjectDetailDto['envelope']),
      digest: exposure.withheld ? null : head.digest,
      withheld: exposure.withheld,
      resources: exposure.resources,
    };
  }

  /**
   * Rename, share for review, archive or bring back, and choose a poster. Owner only.
   *
   * A trashed project changes nothing until it is restored. Archiving drops the write lease, so an
   * editor still open on the project turns read-only at its next renewal rather than writing to a
   * project its owner put away. The poster is a reference to library media the owner may read now,
   * checked through the same resolver a render uses, so nothing Locked, trashed or hidden becomes
   * the face of a project.
   */
  async update(auth: AuthDto, id: string, dto: StudioProjectUpdateDto): Promise<StudioProjectDto> {
    const { project } = await this.requireOwner(auth, id);
    if (project.deletedAt) {
      throw this.conflict('project-trashed', 'This project is in the trash; restore it before changing it');
    }

    if (dto.spaceId) {
      await this.assertSpaceUsable(auth, dto.spaceId);
    }
    if (dto.thumbnailAssetId) {
      await this.assertPosterUsable(auth, project, dto.thumbnailAssetId);
    }

    const archivedAt =
      dto.archived === undefined ? undefined : dto.archived ? (project.archivedAt ?? new Date()) : null;

    const updated = await this.repository.update(project.id, {
      name: dto.name,
      spaceId: dto.spaceId,
      archivedAt,
      thumbnailAssetId: dto.thumbnailAssetId,
    });
    if (!updated) {
      throw new NotFoundException('Studio project not found');
    }

    let after = updated;
    if (dto.archived === true && !project.archivedAt) {
      await this.repository.clearLease(project.id);
      after = { ...updated, leaseHolderId: null, leaseClientId: null, leaseExpiresAt: null };
      this.logger.log(`Studio project ${project.id} archived by its owner`);
    }

    if ((dto.spaceId !== undefined && dto.spaceId !== project.spaceId) || dto.archived !== undefined) {
      // The audience changed, so nothing resolved for the old one may be reused.
      this.forgetManifests(project.id);
    }

    return this.mapProject(after, 'owner', auth.user.id, null);
  }

  /**
   * Move a project to the trash, or delete it for good when `permanent` is set.
   *
   * Either way only the project goes: its history, its comments and its references. No library
   * asset is touched, whatever the project used, because a project never owns media. A trashed
   * project is restorable until `purgeAfter`; the lifecycle sweep deletes it after that.
   */
  async remove(auth: AuthDto, id: string, dto: StudioProjectDeleteQueryDto = {}): Promise<void> {
    const { project } = await this.requireOwner(auth, id);
    this.forgetManifests(project.id);

    if (dto.permanent) {
      await this.repository.delete(project.id);
      this.logger.log(`Studio project ${project.id} deleted for good by its owner`);
      return;
    }

    await this.repository.trash(project.id, studioPurgeAfter());
    this.logger.log(`Studio project ${project.id} moved to the trash by its owner`);
  }

  /** Bring a project back from the trash to the shelf it was on. Idempotent for a live project. */
  async restoreFromTrash(auth: AuthDto, id: string): Promise<StudioProjectDto> {
    const { project } = await this.requireOwner(auth, id);
    if (!project.deletedAt) {
      return this.mapProject(project, 'owner', auth.user.id, null);
    }
    const restored = (await this.repository.untrash(project.id)) ?? (await this.repository.getById(project.id));
    if (!restored) {
      throw new NotFoundException('Studio project not found');
    }
    this.logger.log(`Studio project ${project.id} restored from the trash`);
    return this.mapProject(restored, 'owner', auth.user.id, null);
  }

  /** Delete every project in the account's trash for good. Library media is never touched. */
  async emptyTrash(auth: AuthDto): Promise<StudioProjectTrashEmptyResponseDto> {
    this.requireInteractive(auth);
    const count = await this.repository.emptyTrash(auth.user.id);
    if (count > 0) {
      this.logger.log(`Studio trash emptied: ${count} projects deleted for good`);
    }
    return { count };
  }

  /**
   * A new project of the owner's whose revision 1 is this project's head, byte for byte. The copy
   * is not shared with the original's space: review is something the owner grants per project.
   */
  async duplicate(auth: AuthDto, id: string, dto: StudioProjectDuplicateDto): Promise<StudioProjectDto> {
    const { project } = await this.requireOwner(auth, id);
    if (project.deletedAt) {
      throw this.conflict('project-trashed', 'This project is in the trash; restore it before duplicating it');
    }

    const name = dto.name ?? project.name;
    const head =
      project.currentRevision > 0 ? await this.repository.getRevision(project.id, project.currentRevision) : undefined;

    if (!head) {
      const created = await this.repository.create({ ownerId: auth.user.id, name });
      const linked = (await this.repository.update(created.id, { duplicatedFromId: project.id })) ?? created;
      return this.mapProject(linked, 'owner', auth.user.id, null);
    }

    const { project: copy } = await this.repository.createWithRevision({
      ownerId: auth.user.id,
      name,
      duplicatedFromId: project.id,
      revision: {
        authorId: auth.user.id,
        envelope: head.envelope,
        digest: head.digest,
        graphBytes: head.graphBytes,
        summary: { counts: { 'project.duplicate': 1 }, total: 1 },
        requestKey: `duplicate:${project.id}:${head.revision}`,
      },
    });

    this.logger.log(`Studio project ${project.id} duplicated as ${copy.id}`);
    return this.mapProject(copy, 'owner', auth.user.id, null);
  }

  /* ------------------------------------------------------------------ */
  /* Lease                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Take or renew the write lease for one editor instance.
   *
   * Acquire and renew are the same call: a client that holds the lease extends it, a client
   * that finds it free or lapsed takes it, and a client that finds it live and somebody else's
   * is refused with the expiry so the person can wait or explicitly take over. Takeover is never
   * implied by a retry; the client must send `takeover: true`, which the interface shows only
   * after the person chose it.
   */
  async acquireLease(auth: AuthDto, id: string, dto: StudioProjectLeaseRequestDto): Promise<StudioProjectLeaseDto> {
    const { project } = await this.requireOwner(auth, id);
    this.assertEditable(project);

    const leased = await this.repository.acquireLease(project.id, {
      userId: auth.user.id,
      clientId: dto.clientId,
      leaseMs: STUDIO_LEASE_MS,
      takeover: dto.takeover === true,
    });

    if (!leased) {
      const current = (await this.repository.getById(project.id)) ?? project;
      throw this.conflict('lease-held', 'Another editor instance holds the write lease for this project', {
        lease: this.mapLease(current, auth.user.id, dto.clientId),
      });
    }

    if (dto.takeover) {
      this.logger.log(`Studio project ${project.id} lease taken over by client ${dto.clientId}`);
    }
    return this.mapLease(leased, auth.user.id, dto.clientId);
  }

  async releaseLease(auth: AuthDto, id: string, dto: StudioProjectLeaseRequestDto): Promise<void> {
    const { project } = await this.requireOwner(auth, id);
    await this.repository.releaseLease(project.id, auth.user.id, dto.clientId);
  }

  /* ------------------------------------------------------------------ */
  /* Save, restore, history                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Autosave: store a complete document as the next revision.
   *
   * Decided in this order, so the client hears the true reason:
   *
   *   1. shape        — the envelope is not one this server stores
   *   2. idempotency  — this request key was already answered; same digest replays, a different
   *                     digest under the same key is a client bug and is refused
   *   3. head         — the client saved against an older head; the current one is returned
   *   4. lease        — this client does not hold a live lease
   *   5. no-op        — the document equals the head; nothing is written
   *
   * The append itself is one conditional transaction in the repository, so a race that slips past
   * these reads is still decided in Postgres, and the loser is re-read and answered with the same
   * reasons.
   */
  async save(auth: AuthDto, id: string, dto: StudioProjectSaveDto): Promise<StudioProjectSaveResponseDto> {
    const { project } = await this.requireOwner(auth, id);

    const checked = checkStudioEnvelope(dto.envelope);
    if (!checked.ok) {
      throw new BadRequestException(checked.detail);
    }
    const digest = studioEnvelopeDigest(checked.envelope);

    const replay = await this.replayIfAnswered(project, dto.requestKey, digest, auth.user.id, dto.clientId);
    if (replay) {
      return replay;
    }

    this.assertEditable(project);
    this.assertHead(project, dto.expectedRevision);
    this.assertLease(project, auth.user.id, dto.clientId);

    const head =
      project.currentRevision > 0 ? await this.repository.getRevision(project.id, project.currentRevision) : undefined;
    if (head && head.digest === digest) {
      return {
        revision: head.revision,
        revisionId: null,
        digest,
        replayed: false,
        unchanged: true,
        lease: this.mapLease(project, auth.user.id, dto.clientId),
      };
    }

    return this.append(auth, project, dto.clientId, {
      expectedRevision: dto.expectedRevision,
      envelope: checked.envelope,
      digest,
      graphBytes: checked.graphBytes,
      summary: normalizeCommandSummary(dto.summary),
      requestKey: dto.requestKey,
      restoredFromRevision: null,
    });
  }

  /**
   * Bring an earlier revision back as a new one.
   *
   * History is append-only: the old revision is copied forward, never edited and never made the
   * head by pointer, so the restore is itself in the history and can be undone by another restore.
   * The same head and lease rules as a save apply, because a restore over somebody's newer work is
   * as much a conflict as any other stale write.
   */
  async restore(auth: AuthDto, id: string, dto: StudioProjectRestoreDto): Promise<StudioProjectSaveResponseDto> {
    const { project } = await this.requireOwner(auth, id);

    const source = await this.repository.getRevision(project.id, dto.revision);
    if (!source) {
      throw this.conflict('revision-missing', `Revision ${dto.revision} does not exist`, {
        currentRevision: project.currentRevision,
      });
    }

    const replay = await this.replayIfAnswered(project, dto.requestKey, source.digest, auth.user.id, dto.clientId);
    if (replay) {
      return replay;
    }

    this.assertEditable(project);
    this.assertHead(project, dto.expectedRevision);
    this.assertLease(project, auth.user.id, dto.clientId);

    if (source.revision === project.currentRevision) {
      return {
        revision: source.revision,
        revisionId: null,
        digest: source.digest,
        replayed: false,
        unchanged: true,
        lease: this.mapLease(project, auth.user.id, dto.clientId),
      };
    }

    return this.append(auth, project, dto.clientId, {
      expectedRevision: dto.expectedRevision,
      envelope: envelopeOf(source),
      digest: source.digest,
      graphBytes: source.graphBytes,
      summary: { counts: { 'history.restore': 1 }, total: 1 },
      requestKey: dto.requestKey,
      restoredFromRevision: source.revision,
    });
  }

  async getHistory(auth: AuthDto, id: string, dto: StudioProjectSearchDto): Promise<StudioProjectHistoryResponseDto> {
    const { project, access } = await this.findAccessible(auth, id);
    const { items, total } = await this.repository.listRevisions(project.id, {
      take: dto.take ?? DEFAULT_TAKE,
      skip: dto.skip ?? 0,
    });

    return { items: items.map((item) => this.mapRevision(item, access)), total };
  }

  async getRevision(auth: AuthDto, id: string, number: number): Promise<StudioProjectRevisionDetailDto> {
    const { project, access } = await this.findAccessible(auth, id);
    const revision = await this.repository.getRevision(project.id, number);
    if (!revision) {
      throw new NotFoundException('Studio project revision not found');
    }

    const exposure = await this.decideExposure(auth, project, access, revision);
    return {
      ...this.mapRevision(revision, access),
      digest: exposure.withheld ? null : revision.digest,
      envelope: exposure.withheld ? null : (envelopeOf(revision) as StudioProjectRevisionDetailDto['envelope']),
      withheld: exposure.withheld,
      resources: exposure.resources,
    };
  }

  /**
   * What changed between two revisions, as paths and counts.
   *
   * No value from either graph is returned, so the diff reveals structure and nothing private.
   * A reviewer still gets it only when the later revision is fully resolvable for them, the same
   * rule that governs whether they may see that graph at all.
   */
  async diff(auth: AuthDto, id: string, number: number, against: number): Promise<StudioProjectDiffDto> {
    const { project, access } = await this.findAccessible(auth, id);
    if (against >= number) {
      throw new BadRequestException('`against` must be an earlier revision than the one being compared');
    }

    const [from, to] = await Promise.all([
      this.repository.getRevision(project.id, against),
      this.repository.getRevision(project.id, number),
    ]);
    if (!from || !to) {
      throw new NotFoundException('Studio project revision not found');
    }

    const exposure = await this.decideExposure(auth, project, access, to);
    if (exposure.withheld) {
      throw new ForbiddenException('This revision references a source that is not available to you');
    }

    const between = await this.repository.listRevisionSummariesBetween(project.id, from.revision, to.revision);
    const graphDiff = diffStudioGraphs(envelopeOf(from).graph, envelopeOf(to).graph);

    return {
      from: from.revision,
      to: to.revision,
      identical: from.digest === to.digest,
      byteDelta: to.graphBytes - from.graphBytes,
      added: graphDiff.added,
      removed: graphDiff.removed,
      changed: graphDiff.changed,
      paths: graphDiff.paths,
      truncated: graphDiff.truncated,
      commands: mergeCommandSummaries(between.map((item) => item.summary)),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Review comments                                                      */
  /* ------------------------------------------------------------------ */

  async getComments(auth: AuthDto, id: string, dto: StudioProjectSearchDto): Promise<StudioCommentListResponseDto> {
    const { project } = await this.findAccessible(auth, id);
    const { items, total } = await this.repository.listComments(project.id, {
      take: dto.take ?? DEFAULT_TAKE,
      skip: dto.skip ?? 0,
    });
    return { items: items.map((item) => this.mapComment(item)), total };
  }

  /** Owner and reviewers may comment. No lease: a comment is not a change to the document. */
  async addComment(auth: AuthDto, id: string, dto: StudioCommentCreateDto): Promise<StudioCommentDto> {
    const { project } = await this.findAccessible(auth, id);
    if (project.deletedAt) {
      throw this.conflict('project-trashed', 'This project is in the trash; restore it before commenting');
    }

    const time = normalizeStudioTime(dto.time);
    if (!time) {
      throw new BadRequestException('A comment time must be a non-negative fraction of safe integers');
    }
    if (dto.revision > project.currentRevision) {
      throw new BadRequestException(`Revision ${dto.revision} does not exist yet`);
    }

    if (dto.requestKey) {
      const existing = await this.repository.getCommentByRequestKey(project.id, dto.requestKey);
      if (existing) {
        return this.mapComment(existing);
      }
    }

    const created = await this.repository.createComment({
      projectId: project.id,
      authorId: auth.user.id,
      revision: dto.revision,
      timeNum: time.num,
      timeDen: time.den,
      text: dto.text,
      requestKey: dto.requestKey ?? null,
    });

    if (!created) {
      // A concurrent retry with the same key won the insert; answer with its row.
      const existing = await this.repository.getCommentByRequestKey(project.id, dto.requestKey as string);
      if (!existing) {
        throw new ConflictException('The comment could not be recorded');
      }
      return this.mapComment(existing);
    }

    return this.mapComment(created);
  }

  /** The author edits the text; the author or the owner resolves. */
  async updateComment(
    auth: AuthDto,
    id: string,
    commentId: string,
    dto: StudioCommentUpdateDto,
  ): Promise<StudioCommentDto> {
    const { project, access } = await this.findAccessible(auth, id);
    const comment = await this.repository.getComment(project.id, commentId);
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const isAuthor = comment.authorId === auth.user.id;
    if (dto.text !== undefined && !isAuthor) {
      throw new ForbiddenException('Only the author can edit a comment');
    }
    if (dto.resolved !== undefined && !isAuthor && access !== 'owner') {
      throw new ForbiddenException('Only the author or the project owner can resolve a comment');
    }

    const updated = await this.repository.updateComment(project.id, comment.id, {
      text: dto.text,
      resolvedById: dto.resolved === undefined ? undefined : dto.resolved ? auth.user.id : null,
    });
    if (!updated) {
      throw new NotFoundException('Comment not found');
    }
    return this.mapComment(updated);
  }

  async removeComment(auth: AuthDto, id: string, commentId: string): Promise<void> {
    const { project, access } = await this.findAccessible(auth, id);
    const comment = await this.repository.getComment(project.id, commentId);
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.authorId !== auth.user.id && access !== 'owner') {
      throw new ForbiddenException('Only the author or the project owner can remove a comment');
    }
    await this.repository.deleteComment(project.id, comment.id);
  }

  /* ------------------------------------------------------------------ */
  /* Access                                                               */
  /* ------------------------------------------------------------------ */

  private requireInteractive(auth: AuthDto): void {
    if (auth.sharedLink) {
      // A shared link is a viewing credential for specific media, never a Studio session.
      throw new NotFoundException('Studio project not found');
    }
  }

  private async findAccessible(
    auth: AuthDto,
    id: string,
  ): Promise<{ project: StudioProject; access: StudioProjectAccess }> {
    this.requireInteractive(auth);

    const project = await this.repository.getById(id);
    if (!project) {
      throw new NotFoundException('Studio project not found');
    }
    if (project.ownerId === auth.user.id) {
      return { project, access: 'owner' };
    }
    // An archived or trashed project is off the shelf for everybody but its owner (FL-91).
    const onShelf = !project.deletedAt && !project.archivedAt;
    if (onShelf && project.spaceId && (await this.isSpaceMember(auth.user.id, project.spaceId))) {
      return { project, access: 'reviewer' };
    }

    // Somebody else's project and a project that never existed give the same answer on purpose.
    throw new NotFoundException('Studio project not found');
  }

  private async requireOwner(auth: AuthDto, id: string): Promise<{ project: StudioProject }> {
    const { project, access } = await this.findAccessible(auth, id);
    if (access !== 'owner') {
      throw new ForbiddenException('Only the owner can change a Studio project');
    }
    return { project };
  }

  /** The live `album_user` row, owner role included. Re-read on every call, never cached. */
  private async isSpaceMember(userId: string, spaceId: string): Promise<boolean> {
    const ids = new Set([spaceId]);
    const [owned, shared] = await Promise.all([
      this.access.album.checkOwnerAccess(userId, ids),
      this.access.album.checkSharedAlbumAccess(userId, ids, AlbumUserRole.Viewer),
    ]);
    return owned.has(spaceId) || shared.has(spaceId);
  }

  /** A project may be shared only into a live shared space the owner belongs to. */
  private async assertSpaceUsable(auth: AuthDto, spaceId: string): Promise<void> {
    const space = await this.repository.getSpace(spaceId);
    if (!space || space.deletedAt || space.kind !== AlbumKind.Space) {
      throw new BadRequestException('A project can only be shared with a shared space');
    }
    if (!(await this.isSpaceMember(auth.user.id, spaceId))) {
      throw new BadRequestException('You are not a member of that shared space');
    }
  }

  /** Writes to the document itself: refused in the trash and in the archive (FL-91). */
  private assertEditable(project: StudioProject): void {
    if (project.deletedAt) {
      throw this.conflict('project-trashed', 'This project is in the trash; restore it before editing', {
        currentRevision: project.currentRevision,
      });
    }
    if (project.archivedAt) {
      throw this.conflict('project-archived', 'This project is archived; bring it back before editing', {
        currentRevision: project.currentRevision,
      });
    }
  }

  /**
   * A poster must be library media the owner could place in the project right now, decided by the
   * FL-90 resolver for this session: Locked, trashed, offline and hidden media are all refused.
   */
  private async assertPosterUsable(auth: AuthDto, project: StudioProject, assetId: string): Promise<void> {
    const { manifest } = await this.resources.resolveProjectResources(auth, {
      projectId: project.id,
      ownerId: project.ownerId,
      revision: project.currentRevision,
      graph: { poster: { assetId } },
      destination: StudioDestination.Local,
    });
    const usable = manifest.entries.some(
      (entry) => entry.kind === StudioResourceKind.LibraryAsset && entry.id === assetId,
    );
    if (!manifest.complete || !usable) {
      throw new BadRequestException('That item cannot be used as the poster for this project');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Save machinery                                                       */
  /* ------------------------------------------------------------------ */

  private async replayIfAnswered(
    project: StudioProject,
    requestKey: string,
    digest: string,
    userId: string,
    clientId: string,
  ): Promise<StudioProjectSaveResponseDto | null> {
    const existing = await this.repository.getRevisionByRequestKey(project.id, requestKey);
    if (!existing) {
      return null;
    }
    if (existing.digest !== digest) {
      throw this.conflict('request-key-reused', 'This request key was already used for a different document', {
        currentRevision: project.currentRevision,
      });
    }
    return {
      revision: existing.revision,
      revisionId: existing.id,
      digest: existing.digest,
      replayed: true,
      unchanged: false,
      lease: this.mapLease(project, userId, clientId),
    };
  }

  private assertHead(project: StudioProject, expectedRevision: number): void {
    if (project.currentRevision !== expectedRevision) {
      throw this.conflict('stale-revision', 'This project changed elsewhere; reload it before saving', {
        currentRevision: project.currentRevision,
      });
    }
  }

  private assertLease(project: StudioProject, userId: string, clientId: string): void {
    const lease = this.mapLease(project, userId, clientId);
    if (!lease.heldByYou) {
      throw this.conflict(
        'lease-lost',
        lease.heldByAnother
          ? 'Another editor instance holds the write lease for this project'
          : 'Your write lease has lapsed; take it again before saving',
        { currentRevision: project.currentRevision, lease },
      );
    }
  }

  private async append(
    auth: AuthDto,
    project: StudioProject,
    clientId: string,
    input: {
      expectedRevision: number;
      envelope: StudioProjectEnvelope;
      digest: string;
      graphBytes: number;
      summary: Record<string, unknown>;
      requestKey: string;
      restoredFromRevision: number | null;
    },
  ): Promise<StudioProjectSaveResponseDto> {
    const result = await this.repository.appendRevision({
      projectId: project.id,
      expectedRevision: input.expectedRevision,
      authorId: auth.user.id,
      leaseClientId: clientId,
      leaseMs: STUDIO_LEASE_MS,
      envelope: input.envelope as unknown as Record<string, unknown>,
      digest: input.digest,
      graphBytes: input.graphBytes,
      summary: input.summary,
      requestKey: input.requestKey,
      restoredFromRevision: input.restoredFromRevision,
    });

    if (result.status === 'appended') {
      this.forgetManifests(project.id);
      const after = (await this.repository.getById(project.id)) ?? project;
      await this.notify({
        projectId: project.id,
        ownerId: project.ownerId,
        revision: result.revision.revision,
        digest: result.revision.digest,
        restoredFromRevision: result.revision.restoredFromRevision,
      });
      return {
        revision: result.revision.revision,
        revisionId: result.revision.id,
        digest: result.revision.digest,
        replayed: false,
        unchanged: false,
        lease: this.mapLease(after, auth.user.id, clientId),
      };
    }

    // The conditional write lost a race. Re-read and report what actually happened.
    const current = await this.repository.getById(project.id);
    if (!current) {
      throw new NotFoundException('Studio project not found');
    }

    if (result.status === 'duplicate-key') {
      const replay = await this.replayIfAnswered(current, input.requestKey, input.digest, auth.user.id, clientId);
      if (replay) {
        return replay;
      }
    }

    this.assertHead(current, input.expectedRevision);
    this.assertLease(current, auth.user.id, clientId);
    // Both guards passed on the re-read, so the loss was momentary; the client's retry with the
    // same key is the right recovery, and it is told so as a lease conflict it can re-acquire.
    throw this.conflict('lease-lost', 'The save was interrupted; try again', {
      currentRevision: current.currentRevision,
      lease: this.mapLease(current, auth.user.id, clientId),
    });
  }

  private async notify(event: StudioRevisionEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.warn(`Studio revision listener failed for project ${event.projectId}: ${error}`);
      }
    }
  }

  private conflict(
    reason: StudioConflictReason,
    message: string,
    extra: Partial<Pick<StudioConflictBody, 'currentRevision' | 'lease'>> = {},
  ): ConflictException {
    const body: StudioConflictBody = { statusCode: 409, error: 'Conflict', message, reason, ...extra };
    return new ConflictException(body);
  }

  /* ------------------------------------------------------------------ */
  /* Resolution and exposure                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Whether the acting account may see this graph.
   *
   * The owner always may; the document is theirs. A reviewer may only when every source resolves
   * for them right now: a trashed, relocked, unshared or replaced source withholds the whole graph
   * and its digest rather than showing a version with holes.
   */
  private async decideExposure(
    auth: AuthDto,
    project: StudioProject,
    access: StudioProjectAccess,
    revision: StudioProjectRevision,
  ): Promise<{ withheld: boolean; resources: StudioProjectResourcesDto }> {
    const resolution = await this.resolve(auth, project, revision, StudioDestination.Local);
    const resources: StudioProjectResourcesDto = {
      complete: resolution.manifest.complete,
      refusedCount: resolution.manifest.refusedCount,
      checkedAt: resolution.manifest.issuedAt,
    };
    return { withheld: access === 'reviewer' && !resolution.manifest.complete, resources };
  }

  private async resolve(
    auth: AuthDto,
    project: StudioProject,
    revision: StudioProjectRevision,
    destination: StudioDestination,
    cloudConsent?: boolean,
  ): Promise<CachedResolution & { cached: boolean }> {
    const cacheable = destination !== StudioDestination.FrameleafCloud;
    const key = `${project.id}:${revision.revision}:${auth.user.id}:${destination}`;
    const now = Date.now();

    if (cacheable) {
      const hit = this.manifests.get(key);
      if (hit && new Date(hit.manifest.expiresAt).getTime() > now) {
        return { ...hit, cached: true };
      }
    }

    const resolution = await this.resources.resolveProjectResources(auth, {
      projectId: project.id,
      ownerId: project.ownerId,
      revision: revision.revision,
      graph: envelopeOf(revision).graph,
      destination,
      cloudConsent,
    });

    if (cacheable) {
      if (this.manifests.size >= MANIFEST_CACHE_LIMIT) {
        this.pruneManifests(now);
      }
      this.manifests.set(key, resolution);
    }

    return { ...resolution, cached: false };
  }

  /**
   * FL-90: drop every cached resolution of these projects, so the next read resolves the sources
   * again rather than trusting a manifest issued before access changed.
   */
  forgetResolutions(projectIds: readonly string[]): void {
    for (const projectId of projectIds) {
      this.forgetManifests(projectId);
    }
  }

  private forgetManifests(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const key of this.manifests.keys()) {
      if (key.startsWith(prefix)) {
        this.manifests.delete(key);
      }
    }
  }

  private pruneManifests(now: number): void {
    for (const [key, entry] of this.manifests) {
      if (new Date(entry.manifest.expiresAt).getTime() <= now) {
        this.manifests.delete(key);
      }
    }
    if (this.manifests.size >= MANIFEST_CACHE_LIMIT) {
      // Still full of live entries: drop the oldest inserted, which Map iteration yields first.
      const oldest = this.manifests.keys().next().value;
      if (oldest !== undefined) {
        this.manifests.delete(oldest);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mapping                                                              */
  /* ------------------------------------------------------------------ */

  private mapLease(
    project: StudioProject,
    userId: string,
    clientId: string | null,
    now = new Date(),
  ): StudioProjectLeaseDto {
    const held = isStudioLeaseHeld(
      { holderId: project.leaseHolderId, holderSessionId: project.leaseClientId, expiresAt: project.leaseExpiresAt },
      now,
    );
    const heldByYou =
      held && project.leaseHolderId === userId && clientId !== null && project.leaseClientId === clientId;
    return {
      heldByYou,
      heldByAnother: held && !heldByYou,
      expiresAt: held ? asIso(project.leaseExpiresAt) : null,
      leaseMs: STUDIO_LEASE_MS,
      renewMs: STUDIO_LEASE_RENEW_MS,
      autosaveDebounceMs: STUDIO_AUTOSAVE_DEBOUNCE_MS,
    };
  }

  private mapProject(
    project: StudioProject,
    access: StudioProjectAccess,
    userId: string,
    clientId: string | null,
  ): StudioProjectDto {
    // Lineage, recents and the poster are the owner's library furniture; a reviewer sees none of it.
    const isOwner = access === 'owner';
    return {
      id: project.id,
      ownerId: project.ownerId,
      name: project.name,
      spaceId: project.spaceId,
      revision: project.currentRevision,
      access,
      lease: this.mapLease(project, userId, clientId),
      shelf: studioProjectShelf(project),
      archivedAt: asIso(project.archivedAt),
      deletedAt: asIso(project.deletedAt),
      purgeAfter: asIso(project.purgeAfter),
      lastOpenedAt: isOwner ? asIso(project.lastOpenedAt) : null,
      thumbnailAssetId: isOwner ? project.thumbnailAssetId : null,
      duplicatedFromId: isOwner ? project.duplicatedFromId : null,
      importedFromBundle: isOwner && !!project.importedFromDigest,
      createdAt: asRequiredIso(project.createdAt),
      updatedAt: asRequiredIso(project.updatedAt),
    };
  }

  private mapRevision(revision: StudioProjectRevisionSummary, access: StudioProjectAccess): StudioProjectRevisionDto {
    return {
      id: revision.id,
      revision: revision.revision,
      authorId: revision.authorId,
      // The digest travels with the graph: a reviewer who may not see the graph does not get it.
      digest: access === 'owner' ? revision.digest : null,
      graphBytes: revision.graphBytes,
      summary: normalizeCommandSummary(revision.summary),
      restoredFromRevision: revision.restoredFromRevision,
      createdAt: asRequiredIso(revision.createdAt),
    };
  }

  private mapComment(comment: StudioProjectComment): StudioCommentDto {
    return {
      id: comment.id,
      projectId: comment.projectId,
      authorId: comment.authorId,
      revision: comment.revision,
      time: { num: Number(comment.timeNum), den: Number(comment.timeDen) },
      text: comment.text,
      resolvedAt: asIso(comment.resolvedAt),
      resolvedById: comment.resolvedById,
      createdAt: asRequiredIso(comment.createdAt),
      updatedAt: asRequiredIso(comment.updatedAt),
    };
  }
}
