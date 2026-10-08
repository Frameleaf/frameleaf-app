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
 * - Locked media enters Studio interactively only as its owner's revealed lock
 *   (`REVEALED_LOCK_REASONS`: marks, detections and items moved from the old Locked folder) in their
 *   elevated session, where it behaves like any other item (owner decisions, September 27, 2026,
 *   FL-195). While the session is locked the project keeps its references; they are refused, and
 *   the owner's editor hides those clips rather than showing them as missing media. A background
 *   runner (FL-95) resolving a job the owner already submitted says so explicitly with `backgroundRunner` and reads the Locked sources that job references. Trashed and offline originals
 *   are refused. The acting user's sensitive and suppressed content settings apply through the
 *   same `checkAccess` the library uses.
 * - Nothing about an asset is reported before its access check. An asset the acting user cannot
 *   read is refused exactly like a missing one, and `locked` is reported only to the asset's owner
 *   in an elevated session (FL-34).
 * - Cloud is never a fallback. A Frameleaf Cloud destination without explicit consent fails before a single
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
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Selectable } from 'kysely';
import { createHmac } from 'node:crypto';
import type { SourceEpoch } from 'src/repositories/asset-local-effect.repository.js';
import type { InteractiveAdmissionSource, InteractiveAdmissionView } from 'src/repositories/studio-source-admission.js';
import { AssetRestorationMode, AssetRestorationSourceType } from 'src/dtos/asset-restoration.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioRestoredVersionDto, StudioRestoredVersionUnavailable } from 'src/dtos/studio-source.dto.js';
import { AssetFileType, AssetType, ColorTransfer, DecodeRefusal, JobName, Permission } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { getLockedOwnerId, isLockedAssetRow } from 'src/utils/locked-visibility.js';
import { isRevealedLockReason } from 'src/utils/locked.js';
import { DecodeSupport, qualifySourceDecode } from 'src/utils/media-decode.js';
import { restoredVersionState } from 'src/utils/restoration.js';
import { studioMediaSources } from 'src/utils/studio-export-contract.js';
import { STUDIO_IMPORT_VECTOR_MAX_BYTES, studioImportKind } from 'src/utils/studio-imports.js';
import {
  STUDIO_MAX_GRAPH_BYTES,
  STUDIO_MAX_REFERENCES,
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
  isStudioIdentifier,
  isStudioUuid,
  measureStudioGraph,
  studioReferenceKey,
  studioRestoredMediaId,
} from 'src/utils/studio-resources.js';
import {
  type StudioRightsCatalog,
  checkStudioProducerRights,
  checkStudioRights,
  studioRightsId,
  studioRightsUseFor,
} from 'src/utils/studio-rights.js';
import { readStudioVectorBindings, validateStudioVectorClosure } from 'src/utils/studio-vector-dependencies.js';

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
  /** Original server producer admission; never refreshed from current source state. */
  sourceEpochs?: SourceEpoch[];
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
   * never sets it, so a person only ever places Locked media that is their own revealed lock, in
   * their unlocked session (FL-195).
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
  /** A restored version's library original (FL-115), whose access every preview frame re-checks. */
  assetId?: string;
};

