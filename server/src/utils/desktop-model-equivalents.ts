import { type RawBuilder, sql } from 'kysely';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DesktopClipSpace, type DesktopClipSpaces, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { type DesktopModelCatalogue, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

/**
 * A desktop runtime revision gets model keys of its own, because a key covers the runtime's preprocessing
 * source. Two CLIP spaces are still the same embedding space when the release shows it: the same model
 * files and, for each request, the same answer to the same fixture. Vectors from either can share an index.
 */
const signature = (catalogue: DesktopModelCatalogue, key: string) => {
  const profile = catalogue.profiles.find((item) => item.modelKey === key);
  return (
    profile &&
    canonicalJson({
      modelName: profile.modelName,
      snapshot: profile.modelSnapshotRevision,
      dimensions: profile.embeddingDimensions ?? null,
      entries: profile.spec.entries,
      models: profile.spec.models,
      fixture: profile.spec.fixtureSha256,
      expected: profile.spec.expectedOutput,
    })
  );
};
const spaceSignature = (catalogue: DesktopModelCatalogue, space: DesktopClipSpace) =>
  canonicalJson([space.visualModelKey, ...space.textModelKeys].map((key) => signature(catalogue, key) ?? key).sort());

/** Every released space that is the same embedding space as `space`, itself included. */
export const compatibleClipSpaces = (
  spaces: DesktopClipSpaces,
  catalogue: DesktopModelCatalogue,
  space: DesktopClipSpace,
): DesktopClipSpace[] => {
  const wanted = spaceSignature(catalogue, space);
  return spaces.spaces.filter((item) => item.spaceKey === space.spaceKey || spaceSignature(catalogue, item) === wanted);
};

let released: { catalogue: DesktopModelCatalogue; spaces: DesktopClipSpaces } | undefined;
const load = () => {
  if (!released) {
    const read = (name: string) =>
      JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop', name), 'utf8'));
    const catalogue = parseDesktopModelCatalogue(read('model-catalogue.json'));
    released = { catalogue, spaces: parseDesktopClipSpaces(read('model-spaces.json'), catalogue) };
  }
  return released;
};

const equivalents = new Map<string, readonly string[]>();
/**
 * The keys a desktop may hold to run a task made for `modelKey`: the key itself and, for CLIP, the same
 * encoder (same request, same space) under other desktop runtime revisions. Face and OCR have one key.
 */
export const equivalentDesktopModelKeys = (modelKey: string): readonly string[] => {
  const known = equivalents.get(modelKey);
  if (known) return known;
  let keys = [modelKey];
  if (modelKey.startsWith('clip:')) {
    const { catalogue, spaces } = load();
    const own = signature(catalogue, modelKey);
    const space = spaces.spaces.find((item) => [item.visualModelKey, ...item.textModelKeys].includes(modelKey));
    if (own && space)
      keys = [
        ...new Set([
          modelKey,
          ...compatibleClipSpaces(spaces, catalogue, space)
            .flatMap((item) => [item.visualModelKey, ...item.textModelKeys])
            .filter((key) => signature(catalogue, key) === own),
        ]),
      ];
  }
  const frozen = Object.freeze(keys);
  equivalents.set(modelKey, frozen);
  return frozen;
};

let spaceOfKey: string | undefined;
/**
 * SQL for the embedding space a stored vector's producer key (`column`) stands for: one value for every key
 * of the same encoder, whichever runtime revision made the vector. Photos are compared by this, not by the
 * key itself, so vectors a library holds under two keys of one encoder still match each other.
 */
export const clipSpaceOf = (column: string): RawBuilder<string | null> => {
  if (spaceOfKey === undefined) {
    const { catalogue } = load();
    const map: Record<string, string> = {};
    for (const profile of catalogue.profiles) {
      if (profile.workload !== 'clip') continue;
      const first = [...equivalentDesktopModelKeys(profile.modelKey)].sort()[0];
      if (first !== profile.modelKey) map[profile.modelKey] = first;
    }
    spaceOfKey = JSON.stringify(map);
  }
  return sql<string | null>`coalesce(${spaceOfKey}::text::jsonb ->> ${sql.ref(column)}, ${sql.ref(column)})`;
};
