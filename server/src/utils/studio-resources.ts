/**
 * Studio graph resource inventory and reference extraction (FL-90 / STU-203).
 *
 * A Studio project graph is opaque to the host: it is Freecut's document and the server stores
 * and transports it without interpreting the edit. Executing it is different. Before a graph
 * reaches a preview or render worker, every resource it references has to be enumerated,
 * classified and authorized for the acting user, and everything that is not a declared,
 * resolvable resource has to be refused. This module is the framework-free half of that work:
 *
 * - {@link studioResourceRegistry} is the inventory. One row per resource class a graph can
 *   reference, with the owner, the access check that applies, whether the bytes may leave the
 *   machine (local, LAN worker, Frameleaf Cloud) and how long they are retained. The checked-in
 *   `studio/resource-inventory.json` is generated from it by {@link buildStudioResourceInventory}
 *   and a spec asserts they match.
 * - {@link extractStudioResourceReferences} walks a graph and returns every reference it finds,
 *   plus every violation: external locators, oversized or over-deep graphs, too many
 *   references, unknown explicit resource kinds.
 * - {@link checkNestedSequences} refuses unknown, cyclic or over-deep sequence nesting.
 *
 * The recursive `mediaId` check the plan mentions is a storage boundary: it says a clip points
 * at *some* media. It says nothing about fonts, LUTs, models, captions, SVG subresources or
 * generated intermediates, and it cannot tell a worker not to fetch a URL. This module covers
 * those. `server/src/services/studio-resource.service.ts` applies the actual access checks.
 *
 * The vendored engine (`studio/vendor/freecut`) is not present in this checkout, so the graph
 * keys recognised here are the ones the host contract and the prototype's project model use
 * (`web/src/lib/frameleaf/studio/commands.ts`, `design/frameleaf/template/src/studio-project.mjs`)
 * plus one explicit escape hatch, `$resource`, for the adapter to declare anything else. A key
 * this walker does not recognise is not a resource; a resource the adapter forgets to declare
 * is an undeclared dependency and the worker will fail to find it, which is the intended
 * failure mode rather than a silent fetch.
 */
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

/** Every class of resource a Studio project graph can reference or a Studio job can produce. */
export enum StudioResourceKind {
  /** A library original (image or video) placed on the timeline. */
  LibraryAsset = 'library-asset',
  /** An edited master rendered from a library original by the quick editor (FL-39). */
  EditedMaster = 'edited-master',
  /** Media uploaded into the project rather than the library: voiceovers, music files, stills. */
  ProjectImport = 'project-import',
  /** A typeface used by a title or caption style. */
  Font = 'font',
  /** A `.cube` colour lookup table. */
  Lut = 'lut',
  /** Model weights for transcription, upscaling, interpolation, TTS, music generation or restoration. */
  Model = 'model',
  /** A code-defined preset: transition, title style, look, export format, caption language. */
  Preset = 'preset',
  /** A caption track, inline in the graph or imported as a sidecar file. */
  Captions = 'captions',
  /** An audio source: the audio of a library video, an import, a bundled track or a generated one. */
  Audio = 'audio',
  /** An SVG or Lottie graphic, which can carry subresource references of its own. */
  VectorGraphic = 'vector-graphic',
  /** Proxies, waveforms, reverse-conformed media, transcripts, TTS output, chunk renders. */
  GeneratedIntermediate = 'generated-intermediate',
  /** A composition that places another sequence of the same project. */
  NestedSequence = 'nested-sequence',
  /** A frame streamed from the worker to the viewer's browser during preview (FL-96). */
  RemotePreviewFrame = 'remote-preview-frame',
}

export const studioResourceKinds: readonly StudioResourceKind[] = Object.values(StudioResourceKind);

const resourceKindSet: ReadonlySet<string> = new Set<string>(studioResourceKinds);

export const isStudioResourceKind = (value: unknown): value is StudioResourceKind =>
  typeof value === 'string' && resourceKindSet.has(value);

/** Who the resource belongs to, which decides whose rules govern it. */
export enum StudioResourceOwner {
  /** The owner of the library asset the resource is or derives from. */
  AssetOwner = 'asset-owner',
  /** The owner of the Studio project. */
  ProjectOwner = 'project-owner',
  /** The deployment: bundled catalogues and code-defined constants. */
  Deployment = 'deployment',
  /** The admitted worker that holds the bytes; nothing is copied from the library. */
  Worker = 'worker',
  /** The viewing session; nothing outlives it. */
  ViewerSession = 'viewer-session',
}

/** The access check the resolver applies. Each maps to code, never to a description alone. */
export enum StudioAccessCheck {
  /**
   * `checkAccess(Permission.AssetRead)`: owner, shared album or partner access, with the Locked
   * space excluded and the acting user's sensitive and suppressed content filters applied.
   * Interactive Studio sessions additionally refuse Locked assets even when elevated; background
   * renderers acting for the owner may read them (owner decision, September 22, 2026).
   */
  AssetRead = 'asset-read',
  /** `checkAccess(Permission.AssetFileRead)` after `AssetRead` on the parent: owner only. */
  AssetFileOwnerRead = 'asset-file-owner-read',
  /** The project declares the resource with its checksum; the acting user has project access. */
  ProjectDeclaration = 'project-declaration',
  /** The id is in the deployment's bundled catalogue; nothing else is accepted. */
  BundledCatalog = 'bundled-catalog',
  /** The id is a constant in this registry. */
  RegistryConstant = 'registry-constant',
  /** The target is a sequence of the same project graph, acyclic and within the depth cap. */
  GraphMembership = 'graph-membership',
  /** Every input the resource derives from is itself authorized in the same manifest. */
  DerivedInputs = 'derived-inputs',
  /** A revision-bound grant for the current session; there is no graph reference. */
  RevisionGrant = 'revision-grant',
}

