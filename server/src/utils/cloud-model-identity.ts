import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from 'zod';
import { MlWorkload } from 'src/enum.js';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import { type DesktopClipSpaces, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import {
  type DesktopModelCatalogue,
  type DesktopModelProfile,
  desktopImageModelKeys,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { canonicalJson } from 'src/utils/object.js';

/**
 * FL-455: the model-identity guard for Frameleaf Cloud smart search (image embeddings) and faces.
 *
 * A Cloud result is only usable when it was made by exactly the model this server would have used:
 * the same model, repository, snapshot revision, model files (path, size, SHA-256), preprocessing
 * version and output. Anything else would put vectors from another embedding space into the library,
 * so it is rejected and the work runs on this network instead. The same identity decides whether the
 * Cloud is offered at all: a catalogue entry for `clip` or `face` is only matched when its identity
 * equals the local pin.
 *
 * The local pin is the release-owned model catalogue the desktop helpers already bind to
 * (`resources/desktop/model-catalogue.json`, `model-spaces.json`), so a Cloud result is ingested
 * exactly like a bound desktop or home-network result (`parseBoundClipResult`,
 * `parseBoundFaceResult`), carrying the same producer model key.
 *
 * The wire shape is the Cloud contract's `ModelIdentity` (frameleaf-cloud `docs/ml/clip-and-faces.md`
 * §2); it lives only in `cloudModelIdentitySchema` below. Which models may run on the Cloud is data:
 * the release pin and the catalogue, never a list in code.
 */

/** The work the guard covers. OCR and pet recognition never take a Cloud result. */
export const CLOUD_IDENTITY_WORKLOADS = [MlWorkload.Clip, MlWorkload.Face] as const;
export type CloudIdentityWorkload = (typeof CLOUD_IDENTITY_WORKLOADS)[number];

export const isCloudIdentityWorkload = (workload: MlWorkload): workload is CloudIdentityWorkload =>
  (CLOUD_IDENTITY_WORKLOADS as readonly MlWorkload[]).includes(workload);

/**
 * The preprocessing this server's ML service runs, as the contract names its versions
 * (`frameleaf_ml/models/clip/visual.py`, `facial_recognition/`). A change there is a new version.
 */
export const LOCAL_PREPROCESS_VERSIONS: Readonly<Record<CloudIdentityWorkload, string>> = Object.freeze({
  [MlWorkload.Clip]: 'frameleaf-clip-visual/1',
  [MlWorkload.Face]: 'frameleaf-face/2',
});

const SNAPSHOT_REF = /^models--[^/]+\/refs\//;

/**
 * The pinned files an identity names: every model file of the release pin that decides the output of
 * that work, read from the pin itself so a newly pinned model needs no code change. Snapshot refs,
 * dotfiles and read-me files are not model files; smart search leaves out the text encoder, which
 * always runs on this server.
 */
export const identityFilePaths = (workload: CloudIdentityWorkload, artifacts: Record<string, string>): string[] =>
  Object.keys(artifacts)
    .filter(
      (path) =>
        !SNAPSHOT_REF.test(path) &&
        path.split('/').every((part) => !part.startsWith('.')) &&
        !/\.md$/i.test(path) &&
        (workload !== MlWorkload.Clip || !path.startsWith('textual/')),
    )
    .sort();

const sha256 = z.string().regex(/^[\da-f]{64}$/);
const modelName = z.string().regex(/^[\w.-]{1,128}$/);

/**
 * What Frameleaf Cloud says made a model or a result (the contract's `ModelIdentity`). Only this
 * server's release pin and the Frameleaf model mirror (`frameleaf/<name>`) are compared; any other key
 * on the wire is dropped and never stored.
 */
export const cloudModelIdentitySchema = z.object({
  /** The server's model name (`machineLearning.clip.modelName`, `facialRecognition.modelName`). */
  name: modelName,
  /** What the server downloads, `frameleaf/<name>`. */
  repo: z.string().regex(/^[\w.-]{1,96}\/[\w.-]{1,128}$/),
  /** The immutable snapshot revision (a 40-character commit). */
  revision: z.string().regex(/^[\da-f]{40}$/),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        bytes: z.number().int().min(0),
        sha256,
      }),
    )
    .min(1)
    .max(64),
  /** The preprocessing version (`frameleaf-clip-visual/1`, `frameleaf-face/2`). */
  preprocess: z.string().min(1).max(64),
  output: z.object({
    dim: z.number().int().min(1).max(65_536),
    dtype: z.literal('float32'),
    normalized: z.boolean(),
  }),
});
export type CloudModelIdentity = z.infer<typeof cloudModelIdentitySchema>;

