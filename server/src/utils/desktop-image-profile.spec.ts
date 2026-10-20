import { readFileSync } from 'node:fs';
import { defaults } from 'src/config.js';
import { desktopFaceProfile } from 'src/utils/desktop-face.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { desktopOcrProfile } from 'src/utils/desktop-ocr.js';

const catalogue = parseDesktopModelCatalogue(
  JSON.parse(readFileSync('resources/desktop/model-catalogue.json', 'utf8')),
);
it.each(['ocr', 'face'] as const)('selects the released %s identity and revalidates exact legacy tasks', (workload) => {
  const profiles = catalogue.profiles.filter((profile) => profile.workload === workload);
  const current = profiles.find(
    (profile) => profile.runtimeSourceRevision === '0d9702c68f31ea3eea068ac59ca1cf36a2b520fc',
  )!;
  const select = (key?: string) =>
    workload === 'ocr'
      ? desktopOcrProfile(defaults.machineLearning.ocr, key)
      : desktopFaceProfile(defaults.machineLearning.facialRecognition, key);
  expect(select().modelKey).toBe(current.modelKey);
  for (const profile of profiles) expect(select(profile.modelKey).modelKey).toBe(profile.modelKey);
  expect(() => select(`${workload}:${'0'.repeat(64)}`)).toThrow('desktop_pool_model_unavailable');
  const other = catalogue.profiles.find((profile) => profile.workload !== workload)!;
  expect(() => select(other.modelKey)).toThrow('desktop_pool_model_unavailable');
});