/** Where a Studio job may run. Frameleaf Cloud is the only one that leaves the network (FL-159). */
export enum StudioDestination {
  Local = 'local',
  Lan = 'lan',
  FrameleafCloud = 'frameleaf-cloud',
}

export const studioDestinations: readonly StudioDestination[] = Object.values(StudioDestination);

export const isStudioDestination = (value: unknown): value is StudioDestination =>
  typeof value === 'string' && (studioDestinations as readonly string[]).includes(value);

/** Whether the bytes may travel to a destination. */
export enum StudioEgress {
  /** May be sent. */
  Allowed = 'allowed',
  /** May be sent only with the person's explicit, recorded consent for this job. */
  ExplicitConsent = 'explicit-consent',
  /** Never sent. */
  Never = 'never',
  /** Not transferred: the destination already holds or produces it. */
  DestinationSide = 'destination-side',
}

export type StudioEgressPolicy = Readonly<Record<StudioDestination, StudioEgress>>;

export enum StudioRetention {
  /** The original file. Never overwritten, never deleted by Studio. */
  OriginalPermanent = 'original-permanent',
  /** A derived version with recorded lineage; replaceable by a re-render, never the master. */
  DerivedReplaceable = 'derived-replaceable',
  /** Lives as long as the project; deleted with it. */
  ProjectLifetime = 'project-lifetime',
  /** Part of a project revision; retained with the revision history. */
  RevisionBound = 'revision-bound',
  /** A cache entry: evictable at any time, rebuilt on demand, bounded by the project lifetime. */
  EvictableCache = 'evictable-cache',
  /** Not stored at all; discarded once displayed or once the session ends. */
  Ephemeral = 'ephemeral',
  /** Source code or bundled catalogue; versioned with the deployment. */
  Deployment = 'deployment',
}

/** Why a reference was refused. Every refusal names one of these; nothing is refused silently. */
export enum StudioRefusalReason {
  /** The id is not a well-formed identifier for its class. */
  InvalidId = 'invalid-id',
  /** The resource does not exist. */
  NotFound = 'not-found',
  /** The acting user has no read access to the source. */
  NoAccess = 'no-access',
  /** The source is in the Locked space; interactive Studio sessions never handle Locked media. */
  Locked = 'locked',
  /** The source is in the trash. */
  Trashed = 'trashed',
  /** The original is missing from storage. */
  Offline = 'offline',
  /** The acting user's sensitive or suppressed content settings exclude the source. */
  HiddenContent = 'hidden-content',
  /** Only images and video can be placed on a timeline. */
  UnsupportedMediaType = 'unsupported-media-type',
  /** A shared-link session can never resolve Studio resources. */
  SharedLinkSession = 'shared-link-session',
  /** The project does not declare this import, so its checksum and owner are unknown. */
  UndeclaredImport = 'undeclared-import',
  /** The declared checksum is absent or does not match the stored file. */
  ChecksumMismatch = 'checksum-mismatch',
  /** A URL, blob, data URI, host path or traversal sequence where a resource id belongs. */
  ExternalLocator = 'external-locator',
  /** An SVG or Lottie import carries, or has not been scanned for, external subresources. */
  RemoteSubresource = 'remote-subresource',
  /** The `$resource.kind` is not in the inventory. */
  UnknownKind = 'unknown-kind',
  /** The font, LUT, track or model is not in the deployment's bundled catalogue. */
  NotBundled = 'not-bundled',
  /** The preset value is not one the registry defines. */
  UnknownPreset = 'unknown-preset',
  /** A nested sequence points at a sequence the graph does not contain. */
  UnknownSequence = 'unknown-sequence',
  /** Sequence nesting forms a cycle. */
  CyclicSequence = 'cyclic-sequence',
  /** Sequence nesting exceeds the depth cap. */
  DepthExceeded = 'depth-exceeded',
  /** The graph references more resources than the cap allows. */
  TooManyReferences = 'too-many-references',
  /** A generated intermediate derives from an input that was refused. */
  DerivedInputRefused = 'derived-input-refused',
  /** The resource class may not travel to the chosen destination. */
  DestinationNotPermitted = 'destination-not-permitted',
  /**
   * The reviewed rights decision for this resource does not admit the use (FL-86): every model,
   * voice, font, weight and tool stays blocked until the owner approves it (FL-146).
   */
  RightsBlocked = 'rights-blocked',
}

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

export type StudioResourceClass = {
  kind: StudioResourceKind;
  label: string;
  description: string;
  owner: StudioResourceOwner;
  accessCheck: StudioAccessCheck;
  egress: StudioEgressPolicy;
  retention: StudioRetention;
  /** True when the resolver issues a worker read grant for it. */
  fileBacked: boolean;
  /** True when the bytes can carry a person's likeness, voice, words or whereabouts. */
  carriesPersonalData: boolean;
  /** Graph keys the walker recognises for this class. Empty for classes with no graph reference. */
  graphKeys: readonly string[];
  /** Refusal reasons the resolver can return for this class. */
  refusals: readonly StudioRefusalReason[];
};

const personalEgress: StudioEgressPolicy = {
  [StudioDestination.Local]: StudioEgress.Allowed,
  [StudioDestination.Lan]: StudioEgress.Allowed,
  [StudioDestination.FrameleafCloud]: StudioEgress.ExplicitConsent,
};

