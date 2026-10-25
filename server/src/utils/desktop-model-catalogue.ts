import { createHash } from 'node:crypto';
import z from 'zod';
import { CLIP_MODEL_INFO } from 'src/constants.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { canonicalJson } from 'src/utils/object.js';
import { parseBoundOcrResult } from 'src/utils/ocr-result.js';

// Release-owned defaults; legacy keys remain available for already-bound work.
export const desktopImageModelKeys = Object.freeze({
  ocr: 'ocr:3b2197fd6849c9de1f6f09e155906e61a8a1a09060f76bff48b079d31c00483b',
  face: 'face:1b59a668f091b00db8be8b811a04f54eb5b633eab3f628cde2c90cfe86c7a1b9',
});

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\:]/.test(value) &&
      !/\p{Control}/u.test(value) &&
      value
        .split('/')
        .every(
          (part) =>
            !!part &&
            part !== '.' &&
            part !== '..' &&
            !/[. ]$/.test(part) &&
            !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split('.', 1)[0]),
        ),
  );
const model = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  task: z.enum(['clip', 'ocr', 'facial-recognition']),
  type: z.enum(['textual', 'visual', 'detection', 'recognition']),
  artifacts: z
    .record(relative, digest)
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 4096),
});
const spec = z.strictObject({
  protocolVersion: z.literal(1),
  modelKey: z.string().regex(/^(clip|ocr|face):[a-f0-9]{64}$/),
  provider: z.enum([
    'CPUExecutionProvider',
    'CUDAExecutionProvider',
    'CoreMLExecutionProvider',
    'OpenVINOExecutionProvider',
    'MIGraphXExecutionProvider',
  ]),
  models: z.array(model).min(1).max(2),
  entries: z.record(z.string(), z.json()),
  preprocessingSha256: digest,
  fixtureFile: relative.refine(
    (value) => !value.includes('/') && !['qualification.json', 'report.json'].includes(value),
  ),
  fixtureKind: z.enum(['text', 'image']),
  fixtureSha256: digest,
  expectedOutput: z.record(z.string(), z.json()),
  minMemoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deadlineSeconds: z.number().int().min(1).max(600),
});
const profile = z
  .strictObject({
    modelKey: z.string().regex(/^(clip|ocr|face):[a-f0-9]{64}$/),
    modelName: model.shape.name,
    workload: z.enum(['clip', 'ocr', 'face']),
    runtimeSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    modelSnapshotRevision: z.string().regex(/^[a-f0-9]{40}$/),
    embeddingDimensions: z.number().int().min(1).max(65_536).optional(),
    spec,
    fixtureBase64: z.string().min(1).max(22_369_624),
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
    const invalid = () => context.addIssue({ code: 'custom', message: 'desktop_model_profile_invalid' });
    const selected = value.spec.models[0];
    const identity = {
      protocolVersion: 1,
      entries: value.spec.entries,
      models: value.spec.models,
      preprocessingSha256: value.spec.preprocessingSha256,
    };
    if (
      value.modelKey !== value.spec.modelKey ||
      value.modelKey !== `${value.workload}:${sha(canonicalJson(identity))}` ||
      value.modelName !== selected.name ||
      value.spec.models.some(
        (item) =>
          item.name !== value.modelName ||
          item.task !== (value.workload === 'face' ? 'facial-recognition' : value.workload),
      ) ||
      (value.workload === 'clip' &&
        (value.spec.models.length !== 1 ||
          value.embeddingDimensions === undefined ||
          CLIP_MODEL_INFO[value.modelName]?.dimSize !== value.embeddingDimensions)) ||
      (value.workload === 'ocr' && value.embeddingDimensions !== undefined) ||
      (value.workload === 'face' && value.embeddingDimensions !== 512)
    )
      invalid();
    if (value.workload === 'clip') {
      const type = value.spec.fixtureKind === 'text' ? 'textual' : 'visual';
      const entry = value.spec.entries.clip;
      if (
        selected.type !== type ||
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).join(',') !== type
      )
        invalid();
      else {
        const actual = entry[type];
        if (
          !actual ||
          typeof actual !== 'object' ||
          Array.isArray(actual) ||
          actual.modelName !== value.modelName ||
          Object.keys(value.spec.entries).join(',') !== 'clip'
        )
          invalid();
      }
    } else {
      const entries = (
        value.workload === 'face'
          ? z.strictObject({
              'facial-recognition': z.strictObject({
                detection: z.strictObject({
                  modelName: z.literal(value.modelName),
                  options: z.strictObject({ minScore: z.number().min(0.1).max(1) }),
                }),
                recognition: z.strictObject({ modelName: z.literal(value.modelName) }),
              }),
            })
          : z.strictObject({
              ocr: z.strictObject({
                detection: z.strictObject({
                  modelName: z.literal(value.modelName),
                  options: z.strictObject({
                    minScore: z.number().min(0.1).max(1),
                    maxResolution: z.number().int().positive(),
                  }),
                }),
                recognition: z.strictObject({
                  modelName: z.literal(value.modelName),
                  options: z.strictObject({
                    minScore: z.number().min(0.1).max(1),
                  }),
                }),
              }),
            })
      ).safeParse(value.spec.entries);
      if (
        !entries.success ||
        value.spec.fixtureKind !== 'image' ||
        value.spec.models.length !== 2 ||
        value.spec.models
          .map((item) => item.type)
          .sort()
          .join(',') !== 'detection,recognition' ||
        value.spec.models.some((item) => canonicalJson(item.artifacts) !== canonicalJson(selected.artifacts))
      )
        invalid();
    }
    const ref = `models--frameleaf--${value.modelName}/refs/main`;
    if (
      selected.artifacts[ref] !== sha(value.modelSnapshotRevision) ||
      value.artifactBytes[ref] !== Buffer.byteLength(value.modelSnapshotRevision)
    )
      invalid();
    const names = Object.keys(selected.artifacts).sort();
    if (
      canonicalJson(names) !== canonicalJson(Object.keys(value.artifactBytes).sort()) ||
      new Set(names.map((name) => name.toLowerCase())).size !== names.length ||
      Object.values(value.artifactBytes).reduce((a, b) => a + b, 0) > 10 * 1024 ** 3
    )
      invalid();
    const fixture = Buffer.from(value.fixtureBase64, 'base64');
    if (
      fixture.length === 0 ||
      fixture.length > 16 * 1024 * 1024 ||
      fixture.toString('base64') !== value.fixtureBase64 ||
      sha(fixture) !== value.spec.fixtureSha256
    )
      invalid();
    if (value.spec.fixtureKind === 'text' && !Buffer.from(fixture.toString('utf8'), 'utf8').equals(fixture)) invalid();
    try {
      if (value.workload === 'face') {
        const result = parseBoundFaceResult(value.spec.expectedOutput);
        if (
          result['facial-recognition'].length === 0 ||
          fixture.length < 24 ||
          !fixture.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          fixture.readUInt32BE(16) !== result.imageWidth ||
          fixture.readUInt32BE(20) !== result.imageHeight
        )
          invalid();
      } else if (value.workload === 'ocr') {
        const result = parseBoundOcrResult(value.spec.expectedOutput);
        if (
          result.ocr.text.length === 0 ||
          fixture.length < 24 ||
          !fixture.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          fixture.readUInt32BE(16) !== result.imageWidth ||
          fixture.readUInt32BE(20) !== result.imageHeight
        )
          invalid();
      } else {
        const clip = value.spec.expectedOutput.clip;
        const vector: unknown = typeof clip === 'string' ? JSON.parse(clip) : null;
        if (
          !Array.isArray(vector) ||
          vector.length !== value.embeddingDimensions ||
          vector.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))
        )
          invalid();
        const keys = Object.keys(value.spec.expectedOutput).sort().join(',');
        if (value.spec.fixtureKind === 'text') {
          if (keys !== 'clip') invalid();
        } else if (
          keys !== 'clip,imageHeight,imageWidth' ||
          fixture.length < 24 ||
          !fixture.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          fixture.readUInt32BE(16) !== value.spec.expectedOutput.imageWidth ||
          fixture.readUInt32BE(20) !== value.spec.expectedOutput.imageHeight
        )
          invalid();
      }
    } catch {
      invalid();
    }
  });
const catalogueSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    epoch: z.number().int().positive(),
    profiles: z.array(profile).min(1).max(256),
  })
  .refine(
    (value) =>
      new Set(value.profiles.map((p) => `${p.modelKey}:${p.spec.provider}:${p.runtimeSourceRevision}`)).size ===
      value.profiles.length,
  );
export type DesktopModelCatalogue = z.infer<typeof catalogueSchema>;
export type DesktopModelProfile = z.infer<typeof profile>;

/** Validates release-owned catalogue data; parsing arbitrary data does not authorize a model grant. */
export const parseDesktopModelCatalogue = (value: unknown): DesktopModelCatalogue => catalogueSchema.parse(value);
export const matchDesktopModelProfile = (
  catalogue: DesktopModelCatalogue,
  modelName: string,
  entries: unknown,
  runtimeSourceRevision: string,
  provider: string,
): DesktopModelProfile | undefined =>
  catalogue.profiles.find(
    (profile) =>
      profile.modelName === modelName &&
      profile.runtimeSourceRevision === runtimeSourceRevision &&
      profile.spec.provider === provider &&
      canonicalJson(profile.spec.entries) === canonicalJson(entries),
  );

export const createDesktopModelChallenge = (profile: DesktopModelProfile, challengeId: string) => {
  const id = z
    .uuidv4()
    .refine((value) => value === value.toLowerCase())
    .parse(challengeId);
  const extension = profile.spec.fixtureKind === 'text' ? 'txt' : 'png';
  const specJson = canonicalJson({ ...profile.spec, fixtureFile: `${id}.${extension}` });
  return { specJson, bindingSha256: sha(specJson), fixtureBase64: profile.fixtureBase64 };
};
