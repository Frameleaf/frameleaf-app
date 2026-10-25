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
    (profile) => profile.runtimeSourceRevision === 'f2c451a6bf71ca3f3aec986e07f0852937268e2f',
  )!;
  const select = (key?: string) =>
    workload === 'ocr'
      ? desktopOcrProfile(defaults.machineLearning.ocr, key)
      : desktopFaceProfile(defaults.machineLearning.facialRecognition, key);
  const currentVariants = profiles.filter((profile) => profile.modelKey === current.modelKey);
  expect(currentVariants.map((profile) => profile.spec.provider)).toEqual([
    'CPUExecutionProvider',
    'CoreMLExecutionProvider',
    'CUDAExecutionProvider',
    'OpenVINOExecutionProvider',
    'CPUExecutionProvider',
    'CoreMLExecutionProvider',
  ]);
  expect(new Set(currentVariants.map((profile) => profile.runtimeSourceRevision))).toEqual(
    new Set(['f2c451a6bf71ca3f3aec986e07f0852937268e2f', '088560702a69022b6eee705d8a67306f1075cea0']),
  );
  expect(select().modelKey).toBe(current.modelKey);
  if (workload === 'ocr') {
    expect(() =>
      desktopOcrProfile({ ...defaults.machineLearning.ocr, minDetectionScore: 0.6 }, current.modelKey),
    ).toThrow('desktop_pool_model_unavailable');
  } else {
    expect(() =>
      desktopFaceProfile({ ...defaults.machineLearning.facialRecognition, minScore: 0.8 }, current.modelKey),
    ).toThrow('desktop_pool_model_unavailable');
  }
  for (const profile of profiles) expect(select(profile.modelKey).modelKey).toBe(profile.modelKey);
  expect(() => select(`${workload}:${'0'.repeat(64)}`)).toThrow('desktop_pool_model_unavailable');
  const other = catalogue.profiles.find((profile) => profile.workload !== workload)!;
  expect(() => select(other.modelKey)).toThrow('desktop_pool_model_unavailable');
});