/** The identity of a release-owned local profile for `workload`, in the Cloud's terms. */
export const modelIdentityOf = (workload: CloudIdentityWorkload, profile: DesktopModelProfile): CloudModelIdentity => {
  const artifacts = profile.spec.models[0].artifacts;
  return {
    name: profile.modelName,
    repo: `frameleaf/${profile.modelName}`,
    revision: profile.modelSnapshotRevision,
    files: identityFilePaths(workload, artifacts).map((path) => ({
      path,
      bytes: profile.artifactBytes[path] ?? 0,
      sha256: artifacts[path],
    })),
    preprocess: LOCAL_PREPROCESS_VERSIONS[workload],
    // the server stores vectors exactly as its ML service returns them, without L2 normalisation
    output: {
      dim: workload === MlWorkload.Face ? 512 : (profile.embeddingDimensions ?? 0),
      dtype: 'float32',
      normalized: false,
    },
  };
};

const filesKey = (files: CloudModelIdentity['files']) =>
  canonicalJson([...files].sort((a, b) => a.path.localeCompare(b.path)));

/** Whether two identities name the same model run the same way; file order never matters. */
export const sameModelIdentity = (a: CloudModelIdentity, b: CloudModelIdentity): boolean =>
  identityDifference(a, b) === null;

/** What differs between a claimed identity and the pin, in plain words, or null when nothing does. */
export const identityDifference = (claimed: CloudModelIdentity, pin: CloudModelIdentity): string | null => {
  if (claimed.name !== pin.name || claimed.repo !== pin.repo) {
    return `it was made by ${claimed.repo}, not ${pin.repo}`;
  }
  if (claimed.revision !== pin.revision) {
    return `it was made by revision ${claimed.revision}, not ${pin.revision}`;
  }
  if (filesKey(claimed.files) !== filesKey(pin.files)) {
    return 'its model files do not match this server';
  }
  if (claimed.preprocess !== pin.preprocess) {
    return `its preprocessing ${claimed.preprocess} is not ${pin.preprocess}`;
  }
  if (canonicalJson(claimed.output) !== canonicalJson(pin.output)) {
    return 'its output does not match this server';
  }
  return null;
};

export type ReleasedModels = { catalogue: DesktopModelCatalogue; spaces: DesktopClipSpaces };
let released: ReleasedModels | undefined;
const releasedModels = (): ReleasedModels => {
  if (!released) {
    const read = (name: string): unknown =>
      JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop', name), 'utf8'));
    const catalogue = parseDesktopModelCatalogue(read('model-catalogue.json'));
    released = { catalogue, spaces: parseDesktopClipSpaces(read('model-spaces.json'), catalogue) };
  }
  return released;
};

/**
 * This server's pinned profile for Cloud work of `workload` with the configured `modelName`, or null
 * when the release does not pin that model (then the Cloud is never offered for it). Smart search uses
 * the image profile of the newest released CLIP space; faces use the release's face model key.
 */
export const localPinnedProfile = (
  workload: CloudIdentityWorkload,
  modelName: string,
  models: ReleasedModels = releasedModels(),
): DesktopModelProfile | null => {
  const { catalogue, spaces } = models;
  if (workload === MlWorkload.Face) {
    return (
      catalogue.profiles.find(
        (profile) =>
          profile.workload === 'face' &&
          profile.modelKey === desktopImageModelKeys.face &&
          profile.modelName === modelName,
      ) ?? null
    );
  }
  for (const space of spaces.spaces.toReversed()) {
    const visual = catalogue.profiles.find(
      (profile) =>
        profile.modelKey === space.visualModelKey &&
        profile.workload === 'clip' &&
        profile.spec.fixtureKind === 'image' &&
        profile.modelName === modelName,
    );
    if (visual) {
      return visual;
    }
  }
  return null;
};

