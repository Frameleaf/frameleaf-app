import { readFileSync } from 'node:fs';
import { parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { compatibleClipSpaces, equivalentDesktopModelKeys } from 'src/utils/desktop-model-equivalents.js';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../resources/desktop/${name}`, import.meta.url), 'utf8'));
const catalogue = parseDesktopModelCatalogue(read('model-catalogue.json'));
const spaces = parseDesktopClipSpaces(read('model-spaces.json'), catalogue);
const modelOf = (key: string) => catalogue.profiles.find((profile) => profile.modelKey === key)!;

describe('the same embedding space across desktop runtime revisions', () => {
  it('groups the released spaces of one model, and never mixes models', () => {
    for (const space of spaces.spaces) {
      const family = compatibleClipSpaces(spaces, catalogue, space);
      expect(family).toContainEqual(space);
      const name = modelOf(space.visualModelKey).modelName;
      expect(new Set(family.map((item) => modelOf(item.visualModelKey).modelName))).toEqual(new Set([name]));
      // every released space of this model is the same space: the release has one set of files and answers
      expect(family).toHaveLength(
        spaces.spaces.filter((item) => modelOf(item.visualModelKey).modelName === name).length,
      );
    }
    expect(
      new Set(spaces.spaces.map((space) => compatibleClipSpaces(spaces, catalogue, space).length)).size,
    ).toBeGreaterThan(1);
  });

  it('lets a desktop on another runtime revision run the same encoder, and only that encoder', () => {
    const [space] = spaces.spaces;
    const family = compatibleClipSpaces(spaces, catalogue, space);
    const visual = equivalentDesktopModelKeys(space.visualModelKey);
    expect([...visual].sort()).toEqual(family.map((item) => item.visualModelKey).sort());
    for (const key of space.textModelKeys) {
      const same = equivalentDesktopModelKeys(key);
      expect(same).toContain(key);
      expect(same).toHaveLength(family.length);
      expect(new Set(same.map((item) => canonical(modelOf(item).spec.entries)))).toEqual(
        new Set([canonical(modelOf(key).spec.entries)]),
      );
      expect(same.some((item) => visual.includes(item))).toBe(false);
    }
  });

  it('gives face, OCR and unknown keys only themselves', () => {
    const face = catalogue.profiles.find((profile) => profile.workload === 'face')!.modelKey;
    expect(equivalentDesktopModelKeys(face)).toEqual([face]);
    expect(equivalentDesktopModelKeys(`clip:${'0'.repeat(64)}`)).toEqual([`clip:${'0'.repeat(64)}`]);
  });
});
const canonical = (value: unknown) => JSON.stringify(value);