const deploymentEgress: StudioEgressPolicy = {
  [StudioDestination.Local]: StudioEgress.Allowed,
  [StudioDestination.Lan]: StudioEgress.Allowed,
  [StudioDestination.FrameleafCloud]: StudioEgress.Allowed,
};

const destinationSideEgress: StudioEgressPolicy = {
  [StudioDestination.Local]: StudioEgress.DestinationSide,
  [StudioDestination.Lan]: StudioEgress.DestinationSide,
  [StudioDestination.FrameleafCloud]: StudioEgress.DestinationSide,
};

const define = (definition: StudioResourceClass): [StudioResourceKind, StudioResourceClass] => [
  definition.kind,
  definition,
];

const commonSourceRefusals = [
  StudioRefusalReason.InvalidId,
  StudioRefusalReason.NotFound,
  StudioRefusalReason.NoAccess,
  StudioRefusalReason.Locked,
  StudioRefusalReason.Trashed,
  StudioRefusalReason.Offline,
  StudioRefusalReason.HiddenContent,
  StudioRefusalReason.SharedLinkSession,
  StudioRefusalReason.DestinationNotPermitted,
] as const;

const importRefusals = [
  StudioRefusalReason.InvalidId,
  StudioRefusalReason.UndeclaredImport,
  StudioRefusalReason.ChecksumMismatch,
  StudioRefusalReason.ExternalLocator,
  StudioRefusalReason.SharedLinkSession,
  StudioRefusalReason.DestinationNotPermitted,
] as const;

/**
 * The inventory. Order is the order of the generated table. Every row is a class the resolver
 * knows how to check; adding a row here without a branch in the service is caught by
 * {@link assertRegistryCoversService} in the service spec.
 */
