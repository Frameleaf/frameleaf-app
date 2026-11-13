import { readFileSync } from 'node:fs';
import { defaults } from 'src/config.js';
import { desktopFaceProfile } from 'src/utils/desktop-face.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { desktopOcrProfile } from 'src/utils/desktop-ocr.js';

const catalogue = parseDesktopModelCatalogue(
  JSON.parse(readFileSync('resources/desktop/model-catalogue.json', 'utf8')),
);
it.each(['ocr', 'face'] as const)('selects the released %s identity and revalidates exact legacy tasks', (workload) => {
  const modelName =
    workload === 'ocr' ? defaults.machineLearning.ocr.modelName : defaults.machineLearning.facialRecognition.modelName;
  const profiles = catalogue.profiles.filter(
    (profile) => profile.workload === workload && profile.modelName === modelName,
  );
  const current = profiles.find(
    (profile) => profile.runtimeSourceRevision === 'f2c451a6bf71ca3f3aec986e07f0852937268e2f',
  )!;
  const select = (key?: string) =>
    workload === 'ocr'
      ? desktopOcrProfile(defaults.machineLearning.ocr, key)
      : desktopFaceProfile(defaults.machineLearning.facialRecognition, key);
  const currentVariants = profiles.filter((profile) => profile.modelKey === current.modelKey);
  // once for runtime f2c451a6 and once for its epoch 14 twin source: the same key on every provider
  const providers = [
    'CPUExecutionProvider',
    'CoreMLExecutionProvider',
    'CUDAExecutionProvider',
    'OpenVINOExecutionProvider',
  ];
  expect(currentVariants.map((profile) => profile.spec.provider)).toEqual([...providers, ...providers]);
  expect(new Set(currentVariants.map((profile) => profile.runtimeSourceRevision)).size).toBe(2);
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

it.each([
  ['ocr', 'PP-OCRv5_server'],
  ['face', 'antelopev2'],
  ['face', 'buffalo_s'],
  ['face', 'buffalo_m'],
] as const)('selects the released %s identity of %s, never another model', (workload, modelName) => {
  const profile =
    workload === 'ocr'
      ? desktopOcrProfile({ ...defaults.machineLearning.ocr, modelName })
      : desktopFaceProfile({ ...defaults.machineLearning.facialRecognition, modelName });
  expect([profile.modelName, profile.runtimeSourceRevision]).toEqual([
    modelName,
    'f2c451a6bf71ca3f3aec986e07f0852937268e2f',
  ]);
  const other = catalogue.profiles.find((p) => p.workload === workload && p.modelName !== modelName)!;
  expect(() =>
    workload === 'ocr'
      ? desktopOcrProfile({ ...defaults.machineLearning.ocr, modelName }, other.modelKey)
      : desktopFaceProfile({ ...defaults.machineLearning.facialRecognition, modelName }, other.modelKey),
  ).toThrow('desktop_pool_model_unavailable');
});
