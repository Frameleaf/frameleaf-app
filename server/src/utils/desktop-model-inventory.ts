import type { MachineLearningConfig } from 'src/config.js';
import type { DesktopModelAvailability } from 'src/dtos/desktop-model-inventory.dto.js';
import type { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import type { DesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import type { DesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { desktopInventoryWorkloads } from 'src/dtos/desktop-model-inventory.dto.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { findDesktopClipSpace } from 'src/utils/desktop-clip-space.js';
import { faceEntries } from 'src/utils/desktop-face.js';
import { desktopImageModelKeys } from 'src/utils/desktop-model-catalogue.js';
import { ocrEntries } from 'src/utils/desktop-ocr.js';
import { canonicalJson } from 'src/utils/object.js';

type Route = Awaited<ReturnType<MlDestinationRepository['getRouteStates']>>[number];
export const selectDesktopModelInventory = ({
  config,
  catalogue,
  spaces,
  routes,
  destinations,
  provider,
  runtimeSourceRevision,
}: {
  config: MachineLearningConfig;
  catalogue: DesktopModelCatalogue;
  spaces: DesktopClipSpaces;
  routes: Route[];
  destinations: MlDestinationRow[];
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
    const route = routes.find((item) => item.workload === workload);
    if (route?.origin === 'pinned' || route?.origin === 'legacy') return result(route.origin);
    const destination = destinations.find((item) => item.id === route?.destinationId);
    if (
      !route?.revisionId ||
      !destination?.enabled ||
      !destination.url ||
      ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(destination.kind) ||
      !destination.workloads.includes(workload)
    )
      return result('unavailable');
    if (!model) return result('unsupported');
    const profiles = catalogue.profiles.filter(
      (item) =>
        item.workload === workload &&
        item.modelName === model.modelName &&
        item.spec.provider === provider &&
        item.runtimeSourceRevision === runtimeSourceRevision &&
        (workload !== MlWorkload.Face || item.modelKey === desktopImageModelKeys.face) &&
        (workload !== MlWorkload.Ocr || item.modelKey === desktopImageModelKeys.ocr) &&
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
