import { AssetRestorationMode, MlWorkload, RestorationModelState } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  allowsRestoration,
  measurementValues,
  restorationModeLabelKey,
  restorationModelStateLabelKey,
  restorationModelStateTone,
} from '$lib/frameleaf/restoration-models';

describe('restoration models presentation', () => {
  it('offers the report only where restoration work is allowed', () => {
    expect(allowsRestoration({ workloads: [MlWorkload.Face, MlWorkload.RestorationCreative] })).toBe(true);
    expect(allowsRestoration({ workloads: [MlWorkload.Face, MlWorkload.Clip] })).toBe(false);
  });

  it('labels every model state and marks only an available model as ready', () => {
    for (const state of Object.values(RestorationModelState)) {
      expect(restorationModelStateLabelKey(state)).toMatch(/^admin\.frameleaf_restoration_models_state_/);
      expect(restorationModelStateTone(state)).toBe(
        state === RestorationModelState.Available
          ? 'teal'
          : state === RestorationModelState.Verifying
            ? 'blue'
            : 'warning',
      );
    }
  });

  it('labels both modes', () => {
    const faithful = restorationModeLabelKey(AssetRestorationMode.Faithful);
    const creative = restorationModeLabelKey(AssetRestorationMode.Creative);

    expect(faithful).toBe('admin.frameleaf_restoration_models_mode_faithful');
    expect(creative).toBe('admin.frameleaf_restoration_models_mode_creative');
  });

  it('rounds measured throughput for display', () => {
    expect(
      measurementValues({
        gpu: 'GPU A',
        inputWidth: 640,
        inputHeight: 360,
        frames: 150,
        framesPerSecond: 4.2567,
        peakVramBytes: 9.64 * 1024 ** 3,
      }),
    ).toEqual({ width: 640, height: 360, gpu: 'GPU A', fps: 4.26, memory: 9.6 });
  });
});
