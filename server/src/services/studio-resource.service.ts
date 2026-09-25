/**
 * Studio project resource resolver (FL-90 / STU-203).
 *
 * Given a project graph and the acting user, resolve every reference the graph makes through the
 * existing access checks and return an authorized manifest plus the references that were refused,
 * each with a reason. The render (FL-95) and preview (FL-96) paths accept only a manifest this
 * service issued, verified by {@link StudioResourceService.assertAuthorizedManifest}, and read
 * source bytes only through grants from {@link StudioResourceService.issueReadGrants}, verified
 * on every open by {@link StudioResourceService.verifyReadGrant}.
 *
 * Rules this service enforces, from `03-studio-rendering-and-restoration.md` and the data and
 * security invariants in `01-agent-execution.md`:
 *
 * - Access is decided for the acting user, never inherited from the project owner. A project
 *   shared with a reviewer resolves the reviewer's access; sources they cannot see are refused.
 *   Project sharing therefore never grants original access.
 * - Locked media never enters Studio through the interactive path, even for an elevated session.
 *   A background runner (FL-95) resolving a job the owner already submitted says so explicitly
 *   with `backgroundRunner` and reads the Locked sources that job references. Trashed and offline originals
 *   are refused. The acting user's sensitive and suppressed content settings apply through the
 *   same `checkAccess` the library uses.
 * - Nothing about an asset is reported before its access check. An asset the acting user cannot
 *   read is refused exactly like a missing one, and `locked` is reported only to the asset's owner
 *   in an elevated session (FL-34).
 * - Cloud is never a fallback. A RunPod destination without explicit consent fails before a single
 *   reference is enumerated, and nothing is uploaded.
 * - The graph is bounded before it is walked, and URLs, blob strings, host paths and traversal
 *   sequences are refused wherever they appear. Only resource ids reach a worker.
 * - Grants are short-lived, bound to the project revision, the owner, the checksum, the acting
 *   user and the worker, and re-checked against live access on every use. Access loss, trashing,
 *   checksum replacement or a new revision invalidates them; the manifest cache key changes with
 *   the revision and the manifest digest, so stale preview and cache entries stop matching.
 *
 * Manifests and grants are signed with a per-process secret, like the workflow execution
 * service's tokens. A manifest therefore proves authorization to the process that issued it; a
 * job that runs in another process re-resolves at admission and again at publication, which the
 * plan requires anyway. The project repository (FL-89) is not present in this checkout, so the
 * caller supplies the project's declared imports and generated intermediates in the context.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Selectable } from 'kysely';
import { createHmac } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetType, Permission } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { getLockedOwnerId, isLockedAssetRow } from 'src/utils/locked-visibility.js';
import {
  STUDIO_MAX_GRAPH_BYTES,
  StudioAudioSource,
  StudioDestination,
  StudioEgress,
  StudioRefusalReason,
  StudioResourceKind,
  StudioResourceReference,
  checkNestedSequences,
  extractStudioResourceReferences,
  getStudioResourceClass,
  isKnownStudioPreset,
  isStudioDestination,
  isStudioUuid,
  measureStudioGraph,
  studioReferenceKey,
} from 'src/utils/studio-resources.js';
import {
  type StudioRightsCatalog,
  checkStudioProducerRights,
  checkStudioRights,
  studioRightsId,
  studioRightsUseFor,
} from 'src/utils/studio-rights.js';

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

/** A file the project owns: uploaded voiceover, music, still, LUT, caption sidecar or graphic. */
export type StudioDeclaredImport = {
  id: string;
  /** IANA media type recorded at upload. */
  contentType: string;
  /** Checksum recorded at upload, or null when the upload never completed. */
  checksum: string | null;
  sizeBytes: number;
  /** Project-owned storage path; never a library original. */
  path: string;
  /**
   * For SVG and Lottie imports: the number of external subresource references the import scanner
   * found. `undefined` means the file was not scanned, which is refused like a non-zero count.
   */
  externalReferences?: number;
};

/** A derived file the project owns, with the inputs it was produced from. */
export type StudioDeclaredGenerated = {
  id: string;
  /** What produced it: `proxy`, `waveform`, `reverse-conform`, `transcript`, `tts`, `musicgen`, `chunk`. */
  producer: string;
  checksum: string | null;
  path: string;
  /** Reference keys ({@link studioReferenceKey}) of the inputs. Every one must be authorized. */
  derivedFrom: string[];
};

export type StudioCatalogEntry = {
  path: string;
  checksum: string;
  /** Model revision, for the model catalogue. */
  revision?: string;
};

/**
 * What the deployment bundles. Empty by default: a checkout with no fonts, LUTs, tracks or
 * admitted models resolves none, which is the honest answer rather than a placeholder list.
 */
export type StudioResourceCatalog = {
  fonts: Readonly<Record<string, StudioCatalogEntry>>;
  luts: Readonly<Record<string, StudioCatalogEntry>>;
  audio: Readonly<Record<string, StudioCatalogEntry>>;
  models: Readonly<Record<string, StudioCatalogEntry>>;
};