export const studioResourceRegistry: ReadonlyMap<StudioResourceKind, StudioResourceClass> = new Map([
  define({
    kind: StudioResourceKind.LibraryAsset,
    label: 'Library asset',
    description:
      'A library original (image or video) placed on the timeline. Resolved against the acting user, ' +
      'never against the project owner: a shared project never grants access the viewer does not already have.',
    owner: StudioResourceOwner.AssetOwner,
    accessCheck: StudioAccessCheck.AssetRead,
    egress: personalEgress,
    retention: StudioRetention.OriginalPermanent,
    fileBacked: true,
    carriesPersonalData: true,
    graphKeys: ['assetId', 'mediaId'],
    refusals: [...commonSourceRefusals, StudioRefusalReason.UnsupportedMediaType],
  }),
  define({
    kind: StudioResourceKind.EditedMaster,
    label: 'Edited master',
    description:
      'A master the quick editor rendered from a library original (FL-39), identified by its lineage ' +
      'sidecar. Owner only: shared album and partner access reach the original, not its edited versions.',
    owner: StudioResourceOwner.AssetOwner,
    accessCheck: StudioAccessCheck.AssetFileOwnerRead,
    egress: personalEgress,
    retention: StudioRetention.DerivedReplaceable,
    fileBacked: true,
    carriesPersonalData: true,
    graphKeys: ['editedMasterOf'],
    refusals: [...commonSourceRefusals],
  }),
  define({
    kind: StudioResourceKind.ProjectImport,
    label: 'Project import',
    description:
      'Media uploaded into the project rather than the library: voiceover recordings, music files, ' +
      'stills. Declared by the project with a checksum; stored with the project, not in the library.',
    owner: StudioResourceOwner.ProjectOwner,
    accessCheck: StudioAccessCheck.ProjectDeclaration,
    egress: personalEgress,
    retention: StudioRetention.ProjectLifetime,
    fileBacked: true,
    carriesPersonalData: true,
    graphKeys: ['uploadId', 'importId'],
    refusals: [...importRefusals],
  }),
  define({
    kind: StudioResourceKind.Font,
    label: 'Font',
    description:
      'A typeface for titles and captions. Only fonts bundled with the deployment resolve; a font ' +
      'named by URL is refused so a render can never fetch from the network.',
    owner: StudioResourceOwner.Deployment,
    accessCheck: StudioAccessCheck.BundledCatalog,
    egress: deploymentEgress,
    retention: StudioRetention.Deployment,
    fileBacked: true,
    carriesPersonalData: false,
    graphKeys: ['fontFamily', 'fontId'],
    refusals: [
      StudioRefusalReason.InvalidId,
      StudioRefusalReason.NotBundled,
      StudioRefusalReason.RightsBlocked,
      StudioRefusalReason.ExternalLocator,
    ],
  }),
  define({
    kind: StudioResourceKind.Lut,
    label: 'LUT',
    description:
      'A .cube colour lookup table, either bundled with the deployment or imported into the project ' +
      'with a checksum.',
    owner: StudioResourceOwner.Deployment,
    accessCheck: StudioAccessCheck.BundledCatalog,
    egress: deploymentEgress,
    retention: StudioRetention.Deployment,
    fileBacked: true,
    carriesPersonalData: false,
    graphKeys: ['lutId'],
    refusals: [
      StudioRefusalReason.InvalidId,
      StudioRefusalReason.NotBundled,
      StudioRefusalReason.RightsBlocked,
      StudioRefusalReason.UndeclaredImport,
      StudioRefusalReason.ChecksumMismatch,
      StudioRefusalReason.ExternalLocator,
    ],
  }),
  define({
    kind: StudioResourceKind.Model,
    label: 'Model',
    description:
      'Model weights for transcription, upscaling, frame interpolation, text to speech, music ' +
      'generation and restoration. Identified by id and revision from the admitted-model catalogue; the ' +
      'worker that runs the job holds the weights, nothing is uploaded from the library.',
    owner: StudioResourceOwner.Worker,
    accessCheck: StudioAccessCheck.BundledCatalog,
    egress: destinationSideEgress,
    retention: StudioRetention.EvictableCache,
    fileBacked: false,
    carriesPersonalData: false,
    graphKeys: ['modelId'],
    refusals: [
      StudioRefusalReason.InvalidId,
      StudioRefusalReason.NotBundled,
      StudioRefusalReason.RightsBlocked,
      StudioRefusalReason.ExternalLocator,
    ],
  }),
  define({
    kind: StudioResourceKind.Preset,
    label: 'Preset',
    description:
      'A code-defined constant: transition type, title style, animation and position, look, caption ' +
      'language, restoration mode, resolution, export format and colour. Carries no user data.',
    owner: StudioResourceOwner.Deployment,
    accessCheck: StudioAccessCheck.RegistryConstant,
    egress: deploymentEgress,
    retention: StudioRetention.Deployment,
    fileBacked: false,
    carriesPersonalData: false,
    graphKeys: [
      'transitionIn.type',
      'transitionOut.type',
      'grade.look',
      'style',
      'animation',
      'position',
      'captionLanguage',
    ],
    refusals: [StudioRefusalReason.UnknownPreset],
  }),
  define({
    kind: StudioResourceKind.Captions,
    label: 'Captions',
    description:
      'A caption track. Inline captions are part of the project revision; imported .srt/.vtt sidecars ' +
      'are project imports. Both are treated as personal data because they transcribe speech.',
    owner: StudioResourceOwner.ProjectOwner,
    accessCheck: StudioAccessCheck.ProjectDeclaration,
    egress: personalEgress,
    retention: StudioRetention.RevisionBound,
    fileBacked: false,
    carriesPersonalData: true,
    graphKeys: ['captions', 'captionsImportId'],
    refusals: [...importRefusals],
  }),
  define({
    kind: StudioResourceKind.Audio,
    label: 'Audio',
    description:
      'An audio source: the audio stream of a library video (resolved as that asset), a project import ' +
      '(voiceover, music file), a bundled track, or a generated intermediate (TTS, music generation).',
    owner: StudioResourceOwner.AssetOwner,
    accessCheck: StudioAccessCheck.AssetRead,
    egress: personalEgress,
    retention: StudioRetention.OriginalPermanent,
    fileBacked: true,
    carriesPersonalData: true,
    graphKeys: ['musicId'],
    refusals: [
      ...new Set([
        ...commonSourceRefusals,
        ...importRefusals,
        StudioRefusalReason.NotBundled,
        StudioRefusalReason.RightsBlocked,
      ]),
    ],
  }),
  define({
    kind: StudioResourceKind.VectorGraphic,
    label: 'Vector graphic',
    description:
      'An SVG or Lottie graphic imported into the project. Refused unless the import scanner recorded ' +
      'zero external subresources (href, xlink:href, @import, url()); an unscanned graphic is refused.',
    owner: StudioResourceOwner.ProjectOwner,
    accessCheck: StudioAccessCheck.ProjectDeclaration,
    egress: personalEgress,
    retention: StudioRetention.ProjectLifetime,
    fileBacked: true,
    carriesPersonalData: false,
    graphKeys: ['graphicId'],
    refusals: [...importRefusals, StudioRefusalReason.RemoteSubresource],
  }),
  define({
    kind: StudioResourceKind.GeneratedIntermediate,
    label: 'Generated intermediate',
    description:
      'Proxies, waveforms, thumbnails, reverse-conformed media, transcripts, TTS and music-generation ' +
      'output, chunk renders. Inherits the most restrictive privacy of its inputs; authorized only when ' +
      'every input is authorized in the same manifest. Never a master.',
    owner: StudioResourceOwner.ProjectOwner,
    accessCheck: StudioAccessCheck.DerivedInputs,
    egress: personalEgress,
    retention: StudioRetention.EvictableCache,
    fileBacked: true,
    carriesPersonalData: true,
    graphKeys: ['generatedId'],
    refusals: [
      StudioRefusalReason.InvalidId,
      StudioRefusalReason.UndeclaredImport,
      StudioRefusalReason.ChecksumMismatch,
      StudioRefusalReason.DerivedInputRefused,
      StudioRefusalReason.SharedLinkSession,
      StudioRefusalReason.DestinationNotPermitted,
      StudioRefusalReason.RightsBlocked,
    ],
  }),
  define({
    kind: StudioResourceKind.NestedSequence,
    label: 'Nested sequence',
    description:
      'A composition that places another sequence of the same project. Must exist in the graph, must ' +
      'not form a cycle and must stay within the nesting depth cap.',
    owner: StudioResourceOwner.ProjectOwner,
    accessCheck: StudioAccessCheck.GraphMembership,
    egress: personalEgress,
    retention: StudioRetention.RevisionBound,
    fileBacked: false,
    carriesPersonalData: false,
    graphKeys: ['sequenceId'],
    refusals: [
      StudioRefusalReason.InvalidId,
      StudioRefusalReason.UnknownSequence,
      StudioRefusalReason.CyclicSequence,
      StudioRefusalReason.DepthExceeded,
    ],
  }),
  define({
    kind: StudioResourceKind.RemotePreviewFrame,
    label: 'Remote preview frame',
    description:
      'A frame streamed from the worker to the viewer during preview (FL-96). Not referenced by the ' +
      'graph; issued as a grant bound to the manifest, revision and session. Never cached durably and ' +
      'never a colour authority or export source.',
    owner: StudioResourceOwner.ViewerSession,
    accessCheck: StudioAccessCheck.RevisionGrant,
    egress: {
      [StudioDestination.Local]: StudioEgress.Allowed,
      [StudioDestination.Lan]: StudioEgress.Allowed,
      [StudioDestination.FrameleafCloud]: StudioEgress.ExplicitConsent,
    },
    retention: StudioRetention.Ephemeral,
    fileBacked: false,
    carriesPersonalData: true,
    graphKeys: [],
    refusals: [StudioRefusalReason.NoAccess, StudioRefusalReason.SharedLinkSession],
  }),
]);

