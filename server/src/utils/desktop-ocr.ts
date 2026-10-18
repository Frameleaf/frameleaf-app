import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OcrOptions } from 'src/repositories/machine-learning.repository.js';
import {
  type DesktopModelProfile,
  desktopImageModelKeys,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

export const ocrEntries = ({ modelName, minDetectionScore, minRecognitionScore, maxResolution }: OcrOptions) => ({
  ocr: {
    detection: { modelName, options: { minScore: minDetectionScore, maxResolution } },
    recognition: { modelName, options: { minScore: minRecognitionScore } },
  },
});
let catalogue: ReturnType<typeof parseDesktopModelCatalogue> | undefined;
export const desktopOcrProfile = (
  options: OcrOptions,
  modelKey: string = desktopImageModelKeys.ocr,
): DesktopModelProfile => {
  catalogue ??= parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
  );
  const candidates = catalogue.profiles.filter(
    (profile) =>
      profile.workload === 'ocr' &&
      profile.modelKey === modelKey &&
      profile.modelName === options.modelName &&
      canonicalJson(profile.spec.entries) === canonicalJson(ocrEntries(options)),
  );
  if (candidates.length !== 1) throw new Error('desktop_pool_model_unavailable');
  return candidates[0];
};