export const emptyStudioResourceCatalog = (): StudioResourceCatalog => ({ fonts: {}, luts: {}, audio: {}, models: {} });

export type StudioProjectResourceContext = {
  projectId: string;
  /** The project owner. Used for ownership of project-scoped resources, never for access. */
  ownerId: string;
  revision: number;
  /** The opaque project graph. */
  graph: unknown;
  imports?: readonly StudioDeclaredImport[];
  generated?: readonly StudioDeclaredGenerated[];
  catalog?: StudioResourceCatalog;
  destination: StudioDestination;
  /** Required, and recorded, when the destination leaves the machine. */
  cloudConsent?: boolean;
  /**
   * Set only by background runners (FL-95 render workers) resolving a job its owner already
   * authorized: Locked sources the graph references are resolved instead of refused, because a
   * backend task must be able to read every asset the job names. The interactive Studio path
   * never sets it, so nothing Locked is shown to, or placed by, a person through Studio.
   */
  backgroundRunner?: boolean;
};

/* ------------------------------------------------------------------ */
/* Outputs                                                              */
/* ------------------------------------------------------------------ */

export type StudioSourceAccess =
  /** The acting user owns the source. */
  | 'owner'
  /** The acting user reaches the source through a shared album or a partner. */
  | 'shared'
  /** The resource belongs to the project. */
  | 'project'
  /** The resource is bundled with, or defined by, the deployment. */
  | 'deployment'
  /** The resource is part of the graph itself. */
  | 'graph';

export type StudioAuthorizedEntry = {
  key: string;
  kind: StudioResourceKind;
  id: string;
  family?: string;
  source?: StudioAudioSource;
  graphPath: string;
  ownerId: string | null;
  checksum: string | null;
  /** Server-side path for the worker read grant; null when there is nothing to read. */
  path: string | null;
  sourceAccess: StudioSourceAccess;
  /** `render` entries receive a worker read grant; nothing ever receives an original-download grant. */
  grant: 'render' | 'none';
};

export type StudioRefusedReference = {
  key: string;
  kind: StudioResourceKind | null;
  id: string;
  graphPath: string;
  reason: StudioRefusalReason;
  detail: string;
};

export const STUDIO_MANIFEST_SCHEMA_VERSION = 1;
/** How long a manifest stays acceptable to the render and preview paths. */
export const STUDIO_MANIFEST_TTL_SECONDS = 10 * 60;
/** Default lifetime of a worker read grant. */
export const STUDIO_GRANT_TTL_SECONDS = 5 * 60;

export type StudioAuthorizedManifest = {
  schemaVersion: typeof STUDIO_MANIFEST_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  userId: string;
  destination: StudioDestination;
  issuedAt: string;
  expiresAt: string;
  /** True when nothing was refused. The render and preview paths accept only complete manifests. */
  complete: boolean;
  refusedCount: number;
  entries: StudioAuthorizedEntry[];
  privacy: {
    /** At least one source reaches the acting user through sharing, so the output inherits that. */
    includesSharedSources: boolean;
    includesPersonalData: boolean;
    /** Always false: a manifest authorizes rendering, never downloading an original. */
    originalAccess: false;
    /** The chosen destination is outside the machine and its network. */
    leavesMachine: boolean;
  };
  /** HMAC over the manifest content; {@link StudioResourceService.assertAuthorizedManifest} verifies it. */
  digest: string;
};

export type StudioResourceResolution = {
  manifest: StudioAuthorizedManifest;
  refused: StudioRefusedReference[];
};

/** Kinds whose access follows the acting user's live access to a library asset. */
const LIBRARY_BACKED_KINDS: ReadonlySet<StudioResourceKind> = new Set([
  StudioResourceKind.LibraryAsset,
  StudioResourceKind.Audio,
  StudioResourceKind.EditedMaster,
]);

export type StudioReadGrantPayload = {
  v: 1;
  scope: 'render' | 'preview';
  kind: StudioResourceKind;
  id: string;
  key: string;
  checksum: string | null;
  ownerId: string | null;
  projectId: string;
  revision: number;
  userId: string;
  workerId: string;
  /** The issuing manifest, so a grant cannot outlive a re-resolution. */
  manifest: string;
  /**
   * Preview grants only: the library assets the previewed revision reads. Every frame read
   * re-checks the acting user's live access to each of them (STU-203), so an asset removed from an
   * album, a deleted or unlinked album, an ended partner share or a member leaving a space stops
   * the preview at the next frame instead of serving a cached one.
   */
  assetIds?: string[];
};

export type StudioReadGrant = {
  key: string;
  kind: StudioResourceKind;
  id: string;
  path: string;
  token: string;
  expiresAt: string;
};

export type StudioGrantVerification =
  | { valid: true; grant: StudioReadGrantPayload; path: string }
  | {
      valid: false;
      reason: StudioRefusalReason | 'expired' | 'invalid-token' | 'worker-mismatch' | 'user-mismatch';
      detail: string;
    };

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

type AssetRow = Pick<
  Selectable<AssetTable>,
  'id' | 'ownerId' | 'type' | 'visibility' | 'deletedAt' | 'isOffline' | 'originalPath' | 'checksum'
