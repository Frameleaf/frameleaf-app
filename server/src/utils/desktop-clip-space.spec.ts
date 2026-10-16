import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDesktopClipSpace, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

const models = () =>
  parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
  );
const raw = (): {
  schemaVersion: number;
  epoch: number;
  spaces: { spaceKey: string; visualModelKey: string; textModelKeys: string[] }[];
} => JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-spaces.json'), 'utf8'));
const key = (space: { visualModelKey: string; textModelKeys: string[] }) =>
  `clip-space:${createHash('sha256')
    .update(canonicalJson({ visualModelKey: space.visualModelKey, textModelKeys: [...space.textModelKeys].sort() }))
    .digest('hex')}`;
it('maps every released exact text/image producer to its explicit space without joining old and new preprocessing', () => {
  const catalogue = models();
  const spaces = parseDesktopClipSpaces(raw(), catalogue);
  expect(spaces.spaces).toHaveLength(2);
  expect(spaces.spaces[0].spaceKey).not.toBe(spaces.spaces[1].spaceKey);
  for (const profile of catalogue.profiles) {
    if (profile.workload !== 'clip') {
      expect(findDesktopClipSpace(spaces, profile.modelKey)).toBeUndefined();
      continue;
    }
    const space = findDesktopClipSpace(spaces, profile.modelKey)!;
    expect(space).toBeDefined();
    expect(space.spaceKey).toBe(key(space));
    expect(
      profile.spec.fixtureKind === 'image'
        ? space.visualModelKey === profile.modelKey
        : space.textModelKeys.includes(profile.modelKey),
    ).toBe(true);
  }
  expect(findDesktopClipSpace(spaces, `clip:${'0'.repeat(64)}`)).toBeUndefined();
});
it('refuses unknown producers, wrong roles, changed membership, duplicate spaces and cross-preprocessing pairs', () => {
  const original = raw();
  for (const change of [
    (v: typeof original) => {
      v.spaces[0].spaceKey = `clip-space:${'0'.repeat(64)}`;
    },
    (v: typeof original) => {
      v.spaces[0].visualModelKey = `clip:${'0'.repeat(64)}`;
      v.spaces[0].spaceKey = key(v.spaces[0]);
    },
    (v: typeof original) => {
      v.spaces[0].visualModelKey = v.spaces[0].textModelKeys[0];
      v.spaces[0].spaceKey = key(v.spaces[0]);
    },
    (v: typeof original) => {
      v.spaces[0].textModelKeys = [v.spaces[0].visualModelKey];
      v.spaces[0].spaceKey = key(v.spaces[0]);
    },
    (v: typeof original) => {
      v.spaces[0].textModelKeys.push(v.spaces[0].textModelKeys[0]);
      v.spaces[0].spaceKey = key(v.spaces[0]);
    },
    (v: typeof original) => {
      v.spaces[0].textModelKeys = v.spaces[1].textModelKeys;
      v.spaces[0].spaceKey = key(v.spaces[0]);
    },
    (v: typeof original) => {
      v.spaces.push(v.spaces[0]);
    },
    (v: typeof original) => {
      Object.assign(v.spaces[0], { provider: 'CPUExecutionProvider' });
    },
  ]) {
    const value = structuredClone(original);
    change(value);
    expect(() => parseDesktopClipSpaces(value, models())).toThrow();
  }
});
it('keeps logical embedding identity separate from runtime/provider qualification', () => {
  const catalogue = models();
  const variant = structuredClone(catalogue.profiles[0]);
  variant.spec.provider = 'CUDAExecutionProvider';
  catalogue.profiles.push(variant);
  expect(parseDesktopClipSpaces(raw(), parseDesktopModelCatalogue(catalogue))).toEqual(
    parseDesktopClipSpaces(raw(), models()),
  );
});

it('does not pair matching names and dimensions when their approved artifact bytes differ', () => {
  const catalogue = models();
  const spaces = raw();
  const visual = catalogue.profiles.find((p) => p.modelKey === spaces.spaces[0].visualModelKey)!;
  visual.spec.models[0].artifacts['visual/model.onnx'] = '0'.repeat(64);
  visual.modelKey = visual.spec.modelKey = `clip:${createHash('sha256')
    .update(
      canonicalJson({
        protocolVersion: 1,
        entries: visual.spec.entries,
        models: visual.spec.models,
        preprocessingSha256: visual.spec.preprocessingSha256,
      }),
    )
    .digest('hex')}`;
  spaces.spaces[0].visualModelKey = visual.modelKey;
  spaces.spaces[0].spaceKey = key(spaces.spaces[0]);
  expect(() => parseDesktopModelCatalogue(catalogue)).not.toThrow();
  expect(() => parseDesktopClipSpaces(spaces, catalogue)).toThrow('desktop_clip_space_invalid');
});