export const getStudioResourceClass = (kind: StudioResourceKind): StudioResourceClass => {
  const definition = studioResourceRegistry.get(kind);
  if (!definition) {
    throw new Error(`Unknown Studio resource kind ${kind}`);
  }
  return definition;
};

/* ------------------------------------------------------------------ */
/* Presets: the code-defined constants a graph may name                 */
/* ------------------------------------------------------------------ */

/**
 * Preset families and their values, from the prototype's project model. A preset reference is
 * `${family}:${value}`; anything not listed is `unknown-preset`. These are interaction constants,
 * not rendering claims: whether a transition renders is the engine's conformance row.
 */
export const studioPresetFamilies: Readonly<Record<string, readonly string[]>> = {
  transition: ['Cross dissolve', 'Dip to black', 'Wipe', 'Slide', 'Zoom'],
  titleStyle: ['Minimal', 'Bold', 'Serif', 'Outline', 'Lower third', 'Caption bar'],
  titleAnimation: ['Fade', 'Rise', 'Typewriter', 'Slide'],
  titlePosition: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'],
  look: ['none', 'alpine', 'cedar', 'glacier', 'golden', 'slate', 'fern', 'ember', 'trail'],
  captionLanguage: ['Auto detect', 'English', 'French', 'Spanish', 'German'],
  restoreMode: ['Faithful', 'Creative'],
  resolution: ['720p', '1080p', '1440p', '2160p'],
  exportFormat: ['MP4 · H.265 Main10', 'MP4 · H.264', 'WebM · AV1', 'ProRes 422 HQ'],
  exportColor: ['Preserve source', 'HDR10', 'Dolby Vision'],
};

export const isKnownStudioPreset = (family: string, value: string): boolean =>
  (studioPresetFamilies[family] ?? []).includes(value);

/* ------------------------------------------------------------------ */
/* Limits                                                               */
/* ------------------------------------------------------------------ */

/** Serialized graph size above which resolution refuses before enumerating anything. */
export const STUDIO_MAX_GRAPH_BYTES = 8 * 1024 * 1024;
/** Object nesting depth above which the walker stops and records a violation. */
export const STUDIO_MAX_GRAPH_DEPTH = 64;
/** Distinct references above which the walker stops and records a violation. */
export const STUDIO_MAX_REFERENCES = 10_000;
/** Sequence-in-sequence nesting depth cap. */
export const STUDIO_MAX_SEQUENCE_DEPTH = 16;

/* ------------------------------------------------------------------ */
/* References                                                           */
/* ------------------------------------------------------------------ */

/** Where in the audio class a reference points; decides which resolver branch runs. */
export type StudioAudioSource = 'asset' | 'import' | 'catalog' | 'generated';

export type StudioResourceReference = {
  kind: StudioResourceKind;
  /** The identifier as written in the graph. */
  id: string;
  /** JSON-pointer-like path of the referencing object, for the refusal detail. */
  graphPath: string;
  /** Preset family, for {@link StudioResourceKind.Preset}. */
  family?: string;
  /** Audio source, for {@link StudioResourceKind.Audio}. */
  source?: StudioAudioSource;
  /** Whether a LUT names a bundled catalogue entry or a project import. */
  lutSource?: 'catalog' | 'import';
  /** For inline captions: how many lines, so an empty track is not a resource. */
  inlineLines?: number;
};

/** Stable key for a reference, used to dedupe and to name manifest entries. */
export const studioReferenceKey = (reference: Pick<StudioResourceReference, 'kind' | 'id' | 'family'>): string =>
  reference.family ? `${reference.kind}:${reference.family}:${reference.id}` : `${reference.kind}:${reference.id}`;

export type StudioGraphViolation = {
  reason:
    | StudioRefusalReason.ExternalLocator
    | StudioRefusalReason.UnknownKind
    | StudioRefusalReason.DepthExceeded
    | StudioRefusalReason.TooManyReferences
    | StudioRefusalReason.InvalidId;
  graphPath: string;
  detail: string;
};

export type StudioReferenceExtraction = {
  references: StudioResourceReference[];
  violations: StudioGraphViolation[];
  /** Sequence ids the graph defines, in order, with the sequences each one nests. */
  sequences: Map<string, string[]>;
};

/** Identifier shape accepted anywhere an id is expected. Deliberately excludes `/`, `:` and `.`-runs. */
const identifier = /^[\w-]{1,128}$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export const isStudioIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && identifier.test(value);
export const isStudioUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

/**
 * Keys whose string values are locators by convention. Any URL, scheme, absolute path or
 * traversal under one of these is a violation: a worker must only ever receive resource ids.
 */
const locatorKeys = new Set([
  'src',
  'url',
  'href',
  'uri',
  'path',
  'file',
  'filePath',
  'filepath',
  'source',
  'sourceUrl',
  'blobUrl',
  'objectUrl',
  'handle',
  'fileHandle',
  'directory',
  'xlink:href',
]);

