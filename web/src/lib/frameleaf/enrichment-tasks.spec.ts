import { MachineLearningHardwareAcceleration as Acceleration, SmartAlbumBuiltInKind } from '@immich/sdk';
import {
  applyDescriptionHardwarePreset,
  enrichmentTaskAction,
  presetSelectsModels,
  SMART_ALBUM_KINDS,
} from '$lib/frameleaf/enrichment-tasks';

describe('enrichment tasks (jobs-data.mjs 819-864, 1108-1122)', () => {
  it("maps the dialog's choices to the template's actions", () => {
    expect(enrichmentTaskAction('descriptions', 'now', 'all')).toEqual({ type: 'description-requeue' });
    expect(enrichmentTaskAction('descriptions', 'later', 'all')).toEqual({ type: 'description-defer' });
    expect(enrichmentTaskAction('smart-albums', 'now', 'all')).toEqual({ type: 'smart-album' });
    expect(enrichmentTaskAction('smart-albums', 'now', SmartAlbumBuiltInKind.Nature)).toEqual({
      type: 'smart-album',
      kind: SmartAlbumBuiltInKind.Nature,
    });
    expect(SMART_ALBUM_KINDS).toHaveLength(6);
  });

  it('changes models only for a known accelerated backend', () => {
    expect(presetSelectsModels(Acceleration.Auto, undefined)).toBe(false);
    expect(presetSelectsModels(Acceleration.Auto, Acceleration.Auto)).toBe(false);
    expect(presetSelectsModels(Acceleration.Auto, Acceleration.Openvino)).toBe(true);
    expect(presetSelectsModels(Acceleration.Cuda, undefined)).toBe(true);
  });

  it('leaves a draft without machine-learning settings alone', () => {
    expect(applyDescriptionHardwarePreset(undefined, Acceleration.Cuda, undefined)).toBe(false);
  });
});