> & { isLocked?: boolean | null };

type AssetDecision =
  | { ok: true; asset: AssetRow; sourceAccess: 'owner' | 'shared' }
  | { ok: false; reason: StudioRefusalReason; detail: string };

const timelineTypes = new Set<AssetType>([AssetType.Image, AssetType.Video]);
const editedMasterTypes = new Set<AssetFileType>([AssetFileType.EncodedVideo, AssetFileType.FullSize]);
const vectorContentTypes = new Set([
  'image/svg+xml',
  'application/json',
  'application/zip',
  'application/x-lottie+json',
]);

@Injectable()
export class StudioResourceService extends BaseService {
  #secret: string | null = null;

  private get secret(): string {
    this.#secret ??= this.cryptoRepository.randomBytesAsText(32);
    return this.#secret;
  }

  /**
   * Resolve every resource the graph references for the acting user. Throws only for
   * preconditions that make enumeration itself unsafe (unknown destination, cloud without consent,
   * oversized graph); everything else is a refusal in the result.
   */
  async resolveProjectResources(
    auth: AuthDto,
    context: StudioProjectResourceContext,
  ): Promise<StudioResourceResolution> {
    if (!isStudioDestination(context.destination)) {
      throw new BadRequestException('Unknown Studio destination');
    }

    if (context.destination === StudioDestination.RunPod && context.cloudConsent !== true) {
      throw new BadRequestException(
        'A cloud destination requires explicit consent for this job; nothing was resolved or uploaded.',
      );
    }

    const bytes = measureStudioGraph(context.graph);
    if (bytes > STUDIO_MAX_GRAPH_BYTES) {
      throw new BadRequestException(
        `Project graph is ${bytes} bytes; the limit is ${STUDIO_MAX_GRAPH_BYTES}. Nothing was resolved.`,
      );
    }

    const catalog = context.catalog ?? emptyStudioResourceCatalog();
    // FL-86: a bundled entry is loaded only when its reviewed rights admit this destination's use.
    const rightsUse = studioRightsUseFor(context.destination);
    const imports = new Map((context.imports ?? []).map((item) => [item.id, item]));
    const generated = new Map((context.generated ?? []).map((item) => [item.id, item]));

    const { references, violations, sequences } = extractStudioResourceReferences(context.graph);
    const sequenceCheck = checkNestedSequences(sequences);
    const refusedSequences = new Map(sequenceCheck.refused.map((item) => [item.id, item]));

    const entries: StudioAuthorizedEntry[] = [];
    const refused: StudioRefusedReference[] = Array.from(violations, (violation, index) => ({
      key: `graph:${violation.reason}:${index}`,
      kind: null,
      id: violation.detail,
      graphPath: violation.graphPath,
      reason: violation.reason,
      detail: violation.detail,
    }));

    const refuse = (reference: StudioResourceReference, reason: StudioRefusalReason, detail: string) => {
      refused.push({
        key: studioReferenceKey(reference),
        kind: reference.kind,
        id: reference.id,
        graphPath: reference.graphPath,
        reason,
        detail,
      });
    };
    /** Refuses the reference by its rights row unless the reviewed decision admits the use. */
    const rightsAdmit = (reference: StudioResourceReference, rightsCatalog: StudioRightsCatalog) => {
      const verdict = checkStudioRights(studioRightsId(rightsCatalog, reference.id), rightsUse);
      if (!verdict.allowed) {
        refuse(reference, StudioRefusalReason.RightsBlocked, verdict.detail);
      }
      return verdict.allowed;
    };

    const authorize = (
      reference: StudioResourceReference,
      fields: Pick<StudioAuthorizedEntry, 'ownerId' | 'checksum' | 'path' | 'sourceAccess' | 'grant'>,
    ) => {
      entries.push({
        key: studioReferenceKey(reference),
        kind: reference.kind,
        id: reference.id,
        family: reference.family,
        source: reference.source,
        graphPath: reference.graphPath,
        ...fields,
      });
    };

    // A shared link is a viewing credential for specific assets or an album. It is never a
    // Studio session, so every reference is refused rather than partially resolved.
    if (auth.sharedLink) {
      for (const reference of references) {
        refuse(reference, StudioRefusalReason.SharedLinkSession, 'Shared links cannot resolve Studio resources.');
      }
      return this.finish(auth, context, entries, refused);
    }

    // Destination policy per class, decided once.
    const destinationRefusal = (reference: StudioResourceReference): boolean => {
      const policy = getStudioResourceClass(reference.kind).egress[context.destination];
      if (policy === StudioEgress.Never) {
        refuse(
          reference,
          StudioRefusalReason.DestinationNotPermitted,
          `${reference.kind} may not be sent to ${context.destination}.`,
        );
        return true;
      }
      return false;
    };

    // Library assets first: edited masters and asset-backed audio depend on their decisions.
    const assetIds = new Set<string>();
    for (const reference of references) {
      if (
        (reference.kind === StudioResourceKind.LibraryAsset ||
          reference.kind === StudioResourceKind.EditedMaster ||
          (reference.kind === StudioResourceKind.Audio && reference.source === 'asset')) &&
        isStudioUuid(reference.id)
      ) {
        assetIds.add(reference.id);
      }
    }
    const assetDecisions = await this.decideAssets(auth, assetIds, {
      backgroundRunner: context.backgroundRunner,
    });

    const decideAsset = (reference: StudioResourceReference): AssetDecision => {
      if (!isStudioUuid(reference.id)) {
        return { ok: false, reason: StudioRefusalReason.InvalidId, detail: 'Asset ids are UUIDs.' };
      }
      return (
        assetDecisions.get(reference.id) ?? {
          ok: false,
          reason: StudioRefusalReason.NotFound,
          detail: 'No such asset.',
        }
      );
    };

    const declaredImport = (
      reference: StudioResourceReference,
    ): { ok: true; item: StudioDeclaredImport } | { ok: false; reason: StudioRefusalReason; detail: string } => {
      const item = imports.get(reference.id);
      if (!item) {
        return {
          ok: false,
          reason: StudioRefusalReason.UndeclaredImport,
          detail: 'The project does not declare this import.',
        };
      }
      if (!item.checksum) {
        return {
          ok: false,
          reason: StudioRefusalReason.ChecksumMismatch,
          detail: 'The import has no recorded checksum.',
        };
      }
      return { ok: true, item };
    };

    const editedMasterReferences: StudioResourceReference[] = [];
    const generatedReferences: StudioResourceReference[] = [];

    for (const reference of references) {
      switch (reference.kind) {
        case StudioResourceKind.LibraryAsset: {
          if (destinationRefusal(reference)) {
            break;
          }
          const decision = decideAsset(reference);
          if (!decision.ok) {
            refuse(reference, decision.reason, decision.detail);
            break;
          }
          authorize(reference, {
            ownerId: decision.asset.ownerId,
            checksum: decision.asset.checksum.toString('base64'),
            path: decision.asset.originalPath,
            sourceAccess: decision.sourceAccess,
            grant: 'render',
          });
          break;
        }

        case StudioResourceKind.EditedMaster: {
          if (!destinationRefusal(reference)) {
            editedMasterReferences.push(reference);
          }
          break;
        }

        case StudioResourceKind.Audio: {
          if (destinationRefusal(reference)) {
            break;
          }
          switch (reference.source) {
            case 'asset': {
              const decision = decideAsset(reference);
              if (!decision.ok) {
                refuse(reference, decision.reason, decision.detail);
              } else if (decision.asset.type === AssetType.Video) {
                authorize(reference, {
                  ownerId: decision.asset.ownerId,
                  checksum: decision.asset.checksum.toString('base64'),
                  path: decision.asset.originalPath,
                  sourceAccess: decision.sourceAccess,
                  grant: 'render',
                });
              } else {
                refuse(reference, StudioRefusalReason.UnsupportedMediaType, 'Only a video carries an audio stream.');
              }
              break;
            }
            case 'import': {
              const declared = declaredImport(reference);
              if (declared.ok) {
                authorize(reference, {
                  ownerId: context.ownerId,
                  checksum: declared.item.checksum,
                  path: declared.item.path,
                  sourceAccess: 'project',
                  grant: 'render',
                });
              } else {
                refuse(reference, declared.reason, declared.detail);
              }
              break;
            }
            case 'catalog': {
              const entry = catalog.audio[reference.id];
              if (entry && rightsAdmit(reference, 'audio')) {
                authorize(reference, {
                  ownerId: null,
                  checksum: entry.checksum,
                  path: entry.path,
                  sourceAccess: 'deployment',
                  grant: 'render',
                });
              } else if (!entry) {
                refuse(reference, StudioRefusalReason.NotBundled, 'No bundled track with this id.');
              }
              break;
            }
            case 'generated': {
              generatedReferences.push(reference);
              break;
            }
            default: {
              refuse(reference, StudioRefusalReason.InvalidId, 'An audio reference must name its source.');
            }
          }
          break;
        }

        case StudioResourceKind.ProjectImport:
        case StudioResourceKind.VectorGraphic: {
          if (destinationRefusal(reference)) {
            break;
          }
          const declared = declaredImport(reference);
          if (!declared.ok) {
            refuse(reference, declared.reason, declared.detail);
            break;
          }
          if (reference.kind === StudioResourceKind.VectorGraphic) {
            if (!vectorContentTypes.has(declared.item.contentType)) {
              refuse(
                reference,
                StudioRefusalReason.UnsupportedMediaType,
                `${declared.item.contentType} is not an SVG or Lottie graphic.`,
              );
              break;
            }
            if (declared.item.externalReferences !== 0) {
              refuse(
                reference,
                StudioRefusalReason.RemoteSubresource,
                declared.item.externalReferences === undefined
                  ? 'The graphic has not been scanned for external subresources.'
                  : `The graphic references ${declared.item.externalReferences} external subresource(s).`,
              );
              break;
            }
          }
          authorize(reference, {
            ownerId: context.ownerId,
            checksum: declared.item.checksum,
            path: declared.item.path,
            sourceAccess: 'project',
            grant: 'render',
          });
          break;
        }

        case StudioResourceKind.Captions: {
          if (destinationRefusal(reference)) {
            break;
          }
          if (reference.inlineLines !== undefined) {
            authorize(reference, {
              ownerId: context.ownerId,
              checksum: null,
              path: null,
              sourceAccess: 'project',
              grant: 'none',
            });
            break;
          }
          const declared = declaredImport(reference);
          if (!declared.ok) {
            refuse(reference, declared.reason, declared.detail);
            break;
          }
          authorize(reference, {
            ownerId: context.ownerId,
            checksum: declared.item.checksum,
            path: declared.item.path,
            sourceAccess: 'project',
            grant: 'render',
          });
          break;
        }

        case StudioResourceKind.Font: {
          const entry = catalog.fonts[reference.id];
          if (!entry) {
            refuse(reference, StudioRefusalReason.NotBundled, 'Only fonts bundled with the deployment resolve.');
            break;
          }
          if (!rightsAdmit(reference, 'font')) {
            break;
          }
          authorize(reference, {
            ownerId: null,
            checksum: entry.checksum,
            path: entry.path,
            sourceAccess: 'deployment',
            grant: 'render',
          });
          break;
        }

        case StudioResourceKind.Lut: {
          if (reference.lutSource === 'import') {
            const declared = declaredImport(reference);
            if (declared.ok) {
              authorize(reference, {
                ownerId: context.ownerId,
                checksum: declared.item.checksum,
                path: declared.item.path,
                sourceAccess: 'project',
                grant: 'render',
              });
            } else {
              refuse(reference, declared.reason, declared.detail);
            }
            break;
          }
          const entry = catalog.luts[reference.id];
          if (!entry) {
            refuse(reference, StudioRefusalReason.NotBundled, 'No bundled LUT with this id.');
            break;
          }
          if (!rightsAdmit(reference, 'lut')) {
            break;
          }
          authorize(reference, {
            ownerId: null,
            checksum: entry.checksum,
            path: entry.path,
            sourceAccess: 'deployment',
            grant: 'render',
          });
          break;
        }

        case StudioResourceKind.Model: {
          const entry = catalog.models[reference.id];
          if (!entry) {
            refuse(reference, StudioRefusalReason.NotBundled, 'The model is not in the admitted-model catalogue.');
            break;
          }
          if (!rightsAdmit(reference, 'model')) {
            break;
          }
          authorize(reference, {
            ownerId: null,
            checksum: entry.checksum,
            path: null,
            sourceAccess: 'deployment',
            grant: 'none',
          });
          break;
        }

        case StudioResourceKind.Preset: {
          if (!reference.family || !isKnownStudioPreset(reference.family, reference.id)) {
            refuse(
              reference,
              StudioRefusalReason.UnknownPreset,
              `No ${reference.family ?? 'preset'} named ${reference.id}.`,
            );
            break;
          }
          authorize(reference, {
            ownerId: null,
            checksum: null,
            path: null,
            sourceAccess: 'deployment',
            grant: 'none',
          });
          break;
        }

        case StudioResourceKind.NestedSequence: {
          const problem = refusedSequences.get(reference.id);
          if (problem) {
            refuse(reference, problem.reason, problem.detail);
            break;
          }
          if (!sequences.has(reference.id)) {
            refuse(reference, StudioRefusalReason.UnknownSequence, 'The graph does not define this sequence.');
            break;
          }
          authorize(reference, {
            ownerId: context.ownerId,
            checksum: null,
            path: null,
            sourceAccess: 'graph',
            grant: 'none',
          });
          break;
        }

        case StudioResourceKind.GeneratedIntermediate: {
          if (!destinationRefusal(reference)) {
            generatedReferences.push(reference);
          }
          break;
        }

        case StudioResourceKind.RemotePreviewFrame: {
          refuse(reference, StudioRefusalReason.UnknownKind, 'Preview frames are issued as grants, never referenced.');
          break;
        }
      }
    }

    // Edited masters: owner only, and only over an authorized parent.
    for (const reference of editedMasterReferences) {
      const decision = decideAsset(reference);
      if (!decision.ok) {
        refuse(reference, decision.reason, decision.detail);
        continue;
      }
      if (decision.sourceAccess !== 'owner') {
        refuse(reference, StudioRefusalReason.NoAccess, 'Shared access reaches the original, not its edited versions.');
        continue;
      }
      const files = (await this.assetFileRepository.search({ assetId: reference.id, isEdited: true })).filter((file) =>
        editedMasterTypes.has(file.type),
      );
      if (files.length === 0) {
        refuse(reference, StudioRefusalReason.NotFound, 'No edited master has been rendered for this asset.');
        continue;
      }
      const allowed = await this.checkAccess({
        auth,
        permission: Permission.AssetFileRead,
        ids: files.map((file) => file.id),
      });
      const master =
        files.find((file) => allowed.has(file.id) && file.type === AssetFileType.EncodedVideo) ??
        files.find((file) => allowed.has(file.id));
      if (!master) {
        refuse(reference, StudioRefusalReason.NoAccess, 'No asset-file read access to the edited master.');
        continue;
      }
      authorize(reference, {
        ownerId: decision.asset.ownerId,
        checksum: null,
        path: master.path,
        sourceAccess: 'owner',
        grant: 'render',
      });
    }

    // Generated intermediates last, and to a fixed point, because one may derive from another.
    let pending = generatedReferences;
    let progressed = true;
    while (pending.length > 0 && progressed) {
      progressed = false;
      const next: StudioResourceReference[] = [];
      const authorizedKeys = new Set(entries.map((entry) => entry.key));
      for (const reference of pending) {
        const record = generated.get(reference.id);
        if (!record) {
          refuse(reference, StudioRefusalReason.UndeclaredImport, 'The project does not declare this generated file.');
          progressed = true;
          continue;
        }
        if (!record.checksum) {
          refuse(reference, StudioRefusalReason.ChecksumMismatch, 'The generated file has no recorded checksum.');
          progressed = true;
          continue;
        }
        const producerRights = checkStudioProducerRights(record.producer, rightsUse);
        if (producerRights && !producerRights.allowed) {
          refuse(reference, StudioRefusalReason.RightsBlocked, producerRights.detail);
          progressed = true;
          continue;
        }
        const missing = record.derivedFrom.filter((key) => !authorizedKeys.has(key));
        const refusedInput = missing.find((key) => refused.some((item) => item.key === key));
        if (refusedInput) {
          refuse(
            reference,
            StudioRefusalReason.DerivedInputRefused,
            `Derives from ${refusedInput}, which was refused.`,
          );
          progressed = true;
          continue;
        }
        if (missing.length > 0) {
          next.push(reference);
          continue;
        }
        authorize(reference, {
          ownerId: context.ownerId,
          checksum: record.checksum,
          path: record.path,
          sourceAccess: 'project',
          grant: 'render',
        });
        progressed = true;
      }
      pending = next;
    }
    for (const reference of pending) {
      const record = generated.get(reference.id)!;
      refuse(
        reference,
        StudioRefusalReason.DerivedInputRefused,
        `Derives from ${record.derivedFrom.join(', ')}, which the graph does not authorize.`,
      );
    }

    return this.finish(auth, context, entries, refused);
  }