/** Schemes that are never legitimate anywhere in a graph, even inside free text. */
const forbiddenSchemes = /^(blob|data|file|filesystem|chrome|chrome-extension|moz-extension|javascript):/i;
/** Anything with a scheme, an absolute path or a traversal segment. */
const locatorPattern = /^(?:[a-z][\d+.a-z-]*:|\/|\\\\|[a-z]:\\)|(?:^|[/\\])\.\.(?:[/\\]|$)/i;

export const isExternalLocator = (value: string): boolean => forbiddenSchemes.test(value) || locatorPattern.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const tooManyReferences = (state: StudioReferenceExtraction, graphPath: string): boolean => {
  if (state.references.length < STUDIO_MAX_REFERENCES) {
    return false;
  }
  if (state.violations.every((violation) => violation.reason !== StudioRefusalReason.TooManyReferences)) {
    state.violations.push({
      reason: StudioRefusalReason.TooManyReferences,
      graphPath,
      detail: `More than ${STUDIO_MAX_REFERENCES} resource references.`,
    });
  }
  return true;
};

const pushReference = (
  state: StudioReferenceExtraction,
  seen: Set<string>,
  reference: StudioResourceReference,
): void => {
  const key = `${studioReferenceKey(reference)}@${reference.source ?? ''}`;
  if (seen.has(key) || tooManyReferences(state, reference.graphPath)) {
    return;
  }
  seen.add(key);
  state.references.push(reference);
};

const pushIdViolation = (state: StudioReferenceExtraction, graphPath: string, key: string, value: unknown): void => {
  const detail = typeof value === 'string' ? value.slice(0, 120) : typeof value;
  state.violations.push(
    typeof value === 'string' && isExternalLocator(value)
      ? { reason: StudioRefusalReason.ExternalLocator, graphPath, detail: `${key}: ${detail}` }
      : { reason: StudioRefusalReason.InvalidId, graphPath, detail: `${key}: ${detail}` },
  );
};

/** Read an id-valued key: a well-formed identifier is returned, anything else is a violation. */
const readId = (
  state: StudioReferenceExtraction,
  node: Record<string, unknown>,
  key: string,
  graphPath: string,
): string | null => {
  if (!(key in node) || node[key] === null || node[key] === undefined) {
    return null;
  }
  const value = node[key];
  if (isStudioIdentifier(value)) {
    return value;
  }
  pushIdViolation(state, graphPath, key, value);
  return null;
};

const readPreset = (
  state: StudioReferenceExtraction,
  seen: Set<string>,
  value: unknown,
  family: string,
  graphPath: string,
): void => {
  if (typeof value !== 'string' || value.length === 0) {
    return;
  }
  pushReference(state, seen, {
    kind: StudioResourceKind.Preset,
    id: value.slice(0, 128),
    family,
    graphPath,
  });
};

const audioClipKinds = new Set(['audio', 'music', 'voice']);

const readLutSource = (value: unknown): 'catalog' | 'import' | undefined => {
  if (value === 'import' || value === 'catalog') {
    return value;
  }
  return undefined;
};

