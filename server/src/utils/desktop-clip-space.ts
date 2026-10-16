import { createHash } from 'node:crypto';
import z from 'zod';
import {
  type DesktopModelCatalogue,
  type DesktopModelProfile,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

const modelKey = z.string().regex(/^clip:[a-f0-9]{64}$/);
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  epoch: z.number().int().positive(),
  spaces: z
    .array(
      z.strictObject({
        spaceKey: z.string().regex(/^clip-space:[a-f0-9]{64}$/),
        visualModelKey: modelKey,
        textModelKeys: z.array(modelKey).min(1).max(32),
      }),
    )
    .min(1)
    .max(64),
});
export type DesktopClipSpaces = z.infer<typeof schema>;
export type DesktopClipSpace = DesktopClipSpaces['spaces'][number];
const common = (profile: DesktopModelProfile) =>
  canonicalJson({
    modelName: profile.modelName,
    snapshot: profile.modelSnapshotRevision,
    dimensions: profile.embeddingDimensions,
    preprocessing: profile.spec.preprocessingSha256,
    artifacts: profile.spec.models[0].artifacts,
  });

/** Release-owned pairs declare semantic compatibility; parsing client data never grants index authority. */
export const parseDesktopClipSpaces = (value: unknown, catalogue: DesktopModelCatalogue): DesktopClipSpaces => {
  const spaces = schema.parse(value);
  const models = parseDesktopModelCatalogue(catalogue);
  const used = new Set<string>();
  for (const space of spaces.spaces) {
    const invalid = (): never => {
      throw new Error('desktop_clip_space_invalid');
    };
    const digest = createHash('sha256')
      .update(
        canonicalJson({
          visualModelKey: space.visualModelKey,
          textModelKeys: [...space.textModelKeys].sort(),
        }),
      )
      .digest('hex');
    if (space.spaceKey !== `clip-space:${digest}`) invalid();
    const visual = models.profiles.find((p) => p.modelKey === space.visualModelKey) ?? invalid();
    for (const key of [space.visualModelKey, ...space.textModelKeys]) {
      if (used.has(key)) invalid();
      used.add(key);
      const profiles = models.profiles.filter((p) => p.modelKey === key);
      const kind = key === space.visualModelKey ? 'image' : 'text';
      if (profiles.length === 0 || profiles.some((p) => p.spec.fixtureKind !== kind || common(p) !== common(visual)))
        invalid();
    }
  }
  return spaces;
};
export const findDesktopClipSpace = (catalogue: DesktopClipSpaces, key: string): DesktopClipSpace | undefined =>
  catalogue.spaces.find((space) => space.visualModelKey === key || space.textModelKeys.includes(key));