  /**
   * The render and preview paths call this with the manifest they were handed. It throws unless
   * the manifest was issued by this process, is unexpired, is complete and, when the caller says
   * where it intends to run, was resolved for that destination.
   */
  assertAuthorizedManifest(
    manifest: StudioAuthorizedManifest,
    { destination, now = new Date() }: { destination?: StudioDestination; now?: Date } = {},
  ): void {
    if (manifest.schemaVersion !== STUDIO_MANIFEST_SCHEMA_VERSION) {
      throw new BadRequestException('Unsupported Studio manifest version');
    }
    if (this.digest(manifest) !== manifest.digest) {
      throw new BadRequestException('Studio manifest was not issued by this server process or was altered');
    }
    if (new Date(manifest.expiresAt).getTime() <= now.getTime()) {
      throw new BadRequestException('Studio manifest has expired; resolve the project again');
    }
    if (!manifest.complete) {
      throw new BadRequestException(
        `Studio manifest refused ${manifest.refusedCount} reference(s); rendering requires a complete manifest`,
      );
    }
    if (destination && manifest.destination !== destination) {
      throw new BadRequestException(`Studio manifest was resolved for ${manifest.destination}, not ${destination}`);
    }
  }

  /**
   * Issue one short-lived read grant per file-backed entry, bound to the worker that will redeem
   * it. Grants are `render` scope only: there is no grant that lets anyone download an original.
   */
  issueReadGrants(
    manifest: StudioAuthorizedManifest,
    {
      workerId,
      ttlSeconds = STUDIO_GRANT_TTL_SECONDS,
      now = new Date(),
    }: { workerId: string; ttlSeconds?: number; now?: Date },
  ): StudioReadGrant[] {
    this.assertAuthorizedManifest(manifest, { now });

    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const grants: StudioReadGrant[] = [];
    for (const entry of manifest.entries) {
      if (entry.grant !== 'render' || !entry.path) {
        continue;
      }
      const payload: StudioReadGrantPayload = {
        v: 1,
        scope: 'render',
        kind: entry.kind,
        id: entry.id,
        key: entry.key,
        checksum: entry.checksum,
        ownerId: entry.ownerId,
        projectId: manifest.projectId,
        revision: manifest.revision,
        userId: manifest.userId,
        workerId,
        manifest: manifest.digest,
      };
      grants.push({
        key: entry.key,
        kind: entry.kind,
        id: entry.id,
        path: entry.path,
        token: this.cryptoRepository.signJwt(payload, this.secret, { expiresIn: ttlSeconds }),
        expiresAt,
      });
    }
    return grants;
  }