const walk = (
  node: unknown,
  graphPath: string,
  depth: number,
  state: StudioReferenceExtraction,
  seen: Set<string>,
  currentSequence: string | null,
): void => {
  if (depth > STUDIO_MAX_GRAPH_DEPTH) {
    if (state.violations.every((violation) => violation.reason !== StudioRefusalReason.DepthExceeded)) {
      state.violations.push({
        reason: StudioRefusalReason.DepthExceeded,
        graphPath,
        detail: `Graph nesting deeper than ${STUDIO_MAX_GRAPH_DEPTH}.`,
      });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      walk(item, `${graphPath}/${index}`, depth + 1, state, seen, currentSequence);
    }
    return;
  }

  if (!isRecord(node)) {
    return;
  }

  // A sequence definition: `{ id, tracks: [...] }` under a `sequences` array, or the root of a
  // single-sequence document. Its id becomes the parent for nested references found beneath it.
  let sequence = currentSequence;
  if (Array.isArray(node.tracks) && isStudioIdentifier(node.id)) {
    sequence = node.id;
    if (!state.sequences.has(sequence)) {
      state.sequences.set(sequence, []);
    }
  }

  // Explicit declaration: `{ $resource: { kind, id } }`.
  if (isRecord(node.$resource)) {
    const declared = node.$resource;
    if (!isStudioResourceKind(declared.kind)) {
      state.violations.push({
        reason: StudioRefusalReason.UnknownKind,
        graphPath: `${graphPath}/$resource`,
        detail: typeof declared.kind === 'string' ? declared.kind.slice(0, 120) : typeof declared.kind,
      });
    } else if (declared.kind === StudioResourceKind.RemotePreviewFrame) {
      state.violations.push({
        reason: StudioRefusalReason.UnknownKind,
        graphPath: `${graphPath}/$resource`,
        detail: 'remote-preview-frame is issued, never referenced',
      });
    } else {
      const id = readId(state, declared, 'id', `${graphPath}/$resource`);
      if (id) {
        pushReference(state, seen, {
          kind: declared.kind,
          id,
          graphPath: `${graphPath}/$resource`,
          family: typeof declared.family === 'string' ? declared.family : undefined,
          source: typeof declared.source === 'string' ? (declared.source as StudioAudioSource) : undefined,
          lutSource: readLutSource(declared.lutSource),
        });
      }
    }
  }

  const clipKind = typeof node.kind === 'string' ? node.kind : null;

  for (const key of ['assetId', 'mediaId']) {
    const id = readId(state, node, key, graphPath);
    if (id) {
      pushReference(state, seen, { kind: StudioResourceKind.LibraryAsset, id, graphPath });
      if (clipKind && audioClipKinds.has(clipKind)) {
        pushReference(state, seen, { kind: StudioResourceKind.Audio, id, graphPath, source: 'asset' });
      }
    }
  }

  const editedMasterOf = readId(state, node, 'editedMasterOf', graphPath);
  if (editedMasterOf) {
    pushReference(state, seen, { kind: StudioResourceKind.EditedMaster, id: editedMasterOf, graphPath });
  }

  for (const key of ['uploadId', 'importId']) {
    const id = readId(state, node, key, graphPath);
    if (id) {
      pushReference(state, seen, { kind: StudioResourceKind.ProjectImport, id, graphPath });
      if (clipKind && audioClipKinds.has(clipKind)) {
        pushReference(state, seen, { kind: StudioResourceKind.Audio, id, graphPath, source: 'import' });
      }
    }
  }

  const musicId = readId(state, node, 'musicId', graphPath);
  if (musicId) {
    pushReference(state, seen, { kind: StudioResourceKind.Audio, id: musicId, graphPath, source: 'catalog' });
  }

  for (const key of ['fontFamily', 'fontId']) {
    const value = node[key];
    if (typeof value === 'string' && value.length > 0) {
      if (isExternalLocator(value)) {
        pushIdViolation(state, graphPath, key, value);
      } else {
        pushReference(state, seen, { kind: StudioResourceKind.Font, id: value.slice(0, 128), graphPath });
      }
    }
  }

  const lutId = readId(state, node, 'lutId', graphPath);
  if (lutId) {
    pushReference(state, seen, {
      kind: StudioResourceKind.Lut,
      id: lutId,
      graphPath,
      lutSource: node.lutSource === 'import' ? 'import' : 'catalog',
    });
  }

  const modelId = readId(state, node, 'modelId', graphPath);
  if (modelId) {
    pushReference(state, seen, { kind: StudioResourceKind.Model, id: modelId, graphPath });
  }

  const graphicId = readId(state, node, 'graphicId', graphPath);
  if (graphicId) {
    pushReference(state, seen, { kind: StudioResourceKind.VectorGraphic, id: graphicId, graphPath });
  }

  const generatedId = readId(state, node, 'generatedId', graphPath);
  if (generatedId) {
    pushReference(state, seen, { kind: StudioResourceKind.GeneratedIntermediate, id: generatedId, graphPath });
    if (clipKind && audioClipKinds.has(clipKind)) {
      pushReference(state, seen, { kind: StudioResourceKind.Audio, id: generatedId, graphPath, source: 'generated' });
    }
  }

  const captionsImportId = readId(state, node, 'captionsImportId', graphPath);
  if (captionsImportId) {
    pushReference(state, seen, { kind: StudioResourceKind.Captions, id: captionsImportId, graphPath });
  }

  if (Array.isArray(node.captions) && node.captions.length > 0 && sequence) {
    pushReference(state, seen, {
      kind: StudioResourceKind.Captions,
      id: sequence,
      graphPath: `${graphPath}/captions`,
      inlineLines: node.captions.length,
    });
  }

  // Nested sequence placement: a clip of kind `sequence` (or `composition`) naming another sequence.
  if ((clipKind === 'sequence' || clipKind === 'composition') && 'sequenceId' in node) {
    const target = readId(state, node, 'sequenceId', graphPath);
    if (target) {
      pushReference(state, seen, { kind: StudioResourceKind.NestedSequence, id: target, graphPath });
      if (sequence) {
        state.sequences.get(sequence)?.push(target);
      }
    }
  }

  // Presets.
  if (isRecord(node.transitionIn)) {
    readPreset(state, seen, node.transitionIn.type, 'transition', `${graphPath}/transitionIn`);
  }
  if (isRecord(node.transitionOut)) {
    readPreset(state, seen, node.transitionOut.type, 'transition', `${graphPath}/transitionOut`);
  }
  if (isRecord(node.grade)) {
    readPreset(state, seen, node.grade.look, 'look', `${graphPath}/grade`);
  }
  if (clipKind === 'title') {
    readPreset(state, seen, node.style, 'titleStyle', graphPath);
    readPreset(state, seen, node.animation, 'titleAnimation', graphPath);
    readPreset(state, seen, node.position, 'titlePosition', graphPath);
  }
  if ('captionLanguage' in node) {
    readPreset(state, seen, node.captionLanguage, 'captionLanguage', graphPath);
  }

  // Locators and forbidden schemes.
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string') {
      continue;
    }
    if ((locatorKeys.has(key) && isExternalLocator(value)) || (!locatorKeys.has(key) && forbiddenSchemes.test(value))) {
      state.violations.push({
        reason: StudioRefusalReason.ExternalLocator,
        graphPath,
        detail: `${key}: ${value.slice(0, 120)}`,
      });
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === '$resource' || (value !== null && typeof value !== 'object')) {
      continue;
    }
    walk(value, `${graphPath}/${key}`, depth + 1, state, seen, sequence);
  }
};

/**
 * Enumerate every resource reference in a graph. Pure: no I/O, no access decisions. The result
 * is complete for the recognised keys, deduplicated by class and id, and bounded by the limits
 * above. Violations are collected rather than thrown so the caller can refuse all of them at once.
 */
export const extractStudioResourceReferences = (graph: unknown): StudioReferenceExtraction => {
  const state: StudioReferenceExtraction = { references: [], violations: [], sequences: new Map() };
  walk(graph, '', 0, state, new Set(), null);
  return state;
};

