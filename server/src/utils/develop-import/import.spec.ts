import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { developEnvelope, preserveDevelopEnvelope, renderDevelopProjection } from 'src/utils/develop-envelope.js';
import { importDarktable } from 'src/utils/develop-import/darktable.js';
import { importLightroom } from 'src/utils/develop-import/lightroom.js';
import { readDevelopXmp } from 'src/utils/develop-import/xmp.js';
import { importedColor } from 'src/utils/develop-recipe.js';

const fixture = (name: string) =>
  readDevelopXmp(readFileSync(join(process.cwd(), 'test/fixtures/develop-import', `${name}.xmp`)));
describe('XMP develop imports', () => {
  it.each([
    ['lightroom-exposure', { exposure: 1.25, contrast: 15 }],
    ['lightroom-crop', { crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.6 }, straighten: 2.5 }],
    [
      'lightroom-curve',
      {
        imported: {
          curve: [
            { x: 0, y: 0 },
            { x: 128 / 255, y: 150 / 255 },
            { x: 1, y: 1 },
          ],
        },
      },
    ],
    ['lightroom-hsl', { imported: { lightroom: { HueAdjustmentBlue: '20' } } }],
    ['lightroom-white-balance', { tint: 12, vignette: 30 }],
    [
      'lightroom-opaque',
      { imported: { lightroom: { CameraProfile: 'Custom camera profile', LocalCorrections: ['opaque mask data'] } } },
    ],
  ])('maps the hand-authored %s fixture', (name, expected) => {
    const recipe = importLightroom(fixture(name as string));
    expect(recipe).toMatchObject(expected);
    expect(() => renderDevelopProjection(developEnvelope(recipe))).not.toThrow();
  });
  it.each([
    ['darktable-exposure', { exposure: 1.5 }],
    ['darktable-temperature', { temperature: 16.6015, tint: 32.2942 }],
    ['darktable-crop', { crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.6 } }],
    [
      'darktable-colorbalancergb',
      { shadows: 20, highlights: -10, saturation: 10, brilliance: 15, vibrance: 20, contrast: 30 },
    ],
  ])('maps pinned %s binary fields', (name, expected) => {
    expect(importDarktable(fixture(name as string))).toMatchObject(expected);
  });
  it('preserves unsupported settings through a later edit', () => {
    const recipe = developEnvelope(importLightroom(fixture('lightroom-opaque')));
    const edited = preserveDevelopEnvelope(recipe, { version: 1, exposure: 0.5 });
    expect(edited.imported).toEqual(recipe.imported);
    expect(renderDevelopProjection(edited).exposure).toBe(0.5);
  });
  it('applies the imported tone curve and HSL', () => {
    expect(
      importedColor([0.5, 0.5, 0.5], {
        curve: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.7 },
          { x: 1, y: 1 },
        ],
      }),
    ).toEqual([0.7, 0.7, 0.7]);
    const hsl = Array.from({ length: 8 }, () => ({ hue: 0, saturation: -100, luminance: 0 }));
    expect(importedColor([1, 0, 0], { hsl })).toEqual([0.5, 0.5, 0.5]);
  });
  it('rejects XML entities and wrong namespaces', () => {
    expect(() => readDevelopXmp(Buffer.from('<!DOCTYPE x [<!ENTITY x "bad">]><x/>'))).toThrow();
    expect(
      importLightroom(
        readDevelopXmp(
          Buffer.from(
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:crs="https://invalid.test/"><rdf:Description crs:Exposure2012="2"/></rdf:RDF>',
          ),
        ),
      ),
    ).toBeUndefined();
  });
});