  /**
   * A grant for the preview stream (FL-96): bound to the manifest, the revision, the acting user
   * and the worker. A new revision or a re-resolution produces a new digest, so frames from an
   * earlier one stop verifying.
   */
  issuePreviewGrant(
    manifest: StudioAuthorizedManifest,
    {
      workerId,
      ttlSeconds = STUDIO_GRANT_TTL_SECONDS,
      now = new Date(),
    }: { workerId: string; ttlSeconds?: number; now?: Date },
  ): string {
    this.assertAuthorizedManifest(manifest, { now });
    const payload: StudioReadGrantPayload = {
      v: 1,
      scope: 'preview',
      kind: StudioResourceKind.RemotePreviewFrame,
      id: manifest.digest,
      key: `${StudioResourceKind.RemotePreviewFrame}:${manifest.digest}`,
      checksum: null,
      ownerId: null,
      projectId: manifest.projectId,
      revision: manifest.revision,
      userId: manifest.userId,
      workerId,
      manifest: manifest.digest,
      assetIds: [
        // Every source that reaches the user through a library asset, whatever kind the graph uses it as.
        ...new Set(
          manifest.entries
            .filter((entry) => entry.sourceAccess === 'owner' || entry.sourceAccess === 'shared')
            .map((entry) => entry.id),
        ),
      ],
    };
    return this.cryptoRepository.signJwt(payload, this.secret, { expiresIn: ttlSeconds });
  }