/** The pinned identity for `workload` with `modelName`, or null when the release pins none. */
export const localPinnedIdentity = (
  workload: CloudIdentityWorkload,
  modelName: string,
  models?: ReleasedModels,
): CloudModelIdentity | null => {
  const profile = localPinnedProfile(workload, modelName, models);
  return profile ? modelIdentityOf(workload, profile) : null;
};

/**
 * The catalogue model SKU that runs exactly this server's pinned model for each guarded workload,
 * among `entries` already accepted by the catalogue schema. A workload without such an entry is left
 * out, which keeps Frameleaf Cloud from being offered for it.
 */
export const matchLocalModels = (
  entries: ReadonlyArray<{ sku: string; workload: string; identity: CloudModelIdentity | null }>,
  modelNames: Partial<Record<CloudIdentityWorkload, string>>,
  models?: ReleasedModels,
): Partial<Record<CloudIdentityWorkload, string>> => {
  const matched: Partial<Record<CloudIdentityWorkload, string>> = {};
  for (const workload of CLOUD_IDENTITY_WORKLOADS) {
    const modelName = modelNames[workload];
    const pin = modelName ? localPinnedIdentity(workload, modelName, models) : null;
    if (!pin) {
      continue;
    }
    const entry = entries.find(
      (candidate) =>
        candidate.workload === workload && candidate.identity && sameModelIdentity(candidate.identity, pin),
    );
    if (entry) {
      matched[workload] = entry.sku;
    }
  }
  return matched;
};

/** A Cloud result made by another model than this server's pin; the work runs locally instead. */
export class CloudModelIdentityMismatchError extends Error {
  constructor(
    readonly workload: CloudIdentityWorkload,
    readonly reason: string,
  ) {
    super(`Frameleaf Cloud ${workload} result was rejected: ${reason}`);
    this.name = 'CloudModelIdentityMismatchError';
  }
}

/** Why a claimed identity is not the local pin for `workload`, or null when it is. */
export const cloudIdentityProblem = (
  workload: CloudIdentityWorkload,
  profile: DesktopModelProfile | null,
  claimed: unknown,
): string | null => {
  if (!profile) {
    return 'this server pins no model for it';
  }
  const parsed = cloudModelIdentitySchema.safeParse(claimed);
  if (!parsed.success) {
    return 'it carries no valid model identity';
  }
  return identityDifference(parsed.data, modelIdentityOf(workload, profile));
};

/** One Cloud result as the ingestion receives it: the model identity it claims and its payload. */
export type CloudModelResult = { identity: unknown; result: unknown };

/**
 * Accept a Cloud smart-search result only when it was made by the pinned image model; it is then the
 * same `{ embedding, modelKey }` a bound local or desktop result is, and is stored the same way.
 */
export const acceptCloudClipResult = (profile: DesktopModelProfile | null, value: CloudModelResult) => {
  const problem = cloudIdentityProblem(MlWorkload.Clip, profile, value.identity);
  if (problem || !profile) {
    throw new CloudModelIdentityMismatchError(MlWorkload.Clip, problem ?? 'this server pins no model for it');
  }
  return parseBoundClipResult(value.result, profile);
};

/** Accept a Cloud face result only when it was made by the pinned face model (see above). */
export const acceptCloudFaceResult = (profile: DesktopModelProfile | null, value: CloudModelResult) => {
  const problem = cloudIdentityProblem(MlWorkload.Face, profile, value.identity);
  if (problem || !profile) {
    throw new CloudModelIdentityMismatchError(MlWorkload.Face, problem ?? 'this server pins no model for it');
  }
  return parseBoundFaceResult(value.result);
};

/**
 * The ingestion hook every Cloud smart-search or face result goes through: `cloud` runs the Cloud
 * job, `accept` checks its identity (`acceptCloudClipResult`, `acceptCloudFaceResult`), and a rejected
 * result runs `local` instead, on this network. Other failures are not retried here.
 */
export const withCloudIdentityGuard = async <T>({
  cloud,
  accept,
  local,
  onRejected,
}: {
  cloud: () => Promise<CloudModelResult>;
  accept: (value: CloudModelResult) => T;
  local: () => Promise<T>;
  onRejected?: (error: CloudModelIdentityMismatchError) => void;
}): Promise<T> => {
  const value = await cloud();
  try {
    return accept(value);
  } catch (error) {
    if (!(error instanceof CloudModelIdentityMismatchError)) {
      throw error;
    }
    onRejected?.(error);
    return local();
  }
};
