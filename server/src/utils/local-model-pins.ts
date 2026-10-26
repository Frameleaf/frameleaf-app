import { createHash } from 'node:crypto';
import z from 'zod';
import { CLIP_MODEL_INFO } from 'src/constants.js';
import { canonicalJson } from 'src/utils/object.js';

/**
 * FL-455: the release's model pins for Frameleaf Cloud (`resources/desktop/model-pins.json`).
 *
 * A pin names a model exactly the way a desktop catalogue profile does (model name, snapshot
 * revision, every model file with its size and SHA-256, the request entries, the preprocessing
 * identity and the producer model key) without a qualification fixture or reference output, which
 * only a run of the signed native runtime with the model files can produce. Until that run exists the
 * pin lets `cloud-model-identity` compare a Cloud catalogue entry or result with the release pin, so
 * the Cloud search and face tiers exist for the pinned model; it never issues a desktop challenge
 * (`desktop-qualification.service` reads the catalogue only). A catalogue profile for the same model
 * supersedes its pin, so promoting a pin keeps its model key when the preprocessing identity is the
 * same.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(4096);
const model = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  task: z.enum(['clip', 'facial-recognition']),
  type: z.enum(['visual', 'detection', 'recognition']),
  artifacts: z.record(relative, digest).refine((value) => Object.keys(value).length > 0),
});
const pin = z
  .strictObject({
    workload: z.enum(['clip', 'face']),
    modelName: model.shape.name,
    modelKey: z.string().regex(/^(clip|face):[a-f0-9]{64}$/),
    modelSnapshotRevision: z.string().regex(/^[a-f0-9]{40}$/),
    embeddingDimensions: z.number().int().min(1).max(65_536),
    preprocessingSha256: digest,
    entries: z.record(z.string(), z.json()),
    models: z.array(model).min(1).max(2),
    artifactBytes: z.record(
      relative,
      z
        .number()
        .int()
        .min(0)
        .max(16 * 1024 ** 3),
    ),
  })
  .superRefine((value, context) => {
    const invalid = () => context.addIssue({ code: 'custom', message: 'local_model_pin_invalid' });
    const selected = value.models[0];
    const identity = {
      protocolVersion: 1,
      entries: value.entries,
      models: value.models,
      preprocessingSha256: value.preprocessingSha256,
    };
    if (
      value.modelKey !== `${value.workload}:${sha(canonicalJson(identity))}` ||
      value.models.some(
        (item) =>
          item.name !== value.modelName ||
          item.task !== (value.workload === 'face' ? 'facial-recognition' : 'clip') ||
          canonicalJson(item.artifacts) !== canonicalJson(selected.artifacts),
      )
    )
      invalid();
    if (value.workload === 'clip') {
      if (
        value.models.length !== 1 ||
        selected.type !== 'visual' ||
        CLIP_MODEL_INFO[value.modelName]?.dimSize !== value.embeddingDimensions ||
        canonicalJson(value.entries) !== canonicalJson({ clip: { visual: { modelName: value.modelName } } })
      )
        invalid();
    } else if (
      value.embeddingDimensions !== 512 ||
      value.models.map((item) => item.type).join(',') !== 'detection,recognition' ||
      !z
        .strictObject({
          'facial-recognition': z.strictObject({
            detection: z.strictObject({
              modelName: z.literal(value.modelName),
              options: z.strictObject({ minScore: z.number().min(0.1).max(1) }),
            }),
            recognition: z.strictObject({ modelName: z.literal(value.modelName) }),
          }),
        })
        .safeParse(value.entries).success
    )
      invalid();
    const ref = `models--frameleaf--${value.modelName}/refs/main`;
    const names = Object.keys(selected.artifacts).sort();
    if (
      selected.artifacts[ref] !== sha(value.modelSnapshotRevision) ||
      value.artifactBytes[ref] !== Buffer.byteLength(value.modelSnapshotRevision) ||
      canonicalJson(names) !== canonicalJson(Object.keys(value.artifactBytes).sort())
    )
      invalid();
  });
const schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    epoch: z.number().int().positive(),
    pins: z.array(pin).max(64),
  })
  .refine(
    (value) => new Set(value.pins.map((item) => `${item.workload}:${item.modelName}`)).size === value.pins.length,
  );

export type LocalModelPins = z.infer<typeof schema>;
export type LocalModelPin = LocalModelPins['pins'][number];

/** Validates release-owned pin data; parsing arbitrary data never offers the Cloud a model. */
export const parseLocalModelPins = (value: unknown): LocalModelPins => schema.parse(value);

/**
 * The shape a Cloud result ingestion needs from a pinned model, which both a desktop catalogue
 * profile (`DesktopModelProfile`) and a pin provide: the identity files, the producer key and what
 * the stored result looks like.
 */
export type LocalPinnedModel = {
  modelKey: string;
  modelName: string;
  /** The catalogue's workloads; a Cloud pin is only ever `clip` or `face`. */
  workload: 'clip' | 'face' | 'ocr';
  modelSnapshotRevision: string;
  embeddingDimensions?: number;
  artifactBytes: Record<string, number>;
  spec: {
    models: ReadonlyArray<{ artifacts: Record<string, string> }>;
    fixtureKind: 'text' | 'image';
  };
};

/** A pin in the shape a catalogue profile has for Cloud ingestion; pins always describe photo work. */
export const pinnedModelOf = (value: LocalModelPin): LocalPinnedModel => ({
  modelKey: value.modelKey,
  modelName: value.modelName,
  workload: value.workload,
  modelSnapshotRevision: value.modelSnapshotRevision,
  embeddingDimensions: value.embeddingDimensions,
  artifactBytes: value.artifactBytes,
  spec: { models: value.models, fixtureKind: 'image' },
});