  /**
   * Verify a grant on every use, not just once. Beyond the signature and expiry, a library-backed
   * grant is re-checked against live access for the acting user, and the current checksum must
   * still be the one the grant was bound to. A trashed, relocked, unshared or replaced source
   * therefore stops a stream the moment the worker next opens it; FL-95 and FL-96 own stopping
   * in-flight jobs and dropping cache entries when this returns `valid: false`.
   */
  async verifyReadGrant(
    token: string,
    { workerId, auth, backgroundRunner }: { workerId: string; auth: AuthDto; backgroundRunner?: boolean },
  ): Promise<StudioGrantVerification> {
    let grant: StudioReadGrantPayload;
    try {
      grant = this.cryptoRepository.verifyJwt<StudioReadGrantPayload>(token, this.secret);
    } catch (error: any) {
      const detail = String(error?.message ?? error);
      return { valid: false, reason: /expired/i.test(detail) ? 'expired' : 'invalid-token', detail };
    }

    if (grant?.v !== 1 || !grant.kind || !grant.id) {
      return { valid: false, reason: 'invalid-token', detail: 'Malformed grant.' };
    }
    if (grant.workerId !== workerId) {
      return { valid: false, reason: 'worker-mismatch', detail: 'The grant was issued to a different worker.' };
    }
    if (grant.userId !== auth.user.id) {
      return { valid: false, reason: 'user-mismatch', detail: 'The grant was issued for a different user.' };
    }
    if (auth.sharedLink) {
      return {
        valid: false,
        reason: StudioRefusalReason.SharedLinkSession,
        detail: 'Shared links cannot redeem grants.',
      };
    }

    if (grant.scope === 'preview') {
      const assetIds = grant.assetIds ?? [];
      if (assetIds.length > 0) {
        const decisions = await this.decideAssets(auth, new Set(assetIds), { backgroundRunner });
        for (const id of assetIds) {
          const decision = decisions.get(id);
          if (!decision) {
            return {
              valid: false,
              reason: StudioRefusalReason.NotFound,
              detail: 'A previewed source no longer exists.',
            };
          }
          if (!decision.ok) {
            return { valid: false, reason: decision.reason, detail: decision.detail };
          }
        }
      }
      return { valid: true, grant, path: '' };
    }

    if (LIBRARY_BACKED_KINDS.has(grant.kind)) {
      const decisions = await this.decideAssets(auth, new Set([grant.id]), { backgroundRunner });
      const decision = decisions.get(grant.id);
      if (!decision) {
        return { valid: false, reason: StudioRefusalReason.NotFound, detail: 'The source no longer exists.' };
      }
      if (!decision.ok) {
        return { valid: false, reason: decision.reason, detail: decision.detail };
      }
      if (grant.kind === StudioResourceKind.EditedMaster) {
        if (decision.sourceAccess !== 'owner') {
          return { valid: false, reason: StudioRefusalReason.NoAccess, detail: 'Edited masters are owner only.' };
        }
        const files = (await this.assetFileRepository.search({ assetId: grant.id, isEdited: true })).filter((file) =>
          editedMasterTypes.has(file.type),
        );
        const allowed = await this.checkAccess({
          auth,
          permission: Permission.AssetFileRead,
          ids: files.map((file) => file.id),
        });
        const master =
          files.find((file) => allowed.has(file.id) && file.type === AssetFileType.EncodedVideo) ??
          files.find((file) => allowed.has(file.id));
        if (!master) {
          return { valid: false, reason: StudioRefusalReason.NotFound, detail: 'The edited master is gone.' };
        }
        return { valid: true, grant, path: master.path };
      }
      const checksum = decision.asset.checksum.toString('base64');
      if (grant.checksum !== checksum) {
        return {
          valid: false,
          reason: StudioRefusalReason.ChecksumMismatch,
          detail: 'The source file changed since the grant was issued.',
        };
      }
      return { valid: true, grant, path: decision.asset.originalPath };
    }

    // Project-owned and deployment-owned files carry their checksum in the grant; the reader
    // (FL-95) compares it with the bytes it serves. Their access is the project's, decided when the
    // manifest was resolved and bound here by the manifest digest.
    return { valid: true, grant, path: '' };
  }

