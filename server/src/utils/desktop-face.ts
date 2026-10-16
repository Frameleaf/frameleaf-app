import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FaceDetectionOptions } from 'src/repositories/machine-learning.repository.js';
import { type DesktopModelProfile, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

export const faceEntries = ({ modelName, minScore }: FaceDetectionOptions) => ({
  'facial-recognition': { detection: { modelName, options: { minScore } }, recognition: { modelName } },
});
let catalogue: ReturnType<typeof parseDesktopModelCatalogue> | undefined;
export const desktopFaceProfile = (options: FaceDetectionOptions): DesktopModelProfile => {
  catalogue ??= parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
  );
  const candidates = catalogue.profiles.filter(
    (profile) =>
      profile.workload === 'face' &&
      profile.modelName === options.modelName &&
      canonicalJson(profile.spec.entries) === canonicalJson(faceEntries(options)),
  );
  if (candidates.length !== 1) throw new Error('desktop_pool_model_unavailable');
  return candidates[0];
};
