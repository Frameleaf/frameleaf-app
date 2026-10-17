import { readFileSync } from 'node:fs';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';

it('keeps approved CLIP dimensions and refuses another workload as a CLIP producer', () => {
  const clip = parseDesktopModelCatalogue(JSON.parse(readFileSync('resources/desktop/model-catalogue.json', 'utf8')))
    .profiles[0];
  expect(parseBoundClipResult(clip.spec.expectedOutput, clip).modelKey).toBe(clip.modelKey);
  const ocr = parseDesktopModelCatalogue({
    schemaVersion: 1,
    epoch: 4,
    profiles: [JSON.parse(readFileSync('test/fixtures/desktop-ocr-profile.json', 'utf8'))],
  }).profiles[0];
  expect(() => parseBoundClipResult({ clip: '[0]', imageWidth: 768, imageHeight: 320 }, ocr)).toThrow(
    'producer_result_invalid',
  );
});