  /**
   * The key under which preview frames, scopes and chunk caches for this manifest may be stored.
   * It changes with the project revision and with every re-resolution, so nothing cached for an
   * earlier state can be served after access changes.
   */
  cacheKey(manifest: StudioAuthorizedManifest): string {
    return `studio:${manifest.projectId}:${manifest.revision}:${manifest.userId}:${manifest.destination}:${manifest.digest}`;
  }

  /* ------------------------------------------------------------------ */

  private async decideAssets(
    auth: AuthDto,
    ids: Set<string>,
    { backgroundRunner = false }: { backgroundRunner?: boolean } = {},
  ): Promise<Map<string, AssetDecision>> {
    const decisions = new Map<string, AssetDecision>();
    if (ids.size === 0) {
      return decisions;
    }

    const rows: AssetRow[] = await this.assetRepository.getByIds([...ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Access is decided before anything about an asset is reported (FL-34). An id the acting user
    // cannot read is refused exactly like one that does not exist, so a graph can never probe whether
    // someone else's asset exists, is trashed, offline or Locked. Owner, shared album and partner
    // access apply with the acting user's sensitive and suppressed content filters. A Locked asset
    // exists only for its owner's elevated session; a background runner's owner auth carries one.
    const allowed = await this.checkAccess({ auth, permission: Permission.AssetRead, ids: new Set(byId.keys()) });
    const elevatedOwnerId = getLockedOwnerId(auth);
    const notFound: AssetDecision = { ok: false, reason: StudioRefusalReason.NotFound, detail: 'No such asset.' };

    for (const id of ids) {
      const asset = byId.get(id);
      const isOwner = asset?.ownerId === auth.user.id;
      const isLocked = !!asset && isLockedAssetRow(asset);
      if (!asset || (isLocked && !(isOwner && (backgroundRunner || elevatedOwnerId === auth.user.id)))) {
        // missing, or someone else's Locked asset, or the owner's own in an ordinary session: a Locked
        // asset is indistinguishable from a missing one, whatever the access query answered
        decisions.set(id, notFound);
      } else if (!allowed.has(id)) {
        decisions.set(
          id,
          isOwner
            ? {
                ok: false,
                reason: StudioRefusalReason.HiddenContent,
                detail: 'Your sensitive or suppressed content settings exclude this asset.',
              }
            : notFound,
        );
      } else if (isLocked && !backgroundRunner) {
        // only the owner's elevated session reaches this: Locked media never enters Studio interactively
        decisions.set(id, {
          ok: false,
          reason: StudioRefusalReason.Locked,
          detail: 'Locked media never enters Studio.',
        });
      } else if (asset.deletedAt) {
        // only the owner reaches a trashed asset: album and partner access never include the trash
        decisions.set(id, { ok: false, reason: StudioRefusalReason.Trashed, detail: 'The asset is in the trash.' });
      } else if (asset.isOffline) {
        decisions.set(id, {
          ok: false,
          reason: StudioRefusalReason.Offline,
          detail: 'The original is missing from storage.',
        });
      } else if (timelineTypes.has(asset.type)) {
        decisions.set(id, { ok: true, asset, sourceAccess: isOwner ? 'owner' : 'shared' });
      } else {
        decisions.set(id, {
          ok: false,
          reason: StudioRefusalReason.UnsupportedMediaType,
          detail: 'Only images and video can be placed on a timeline.',
        });
      }
    }

    return decisions;
  }

  private finish(
    auth: AuthDto,
    context: StudioProjectResourceContext,
    entries: StudioAuthorizedEntry[],
    refused: StudioRefusedReference[],
    now: Date = new Date(),
  ): StudioResourceResolution {
    const unsigned: Omit<StudioAuthorizedManifest, 'digest'> = {
      schemaVersion: STUDIO_MANIFEST_SCHEMA_VERSION,
      projectId: context.projectId,
      revision: context.revision,
      userId: auth.user.id,
      destination: context.destination,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + STUDIO_MANIFEST_TTL_SECONDS * 1000).toISOString(),
      complete: refused.length === 0,
      refusedCount: refused.length,
      entries,
      privacy: {
        includesSharedSources: entries.some((entry) => entry.sourceAccess === 'shared'),
        includesPersonalData: entries.some((entry) => getStudioResourceClass(entry.kind).carriesPersonalData),
        originalAccess: false,
        leavesMachine: context.destination === StudioDestination.RunPod,
      },
    };

    return { manifest: { ...unsigned, digest: this.digest(unsigned) }, refused };
  }

  private digest(manifest: Omit<StudioAuthorizedManifest, 'digest'> & { digest?: string }): string {
    const content: Partial<StudioAuthorizedManifest> = { ...manifest };
    delete content.digest;
    return createHmac('sha256', this.secret).update(JSON.stringify(content)).digest('hex');
  }
}
