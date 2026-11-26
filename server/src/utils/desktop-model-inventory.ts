import type { MachineLearningConfig } from 'src/config.js';
import type { DesktopModelAvailability } from 'src/dtos/desktop-model-inventory.dto.js';
import type { DesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import type { DesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { desktopInventoryWorkloads } from 'src/dtos/desktop-model-inventory.dto.js';
import { MlWorkload } from 'src/enum.js';
import { findDesktopClipSpace } from 'src/utils/desktop-clip-space.js';
import { descriptionEntries, desktopDescriptionModel } from 'src/utils/desktop-description.js';
import { faceEntries } from 'src/utils/desktop-face.js';
import { desktopImageModelKey } from 'src/utils/desktop-model-catalogue.js';
import { ocrEntries } from 'src/utils/desktop-ocr.js';
import { canonicalJson } from 'src/utils/object.js';

/** What each enabled task asks of a desktop: the catalogue profile for the configured model, whatever the routing. */
export const selectDesktopModelInventory = ({
  config,
  catalogue,
  spaces,
  provider,
  runtimeSourceRevision,
}: {
  config: MachineLearningConfig;
  catalogue: DesktopModelCatalogue;
  spaces: DesktopClipSpaces;
  provider: string;
  runtimeSourceRevision: string;
}): DesktopModelAvailability[] =>
  desktopInventoryWorkloads.map((workload) => {
    const model =
      workload === MlWorkload.Clip
        ? config.clip
        : workload === MlWorkload.Ocr
          ? config.ocr
          : workload === MlWorkload.Face
            ? config.facialRecognition
            : undefined;
    const enrichment = [config.imageDescription, config.nsfwDetection].filter((item) => item.enabled);
    const modelNames = (model ? [model.modelName] : enrichment.map((item) => item.modelName)).filter(
      (name) => name.length > 0 && name.length <= 512,
    );
    const result = (state: DesktopModelAvailability['state'], modelKeys: string[] = []): DesktopModelAvailability => ({
      workload,
      state,
      modelNames,
      modelKeys,
    });
    if (!config.enabled || !(model ? model.enabled : enrichment.length > 0)) return result('disabled');
    if (!model) {
      // FD-31: of enrichment a desktop runs only descriptions, and only with a model the catalogue has for it.
      const name = config.imageDescription.enabled
        ? desktopDescriptionModel(config.imageDescription.modelName)
        : undefined;
      const keys = catalogue.profiles
        .filter(
          (item) =>
            item.workload === 'description' &&
            item.modelName === name &&
            item.spec.provider === provider &&
            item.runtimeSourceRevision === runtimeSourceRevision &&
            canonicalJson(item.spec.entries) === canonicalJson(descriptionEntries(item.modelName)),
        )
        .map((item) => item.modelKey);
      return keys.length === 1 ? result('eligible', keys) : result('unsupported');
    }
    const profiles = catalogue.profiles.filter(
      (item) =>
        item.workload === workload &&
        item.modelName === model.modelName &&
        item.spec.provider === provider &&
        item.runtimeSourceRevision === runtimeSourceRevision &&
        (workload !== MlWorkload.Face || item.modelKey === desktopImageModelKey('face', model.modelName)) &&
        (workload !== MlWorkload.Ocr || item.modelKey === desktopImageModelKey('ocr', model.modelName)) &&
        (workload === MlWorkload.Face
          ? canonicalJson(item.spec.entries) === canonicalJson(faceEntries(config.facialRecognition))
          : workload === MlWorkload.Ocr
            ? canonicalJson(item.spec.entries) === canonicalJson(ocrEntries(config.ocr))
            : true),
    );
    const keys = profiles.map((item) => item.modelKey);
    if (workload === MlWorkload.Clip) {
      const space = keys.length > 0 ? findDesktopClipSpace(spaces, keys[0]) : undefined;
      if (
        !space ||
        keys.length !== 3 ||
        [space.visualModelKey, ...space.textModelKeys].some((key) => !keys.includes(key))
      )
        return result('unsupported');
    } else if (keys.length !== 1) return result('unsupported');
    return result('eligible', keys);
  });