/** Serialized size of a graph, for the pre-enumeration size gate. */
export const measureStudioGraph = (graph: unknown): number => Buffer.byteLength(JSON.stringify(graph) ?? '', 'utf8');

/* ------------------------------------------------------------------ */
/* Nested sequences                                                     */
/* ------------------------------------------------------------------ */

export type StudioSequenceCheck = {
  refused: Array<{
    id: string;
    reason:
      StudioRefusalReason.UnknownSequence | StudioRefusalReason.CyclicSequence | StudioRefusalReason.DepthExceeded;
    detail: string;
  }>;
};

/**
 * Refuse unknown targets, cycles and over-deep nesting. A refused sequence id is refused once,
 * with the first reason found; the manifest entry for every nested-sequence reference to it is
 * then refused by the resolver.
 */
export const checkNestedSequences = (
  sequences: ReadonlyMap<string, readonly string[]>,
  maxDepth: number = STUDIO_MAX_SEQUENCE_DEPTH,
): StudioSequenceCheck => {
  const refused = new Map<string, StudioSequenceCheck['refused'][number]>();

  for (const [id, targets] of sequences) {
    for (const target of targets) {
      if (!sequences.has(target) && !refused.has(target)) {
        refused.set(target, {
          id: target,
          reason: StudioRefusalReason.UnknownSequence,
          detail: `Sequence ${id} nests ${target}, which the graph does not define.`,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const depths = new Map<string, number>();

  const visit = (id: string, depth: number, trail: string[]): number => {
    if (refused.has(id)) {
      return 0;
    }
    if (visiting.has(id)) {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(' -> ');
      for (const member of trail.slice(trail.indexOf(id))) {
        if (!refused.has(member)) {
          refused.set(member, {
            id: member,
            reason: StudioRefusalReason.CyclicSequence,
            detail: `Sequence nesting forms a cycle: ${cycle}.`,
          });
        }
      }
      return 0;
    }
    const known = depths.get(id);
    if (known !== undefined) {
      return known;
    }
    if (depth > maxDepth) {
      refused.set(id, {
        id,
        reason: StudioRefusalReason.DepthExceeded,
        detail: `Sequence nesting deeper than ${maxDepth} at ${[...trail, id].join(' -> ')}.`,
      });
      return 0;
    }

    visiting.add(id);
    let deepest = 0;
    for (const target of sequences.get(id) ?? []) {
      deepest = Math.max(deepest, 1 + visit(target, depth + 1, [...trail, id]));
    }
    visiting.delete(id);
    depths.set(id, deepest);
    return deepest;
  };

  for (const id of sequences.keys()) {
    visit(id, 0, []);
  }

  return { refused: refused.values().toArray() };
};

/* ------------------------------------------------------------------ */
/* Generated inventory                                                  */
/* ------------------------------------------------------------------ */

export const STUDIO_RESOURCE_INVENTORY_SCHEMA_VERSION = 1;

export type StudioResourceInventoryRow = {
  kind: StudioResourceKind;
  label: string;
  description: string;
  owner: StudioResourceOwner;
  accessCheck: StudioAccessCheck;
  egress: StudioEgressPolicy;
  retention: StudioRetention;
  fileBacked: boolean;
  carriesPersonalData: boolean;
  graphKeys: string[];
  refusals: StudioRefusalReason[];
};

export type StudioResourceInventory = {
  schemaVersion: typeof STUDIO_RESOURCE_INVENTORY_SCHEMA_VERSION;
  story: 'FL-90';
  planId: 'STU-203';
  generatedBy: 'server/src/utils/studio-resources.ts';
  limits: {
    maxGraphBytes: number;
    maxGraphDepth: number;
    maxReferences: number;
    maxSequenceDepth: number;
  };
  destinations: StudioDestination[];
  presets: Record<string, string[]>;
  resources: StudioResourceInventoryRow[];
  /** SHA-256 of the `resources` rows, so a hand edit to the JSON is detectable. */
  digest: string;
};

/**
 * The checked-in table, as data. `studio/resource-inventory.json` must equal this exactly; the
 * spec next to this module asserts it, and `server/src/bin/studio-resource-inventory.ts` prints it.
 */
export const buildStudioResourceInventory = (): StudioResourceInventory => {
  const resources: StudioResourceInventoryRow[] = studioResourceRegistry
    .values()
    .map((definition) => ({
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      owner: definition.owner,
      accessCheck: definition.accessCheck,
      egress: { ...definition.egress },
      retention: definition.retention,
      fileBacked: definition.fileBacked,
      carriesPersonalData: definition.carriesPersonalData,
      graphKeys: [...definition.graphKeys],
      refusals: [...new Set(definition.refusals)],
    }))
    .toArray();

  return {
    schemaVersion: STUDIO_RESOURCE_INVENTORY_SCHEMA_VERSION,
    story: 'FL-90',
    planId: 'STU-203',
    generatedBy: 'server/src/utils/studio-resources.ts',
    limits: {
      maxGraphBytes: STUDIO_MAX_GRAPH_BYTES,
      maxGraphDepth: STUDIO_MAX_GRAPH_DEPTH,
      maxReferences: STUDIO_MAX_REFERENCES,
      maxSequenceDepth: STUDIO_MAX_SEQUENCE_DEPTH,
    },
    destinations: [...studioDestinations],
    presets: Object.fromEntries(Object.entries(studioPresetFamilies).map(([family, values]) => [family, [...values]])),
    resources,
    digest: createHash('sha256').update(JSON.stringify(resources)).digest('hex'),
  };
};