export type StudioRefusedReference = {
  key: string;
  kind: StudioResourceKind | null;
  id: string;
  graphPath: string;
  reason: StudioRefusalReason;
  detail: string;
  /** FL-101: set with {@link StudioRefusalReason.UnsupportedSource}, the decode qualification's code. */
  decodeRefusal?: DecodeRefusal;
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
  /** Private signed source-owner admission snapshot. Legacy manifests are never relabelled. */
  sourceEpochs?: SourceEpoch[];
  /** Original acting-session/local order view, carried only by interactive server admissions. */
  interactiveAdmissionView?: InteractiveAdmissionView;
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
  v: 1 | 2;
  sourceEpochs?: SourceEpoch[];
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
  /**
   * Preview grants only: the restored versions the previewed revision places (FL-115). Every frame
   * read re-checks each one, so discarding or expiring it stops the preview like losing access.
   */
  restorationIds?: string[];
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
  | 'id'
  | 'ownerId'
  | 'type'
  | 'visibility'
  | 'deletedAt'
  | 'isOffline'
  | 'originalPath'
  | 'checksum'
  | 'width'
  | 'height'
> & { isLocked?: boolean | null };

type AssetDecision =
  | { ok: true; asset: AssetRow; sourceAccess: 'owner' | 'shared' }
  | { ok: false; reason: StudioRefusalReason; detail: string };

type RestoredVersionDecision =
  | { ok: true; ownerId: string; assetId: string; path: string }
  | { ok: false; reason: StudioRefusalReason; detail: string };

const restorationRefusals = {
  discarded: {
    reason: StudioRefusalReason.RestorationDiscarded,
    detail: 'The restored version was discarded; choose the original or another version.',
  },
  expired: {
    reason: StudioRefusalReason.RestorationExpired,
    detail: 'The restored version has expired and its file was removed.',
  },
  'not-ready': {
    reason: StudioRefusalReason.RestorationNotReady,
    detail: 'The restoration has no finished result to place.',
  },
} as const;

const timelineTypes = new Set<AssetType>([AssetType.Image, AssetType.Video]);
/** FL-97: a failed Studio HDR transcode is tried again for the same original after a day. */
const STUDIO_HDR_RETRY_FAILED_MS = 24 * 60 * 60 * 1000;
const editedMasterTypes = new Set<AssetFileType>([AssetFileType.EncodedVideo, AssetFileType.FullSize]);
const vectorContentTypes = new Set([
  'image/svg+xml',
  'application/json',
  'application/zip',
  'application/x-lottie+json',
]);

/** What the owner is told about a restored version the bin cannot place; `undefined` is a 404. */
const restoredVersionUnavailable: Partial<Record<StudioRefusalReason, StudioRestoredVersionUnavailable>> = {
  [StudioRefusalReason.RestorationDiscarded]: StudioRestoredVersionUnavailable.Discarded,
  [StudioRefusalReason.RestorationExpired]: StudioRestoredVersionUnavailable.Expired,
  [StudioRefusalReason.RestorationNotReady]: StudioRestoredVersionUnavailable.NotReady,
  [StudioRefusalReason.Locked]: StudioRestoredVersionUnavailable.Locked,
  [StudioRefusalReason.Trashed]: StudioRestoredVersionUnavailable.Trashed,
  [StudioRefusalReason.Offline]: StudioRestoredVersionUnavailable.Offline,
  [StudioRefusalReason.HiddenContent]: StudioRestoredVersionUnavailable.HiddenContent,
};

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
    const admissionSources = new Map<string, InteractiveAdmissionSource>();
    if (!isStudioDestination(context.destination)) {
      throw new BadRequestException('Unknown Studio destination');
    }

    if (context.destination === StudioDestination.FrameleafCloud && context.cloudConsent !== true) {
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
    const vectorBindings = violations.some((item) => item.graphPath === '/studioVectorDependencies')
      ? []
      : readStudioVectorBindings(context.graph);
    const vectorParents = new Set(vectorBindings.map((binding) => `${binding.parent.kind}:${binding.parent.id}`));
    // FL-103 / FL-105: the editor places a project import by its own media id, the way it places a
    // library asset, so a media id the project declares as an import is that import, never an asset.
    for (const reference of references) {
      if (reference.vectorDependency || !imports.has(reference.id)) {
        continue;
      }
      if (reference.kind === StudioResourceKind.LibraryAsset) {
        reference.kind = StudioResourceKind.ProjectImport;
      } else if (reference.kind === StudioResourceKind.Audio && reference.source === 'asset') {
        reference.source = 'import';
      }
    }
    const distinct = new Set<string>();
    for (let index = references.length - 1; index >= 0; index--) {
      // The extractor's own identity: an audio reference is distinct per source.
      const key = `${studioReferenceKey(references[index])}@${references[index].source ?? ''}`;
      if (distinct.has(key)) {
        references.splice(index, 1);
      } else {
        distinct.add(key);
      }
    }
    // A relinked clip may reference only its generated file. Resolve its declared media lineage
    // through the same current-access checks as graph sources, including intermediate chains.
    // Keys for audio, LUTs and presets omit required source/family metadata: do not guess it.
    const lineageKinds = new Set([
      StudioResourceKind.LibraryAsset,
      StudioResourceKind.EditedMaster,
      StudioResourceKind.RestoredVersion,
      StudioResourceKind.ProjectImport,
      StudioResourceKind.GeneratedIntermediate,
    ]);
    const seen = new Set(references.map((reference) => studioReferenceKey(reference)));
    // Walk a growing work queue by cursor: appended lineage must also be expanded.
    let cursor = 0;
    while (cursor < references.length) {
      const reference = references[cursor++];
      if (
        reference.kind !== StudioResourceKind.GeneratedIntermediate &&
        !(reference.kind === StudioResourceKind.Audio && reference.source === 'generated')
      ) {
        continue;
      }
      for (const key of generated.get(reference.id)?.derivedFrom ?? []) {
        const separator = key.indexOf(':');
        if (separator < 1) {
          continue;
        }
        const kind = key.slice(0, separator) as StudioResourceKind;
        const id = key.slice(separator + 1);
        if (seen.has(key) || !lineageKinds.has(kind) || !isStudioIdentifier(id)) {
          continue;
        }
        if (references.length >= STUDIO_MAX_REFERENCES) {
          throw new BadRequestException(`Generated lineage exceeds ${STUDIO_MAX_REFERENCES} resource references`);
        }
        seen.add(key);
        references.push({ kind, id, graphPath: reference.graphPath });
      }
    }
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

    const refuse = (
      reference: StudioResourceReference,
      reason: StudioRefusalReason,
      detail: string,
      decodeRefusal?: DecodeRefusal,
    ) => {
      refused.push({
        key: studioReferenceKey(reference),
        kind: reference.kind,
        id: reference.id,
        graphPath: reference.graphPath,
        reason,
        detail,
        ...(decodeRefusal && { decodeRefusal }),
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
      fields: Pick<StudioAuthorizedEntry, 'ownerId' | 'checksum' | 'path' | 'sourceAccess' | 'grant' | 'assetId'>,
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
      return this.finish(auth, context, entries, refused, new Date(), [], admissionSources);
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
      admissionSources,
    });

    const undecodable = await this.findUndecodableVideos(references, assetDecisions);

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
      // FL-105: an SVG or Lottie import is a vector graphic however the graph names it (an audio
      // source, captions, a LUT), so its external subresources are refused on every path.
      if (
        vectorContentTypes.has(item.contentType) &&
        item.externalReferences !== 0 &&
        !vectorParents.has(studioReferenceKey(reference))
      ) {
        return {
          ok: false,
          reason: StudioRefusalReason.RemoteSubresource,
          detail:
            item.externalReferences === undefined
              ? 'The graphic has not been scanned for external subresources.'
              : `The graphic references ${item.externalReferences} external subresource(s).`,
        };
      }
      // An import is used only as what it is: sound from sound or video, captions from a caption
      // file and a LUT from a `.cube` file, as the upload read each from its bytes.
      const kind = studioImportKind(item.contentType);
      const fits =
        reference.kind === StudioResourceKind.Audio
          ? kind === 'audio' || kind === 'video'
          : reference.kind === StudioResourceKind.Captions
            ? kind === 'captions'
            : reference.kind === StudioResourceKind.Lut
              ? kind === 'lut'
              : true;
      if (!fits) {
        return {
          ok: false,
          reason: StudioRefusalReason.UnsupportedMediaType,
          detail: `${item.contentType} cannot be used as ${reference.kind}.`,
        };
      }
      return { ok: true, item };
    };

    const editedMasterReferences: StudioResourceReference[] = [];
    const restoredReferences: StudioResourceReference[] = [];
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
          // FL-101: a video the renderer cannot decode is refused when it is placed, with the reason,
          // rather than admitted and left to fail on the worker after the person has cut with it.
          const decode = undecodable.get(reference.id);
          if (decode) {
            refuse(reference, StudioRefusalReason.UnsupportedSource, decode.reason, decode.refusal);
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

        case StudioResourceKind.RestoredVersion: {
          if (!destinationRefusal(reference)) {
            restoredReferences.push(reference);
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
          if (
            reference.kind === StudioResourceKind.VectorGraphic &&
            !vectorContentTypes.has(declared.item.contentType)
          ) {
            refuse(
              reference,
              StudioRefusalReason.UnsupportedMediaType,
              `${declared.item.contentType} is not an SVG or Lottie graphic.`,
            );
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

    // Restored versions (FL-115): the owner's own accepted restorations, never anybody else's, and
    // never the playback choice by implication. The original's decision applies to them as well.
    for (const reference of restoredReferences) {
      const decision = await this.decideRestoredVersion(auth, reference.id, {
        backgroundRunner: context.backgroundRunner,
        admissionSources,
      });
      if (!decision.ok) {
        refuse(reference, decision.reason, decision.detail);
        continue;
      }
      authorize(reference, {
        ownerId: decision.ownerId,
        checksum: null,
        path: decision.path,
        sourceAccess: 'owner',
        grant: 'render',
        assetId: decision.assetId,
      });
    }

    // Generated intermediates last, and to a fixed point, because one may derive from another.
    const generatedSourceIds = new Map<string, string[]>();
    const generatedEpochs = new Map<string, SourceEpoch>();
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
        const inputEntries = entries.filter((entry) => record.derivedFrom.includes(entry.key));
        const inputIds = [
          ...new Set([
            ...studioMediaSources(inputEntries).ids,
            ...inputEntries.flatMap((entry) => (entry.assetId ? [entry.assetId] : [])),
            ...record.derivedFrom.flatMap((key) => generatedSourceIds.get(key) ?? []),
          ]),
        ].sort();
        if (!(await this.sourceEpochsMatch(record.sourceEpochs, inputIds, record.sourceEpochs !== undefined))) {
          refuse(
            reference,
            StudioRefusalReason.DerivedInputRefused,
            'The original producer source admission was revoked.',
          );
          progressed = true;
          continue;
        }
        generatedSourceIds.set(studioReferenceKey(reference), inputIds);
        const originalEpochs = record.sourceEpochs ?? (await this.integrityRepository.sourceEpochs(inputIds));
        for (const epoch of originalEpochs) generatedEpochs.set(epoch.assetId, epoch);
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
        `Derives from ${record.derivedFrom.join(', ')}, which the manifest does not authorize.`,
      );
    }

    if (vectorBindings.length > 0 && refused.length === 0) {
      const snapshots: Uint8Array[] = [];
      try {
        await validateStudioVectorClosure(context.graph, entries, async (entry, maximum) => {
          if (!entry.path) throw new Error('Missing vector input');
          const file = await this.storageRepository.openForRandomRead(entry.path);
          try {
            if (file.size === 0 || file.size > Math.min(maximum, STUDIO_IMPORT_VECTOR_MAX_BYTES))
              throw new Error('Vector input limit');
            const bytes = await file.read(0, file.size);
            snapshots.push(bytes);
            if (bytes.length !== file.size) throw new Error('Vector input changed');
            return bytes;
          } finally {
            await file.close();
          }
        });
      } catch {
        refused.push({
          key: 'graph:vector-dependencies',
          kind: null,
          id: '',
          graphPath: '/studioVectorDependencies',
          reason: StudioRefusalReason.RemoteSubresource,
          detail: 'Vector dependencies did not match authorized immutable bytes.',
        });
      } finally {
        for (const bytes of snapshots) bytes.fill(0);
      }
    }
    return this.finish(
      auth,
      context,
      entries,
      refused,
      new Date(),
      generatedEpochs.values().toArray(),
      admissionSources,
    );
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
        v: manifest.sourceEpochs ? 2 : 1,
        sourceEpochs: manifest.sourceEpochs,
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
      v: manifest.sourceEpochs ? 2 : 1,
      sourceEpochs: manifest.sourceEpochs,
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
            .map((entry) => entry.assetId ?? entry.id),
        ),
      ],
      restorationIds: manifest.entries
        .filter((entry) => entry.kind === StudioResourceKind.RestoredVersion)
        .map((entry) => entry.id),
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

    if (![1, 2].includes(grant?.v) || !grant.kind || !grant.id) {
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

    const sourceIds = [
      ...new Set([...(grant.assetIds ?? []), ...(LIBRARY_BACKED_KINDS.has(grant.kind) ? [grant.id] : [])]),
    ];
    if (!(await this.sourceEpochsMatch(grant.sourceEpochs, sourceIds, grant.v === 2))) {
      return {
        valid: false,
        reason: 'invalid-token',
        detail: 'Source admission was revoked; resolve the project again.',
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
      for (const restorationId of grant.restorationIds ?? []) {
        const decision = await this.decideRestoredVersion(auth, restorationId, { backgroundRunner });
        if (!decision.ok) {
          return { valid: false, reason: decision.reason, detail: decision.detail };
        }
      }
      return (await this.sourceEpochsMatch(grant.sourceEpochs, sourceIds, grant.v === 2))
        ? { valid: true, grant, path: '' }
        : { valid: false, reason: 'invalid-token', detail: 'Source admission was revoked; resolve the project again.' };
    }

    if (grant.kind === StudioResourceKind.RestoredVersion) {
      // Re-decided on every open: a discarded, expired, relocked or trashed restoration stops here.
      const decision = await this.decideRestoredVersion(auth, grant.id, { backgroundRunner });
      if (!decision.ok) {
        return { valid: false, reason: decision.reason, detail: decision.detail };
      }
      return (await this.sourceEpochsMatch(grant.sourceEpochs, sourceIds, grant.v === 2))
        ? { valid: true, grant, path: decision.path }
        : { valid: false, reason: 'invalid-token', detail: 'Source admission was revoked; resolve the project again.' };
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
        return (await this.sourceEpochsMatch(grant.sourceEpochs, sourceIds, grant.v === 2))
          ? { valid: true, grant, path: master.path }
          : {
              valid: false,
              reason: 'invalid-token',
              detail: 'Source admission was revoked; resolve the project again.',
            };
      }
      const checksum = decision.asset.checksum.toString('base64');
      if (grant.checksum !== checksum) {
        return {
          valid: false,
          reason: StudioRefusalReason.ChecksumMismatch,
          detail: 'The source file changed since the grant was issued.',
        };
      }
      return (await this.sourceEpochsMatch(grant.sourceEpochs, sourceIds, grant.v === 2))
        ? { valid: true, grant, path: decision.asset.originalPath }
        : { valid: false, reason: 'invalid-token', detail: 'Source admission was revoked; resolve the project again.' };
    }

    // Project-owned and deployment-owned files carry their checksum in the grant; the reader
    // (FL-95) compares it with the bytes it serves. Their access is the project's, decided when the
    // manifest was resolved and bound here by the manifest digest.
    return (await this.sourceEpochsMatch(grant.sourceEpochs, sourceIds, grant.v === 2))
      ? { valid: true, grant, path: '' }
      : { valid: false, reason: 'invalid-token', detail: 'Source admission was revoked; resolve the project again.' };
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

  /**
   * An accepted restoration as a media bin entry (FL-115): what the person chose with Use in Studio,
   * or what a reopened project places. Decided by exactly the rules a clip of it is resolved with. The
   * owner hears why it cannot be placed (discarded, expired, Locked, …); anyone else, and every
   * restoration that does not exist, is a 404.
   */
  async getRestoredVersion(auth: AuthDto, restorationId: string): Promise<StudioRestoredVersionDto> {
    const decision = await this.decideRestoredVersion(auth, restorationId);
    const unavailable = decision.ok ? null : restoredVersionUnavailable[decision.reason];
    if (unavailable === undefined) {
      throw new NotFoundException('Restored version not found');
    }
    const row = await this.assetRestorationRepository.get(restorationId);
    const asset = row && (await this.assetRepository.getById(row.assetId));
    if (!row || !asset) {
      throw new NotFoundException('Restored version not found');
    }
    const smoothMotion = row.mode === AssetRestorationMode.SmoothMotion;
    return {
      restorationId: row.id,
      assetId: row.assetId,
      mediaId: studioRestoredMediaId(row.id),
      available: unavailable === null,
      unavailable,
      sourceType: row.sourceType as AssetRestorationSourceType,
      mode: row.mode as AssetRestorationMode,
      upscale: smoothMotion ? 1 : row.upscale,
      smoothMotionFactor: smoothMotion ? row.upscale : null,
      width: row.outputWidth,
      height: row.outputHeight,
      durationSeconds: row.sourceDurationSeconds,
      originalFileName: asset.originalFileName,
      restoredAt: row.restoredAt ? new Date(row.restoredAt).toISOString() : null,
      expiresAt: row.resultExpiresAt ? new Date(row.resultExpiresAt).toISOString() : null,
    };
  }

  /**
   * Whether the acting user may place this restoration in Studio (FL-115): it must be theirs, its
   * original must pass the same decision a library clip does (Locked, trashed, offline and hidden
   * originals refuse it, and an interactive session places a Locked one only as its owner's revealed
   * lock in an unlocked session, FL-195), and it must be a
   * finished result that was neither discarded nor expired. Someone else's restoration and one that
   * never existed give the same answer.
   */
  async decideRestoredVersion(
    auth: AuthDto,
    restorationId: string,
    {
      backgroundRunner = false,
      now = new Date(),
      admissionSources,
    }: { backgroundRunner?: boolean; now?: Date; admissionSources?: Map<string, InteractiveAdmissionSource> } = {},
  ): Promise<RestoredVersionDecision> {
    const notFound: RestoredVersionDecision = {
      ok: false,
      reason: StudioRefusalReason.NotFound,
      detail: 'No such restored version.',
    };
    if (!isStudioUuid(restorationId)) {
      return { ok: false, reason: StudioRefusalReason.InvalidId, detail: 'Restoration ids are UUIDs.' };
    }
    if (auth.sharedLink) {
      return {
        ok: false,
        reason: StudioRefusalReason.SharedLinkSession,
        detail: 'Shared links cannot resolve Studio resources.',
      };
    }
    const row = await this.assetRestorationRepository.get(restorationId);
    if (!row || row.ownerId !== auth.user.id) {
      return notFound;
    }
    const asset = (await this.decideAssets(auth, new Set([row.assetId]), { backgroundRunner, admissionSources })).get(
      row.assetId,
    );
    if (!asset || (asset.ok && asset.sourceAccess !== 'owner')) {
      return notFound;
    }
    if (!asset.ok) {
      return asset.reason === StudioRefusalReason.NotFound ? notFound : asset;
    }
    const state = restoredVersionState(row, now);
    if (!state.usable) {
      return { ok: false, ...restorationRefusals[state.reason] };
    }
    return { ok: true, ownerId: row.ownerId, assetId: row.assetId, path: state.path };
  }

  /**
   * FL-101: which of the readable videos placed as picture sources the decode qualification
   * refuses, from the stream the library persisted at metadata extraction. A video whose metadata
   * has not been extracted is not judged here; the render still qualifies the probed stream.
   * Geometry is judged only when the library recorded a size, so an older row without one is not
   * refused for it. Edited masters are not decoded as pictures here, and neither is a video whose
   * library reference comes from an audio clip (the extractor records one reference per asset, at
   * its first use), since only its sound is taken.
   */
  private async findUndecodableVideos(
    references: readonly StudioResourceReference[],
    decisions: Map<string, AssetDecision>,
  ): Promise<Map<string, { reason: string; refusal: DecodeRefusal | undefined }>> {
    const soundOnly = new Set(
      references
        .filter((reference) => reference.kind === StudioResourceKind.Audio && reference.source === 'asset')
        .map((reference) => `${reference.id}\0${reference.graphPath}`),
    );
    const videos = new Map<string, AssetRow>();
    for (const reference of references) {
      if (
        reference.kind !== StudioResourceKind.LibraryAsset ||
        soundOnly.has(`${reference.id}\0${reference.graphPath}`)
      ) {
        continue;
      }
      const decision = decisions.get(reference.id);
      if (decision?.ok && decision.asset.type === AssetType.Video) {
        videos.set(decision.asset.id, decision.asset);
      }
    }

    const refused = new Map<string, { reason: string; refusal: DecodeRefusal | undefined }>();
    if (videos.size === 0) {
      return refused;
    }

    const [streams, { ffmpeg }] = await Promise.all([
      this.assetRepository.getVideoStreamsForDecode(videos.keys().toArray()),
      this.getConfig({ withCache: true }),
    ]);
    for (const stream of streams) {
      const asset = videos.get(stream.assetId);
      if (!asset) {
        continue;
      }
      const decode = qualifySourceDecode({ ...stream, width: asset.width ?? 0, height: asset.height ?? 0 }, ffmpeg);
      const geometryUnknown = asset.width === null || asset.height === null;
      if (
        decode.support === DecodeSupport.Refused &&
        !(decode.refusal === DecodeRefusal.UnusableGeometry && geometryUnknown)
      ) {
        refused.set(stream.assetId, { reason: decode.reason, refusal: decode.refusal ?? undefined });
      }
    }
    return refused;
  }

  /**
   * FL-97 owner decision: which of these library assets have an HDR picture stream (PQ or HLG
   * transfer, or Dolby Vision), as persisted by metadata extraction. Callers pass only ids the
   * acting account resolved. Sorted for a stable response.
   */
  async hdrLibraryAssets(ids: readonly string[]): Promise<string[]> {
    const candidates = [...new Set(ids.filter((id) => isStudioUuid(id)))];
    if (candidates.length === 0) {
      return [];
    }
    const streams = await this.assetRepository.getVideoStreamsForDecode(candidates);
    return [
      ...new Set(
        streams
          .filter(
            (stream) =>
              stream.colorTransfer === ColorTransfer.Smpte2084 ||
              stream.colorTransfer === ColorTransfer.AribStdB67 ||
              stream.dvProfile !== null,
          )
          .map((stream) => stream.assetId),
      ),
    ].toSorted();
  }

  /**
   * FL-97: which of these HDR videos already have their Studio HDR intermediate (sorted). The rest
   * are queued once, so a project that places them reads real HDR pixels once they are made:
   * - never one an edit is published over (the editor reads the published master's stream);
   * - never one refused as ineligible for this very original (a new original is tried again);
   * - one whose transcode failed only after a day, so a failing clip is not re-encoded on every read;
   * - a ready one whose file went missing, again.
   *
   * Owner decision (FL-97, 2026-09-29): only for the asset owner's own projects and for shared-space
   * projects. A personal project that places someone else's HDR clip (a partner's, an album's) reads
   * that clip's SDR playback stream: nothing is made, queued or offered for it.
   */
  async studioHdrProxies(
    hdrIds: readonly string[],
    project: { ownerId: string; sharedSpace: boolean },
  ): Promise<string[]> {
    const candidates = [...new Set(hdrIds.filter((id) => isStudioUuid(id)))];
    if (candidates.length === 0) {
      return [];
    }
    const states = await this.assetRepository.getStudioHdrIntermediateStates(candidates);
    const retryFailedBefore = Date.now() - STUDIO_HDR_RETRY_FAILED_MS;
    const ready: string[] = [];
    const queue: string[] = [];
    for (const { assetId, ownerId, edited, current, status, path, createdAt } of states) {
      if (edited || (!project.sharedSpace && ownerId !== project.ownerId)) {
        continue;
      }
      if (current && status === 'ready' && path) {
        // ponytail: one stat per placed HDR clip on project read; a lost file is made again
        const list = (await this.storageRepository.checkFileExists(path)) ? ready : queue;
        list.push(assetId);
        continue;
      }
      const refused =
        current &&
        (status === 'ineligible' || (status === 'failed' && !!createdAt && createdAt.getTime() > retryFailedBefore));
      if (!refused) {
        queue.push(assetId);
      }
    }
    if (queue.length > 0) {
      await this.jobRepository.queueAll(queue.map((id) => ({ name: JobName.StudioHdrProxyGenerate, data: { id } })));
    }
    await this.assetRepository.touchStudioHdrIntermediates(ready);
    return ready.toSorted();
  }

  /** FL-195: which of these (the elevated owner's own Locked assets) are locked for a revealed reason. */
  private async getRevealedLockIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const locks = await this.assetRepository.getLockReasons(ids);
    return new Set(locks.filter(({ reason }) => isRevealedLockReason(reason)).map(({ assetId }) => assetId));
  }

  private async decideAssets(
    auth: AuthDto,
    ids: Set<string>,
    {
      backgroundRunner = false,
      admissionSources,
    }: { backgroundRunner?: boolean; admissionSources?: Map<string, InteractiveAdmissionSource> } = {},
  ): Promise<Map<string, AssetDecision>> {
    const decisions = new Map<string, AssetDecision>();
    if (ids.size === 0) {
      return decisions;
    }

    if (admissionSources && !backgroundRunner && (auth.session || auth.apiKey)) {
      const observed = await this.integrityRepository.interactiveAdmissionViews([...ids]);
      for (const row of observed) {
        const previous = admissionSources.get(row.assetId);
        if (
          previous &&
          (previous.ownerId !== row.ownerId ||
            previous.streamEpoch !== row.streamEpoch ||
            previous.sequence !== row.sequence)
        )
          throw new BadRequestException('Studio source admission changed; resolve the project again');
        if (!previous) admissionSources.set(row.assetId, row);
      }
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
    // FL-195: why each of the elevated owner's own Locked rows is locked; only their revealed locks place
    const revealedIds = await this.getRevealedLockIds(
      elevatedOwnerId && !backgroundRunner
        ? rows.filter((row) => row.ownerId === elevatedOwnerId && isLockedAssetRow(row)).map((row) => row.id)
        : [],
    );
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
      } else if (isLocked && !backgroundRunner && !revealedIds.has(id)) {
        // only the owner's elevated session reaches this: every lock reason in REVEALED_LOCK_REASONS is
        // revealed to it and places like any other item (FL-195); a reason outside it never does
        decisions.set(id, {
          ok: false,
          reason: StudioRefusalReason.Locked,
          detail: 'This Locked item is not revealed to this session.',
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

  /** Exact binding equality; an unversioned source with any recorded Trash epoch requires re-resolution. */
  async sourceEpochsMatch(
    bound: readonly SourceEpoch[] | undefined,
    ids: string[],
    requireBound = true,
  ): Promise<boolean> {
    if ((bound !== undefined && !Array.isArray(bound)) || ids.some((id) => !isStudioUuid(id))) return false;
    if (
      bound?.some(
        (row) => !row || !isStudioUuid(row.assetId) || !isStudioUuid(row.ownerId) || typeof row.epoch !== 'string',
      )
    )
      return false;
    const sourceIds = [...new Set([...ids, ...(bound?.map((row) => row.assetId) ?? [])])].sort((a, b) =>
      a.localeCompare(b),
    );
    if (sourceIds.length > STUDIO_MAX_REFERENCES) return false;
    if (sourceIds.length === 0) return !requireBound || Array.isArray(bound);
    if (requireBound && (!Array.isArray(bound) || new Set(bound.map((row) => row.assetId)).size !== sourceIds.length))
      return false;
    if (bound?.some((row) => !/^(0|[1-9][0-9]*)$/.test(row.epoch))) return false;
    const current = await this.integrityRepository.sourceEpochs(sourceIds);
    if (current.length !== sourceIds.length) return false;
    return current.every((row) =>
      bound
        ? bound.some(
            (value) => value.assetId === row.assetId && value.ownerId === row.ownerId && value.epoch === row.epoch,
          )
        : row.epoch === '0',
    );
  }

  private async finish(
    auth: AuthDto,
    context: StudioProjectResourceContext,
    entries: StudioAuthorizedEntry[],
    refused: StudioRefusedReference[],
    now: Date = new Date(),
    producerEpochs: SourceEpoch[] = [],
    admissionSources?: Map<string, InteractiveAdmissionSource>,
  ): Promise<StudioResourceResolution> {
    const ids = [
      ...new Set([
        ...studioMediaSources(entries).ids,
        ...entries.flatMap((entry) => (entry.assetId ? [entry.assetId] : [])),
      ]),
    ].sort();
    const sourceEpochs = await this.integrityRepository.sourceEpochs(ids);
    if (sourceEpochs.length !== ids.length)
      throw new BadRequestException('Studio source admission changed; resolve the project again');
    if (
      producerEpochs.some((bound) =>
        sourceEpochs.every(
          (current) =>
            !(current.assetId === bound.assetId && current.ownerId === bound.ownerId && current.epoch === bound.epoch),
        ),
      )
    ) {
      throw new BadRequestException('Studio source admission changed; resolve the project again');
    }
    let interactiveAdmissionView: InteractiveAdmissionView | undefined;
    if (!context.backgroundRunner && (auth.session || auth.apiKey) && ids.length > 0) {
      const owners = new Map<string, InteractiveAdmissionSource>();
      for (const epoch of sourceEpochs) {
        const observed = admissionSources?.get(epoch.assetId);
        if (!observed || observed.ownerId !== epoch.ownerId)
          throw new BadRequestException('Studio source admission changed; resolve the project again');
        const previous = owners.get(observed.ownerId);
        if (previous && (previous.sequence !== observed.sequence || previous.streamEpoch !== observed.streamEpoch))
          throw new BadRequestException('Studio source admission changed; resolve the project again');
        owners.set(observed.ownerId, observed);
      }
      interactiveAdmissionView = {
        actorId: auth.user.id,
        sessionId: auth.session?.id ?? null,
        owners: owners
          .values()
          .toArray()
          .sort((a, b) => a.ownerId.localeCompare(b.ownerId))
          .map(({ ownerId, streamEpoch, sequence }) => ({ ownerId, streamEpoch, sequence })),
      };
    }
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
      sourceEpochs,
      ...(interactiveAdmissionView && { interactiveAdmissionView }),
      privacy: {
        includesSharedSources: entries.some((entry) => entry.sourceAccess === 'shared'),
        includesPersonalData: entries.some((entry) => getStudioResourceClass(entry.kind).carriesPersonalData),
        originalAccess: false,
        leavesMachine: context.destination === StudioDestination.FrameleafCloud,
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
