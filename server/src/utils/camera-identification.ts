import type { ImmichTags } from 'src/repositories/metadata.repository.js';

export type CameraCandidate = {
  make: string | null;
  model: string | null;
  source: 'original' | 'sidecar';
  makeTag?: string;
  modelTag?: string;
};

export type CameraIdentification = {
  version: 1;
  recorded: CameraCandidate | null;
  alternatives: CameraCandidate[];
  suggestion: { method: 'jpeg-signature'; signature: string; matches: string | null } | null;
};

const cameraString = (value: unknown): string | null => (typeof value === 'string' ? value.trim() || null : null);

/** Each pair belongs to one provider; a missing make is never borrowed from another. */
const candidates = (tags: ImmichTags, source: CameraCandidate['source']): CameraCandidate[] => {
  const pairs = [
    ['Make', tags.Make, 'Model', tags.Model],
    ['Device.Manufacturer', tags.Device?.Manufacturer, 'Device.ModelName', tags.Device?.ModelName],
    ['AndroidMake', tags.AndroidMake, 'AndroidModel', tags.AndroidModel],
    ['DeviceManufacturer', tags.DeviceManufacturer, 'DeviceModelName', tags.DeviceModelName],
    ...(cameraString(tags.UniqueCameraModel)
      ? [['Make', tags.Make, 'UniqueCameraModel', tags.UniqueCameraModel] as const]
      : []),
    ...(cameraString(tags.CameraModel) ? [['Make', tags.Make, 'CameraModel', tags.CameraModel] as const] : []),
  ] as const;
  return pairs.flatMap(([makeTag, makeValue, modelTag, modelValue]) => {
    const make = cameraString(makeValue);
    const model = cameraString(modelValue);
    return make || model ? [{ make, model, source, ...(make && { makeTag }), ...(model && { modelTag }) }] : [];
  });
};

export function resolveCameraIdentification(original: ImmichTags, sidecar?: ImmichTags | null): CameraIdentification {
  const all = [...candidates(original, 'original'), ...candidates(sidecar ?? {}, 'sidecar')];
  const recorded = all.find((candidate) => candidate.model) ?? all[0] ?? null;
  return { version: 1, recorded, alternatives: all.filter((candidate) => candidate !== recorded), suggestion: null };
}
