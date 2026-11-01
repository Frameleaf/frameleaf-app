import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import {
  advanceStudioRenderProgress as advance,
  studioExportFailure,
  studioRenderProgressOf,
} from 'src/utils/studio-render-progress.js';

const report = { stage: 'rendering', unit: 'frames' } as const;
const operation = (value: unknown, attempt = 1) => ({
  kind: MediaOperationKind.StudioExport,
  status: MediaOperationStatus.Rendering,
  attempt,
  result: { studioRenderProgress: value },
});
describe('Studio measured render progress', () => {
  it('leaves FPS and ETA unknown without enough advancing frame samples', () => {
    let value = advance(null, 1, report, 0, 100, 1000);
    expect(studioRenderProgressOf(operation(value))).toMatchObject({
      framesPerSecond: null,
      remainingRenderSeconds: null,
    });
    value = advance(value, 1, report, 10, 100, 2000);
    expect(studioRenderProgressOf(operation(value))?.framesPerSecond).toBeNull();
    value = advance(value, 1, report, 20, 100, 3000);
    expect(studioRenderProgressOf(operation(value))).toMatchObject({ framesPerSecond: 10, remainingRenderSeconds: 8 });
  });
  it('bounds rolling samples and follows a changed real rendering rate', () => {
    let value = advance(null, 1, report, 0, 1000, 1000);
    for (let sample = 1; sample <= 10; sample++)
      value = advance(value, 1, report, sample * sample, 1000, 1000 + sample * 1000);
    expect(value?.samples).toHaveLength(8);
    expect(studioRenderProgressOf(operation(value))?.framesPerSecond).toBe(13);
  });
  it('rejects stale counts, total changes, older timestamps and stage regression', () => {
    const value = advance(null, 1, report, 20, 100, 3000);
    expect(advance(value, 1, report, 10, 100, 4000)).toBeNull();
    expect(advance(value, 1, report, 30, 200, 4000)).toBeNull();
    expect(advance(value, 1, report, 30, 100, 2000)).toBeNull();
    expect(advance(value, 1, { stage: 'preparing' }, 20, 100, 4000)).toBeNull();
    expect(advance(value, 1, report, 20, 100, 4000)?.lastProgressAt).toBe(3000);
  });
  it('survives JSON persistence/reconnect and resets measurements for a new claim attempt', () => {
    let value = advance(null, 1, report, 0, 100, 1000);
    value = advance(value, 1, report, 10, 100, 2000);
    value = advance(value, 1, report, 20, 100, 3000);
    expect(studioRenderProgressOf(operation(JSON.parse(JSON.stringify(value))))?.framesPerSecond).toBe(10);
    expect(studioRenderProgressOf(operation(value, 2))?.framesPerSecond).toBeNull();
    const next = advance(value, 2, report, 0, 100, 4000);
    expect(next?.samples).toHaveLength(1);
    expect(next?.processed).toBe(0);
  });
  it('uses actual phase and never invents FPS from generic units or finalisation', () => {
    let value = advance(null, 1, { stage: 'rendering' }, 0, 100, 1000);
    value = advance(value, 1, { stage: 'rendering' }, 10, 100, 2000);
    value = advance(value, 1, { stage: 'rendering' }, 20, 100, 3000);
    expect(studioRenderProgressOf(operation(value))?.framesPerSecond).toBeNull();
    value = advance(value, 1, { stage: 'finalising' }, 100, 100, 4000);
    expect(studioRenderProgressOf(operation(value))).toMatchObject({
      stage: 'finalising',
      remainingRenderSeconds: null,
    });
    expect(advance(value, 1, report, 100, 100, 5000)).toBeNull();
  });
  it('rejects invalid counts and withholds arbitrary worker failure text', () => {
    expect(advance(null, 1, report, 101, 100, 1000)).toBeNull();
    expect(advance(null, 1, report, NaN, 100, 1000)).toBeNull();
    expect(studioExportFailure('secret=/private/path?token=abc')).not.toContain('secret');
    expect(studioExportFailure('studio_export_source_changed')).toContain('sources');
    expect(studioRenderProgressOf({ ...operation(null), kind: MediaOperationKind.Bulk })).toBeNull();
  });
  it('directs a bundled effects refusal to its GPU requirement without exposing worker details', () => {
    expect(studioExportFailure('bundled_effects_need_gpu')).toBe(
      'Give the machine-learning container a GPU, or remove the enabled effects, then export again from Studio.',
    );
    const unknown = studioExportFailure('bundled_effects_need_gpu:/private/source.mov?token=secret');
    expect(unknown).not.toContain('GPU');
    expect(unknown).not.toContain('/private');
    expect(unknown).not.toContain('secret');
  });
  it.each([
    ['bundled_missing_media', 'Relink the missing media'],
    ['bundled_no_audio', 'Add audible audio'],
    ['bundled_empty_timeline', 'Add a clip'],
    ['bundled_invalid_range', 'export range within the timeline'],
    ['bundled_captions_changed', 'Save the project, review the captions'],
    ['bundled_captions_unsupported', 'caption mode and format'],
    ['bundled_subtitles_unsupported', 'remove subtitle items for an HDR export without captions'],
    ['bundled_hdr_unsupported', 'HEVC Main10'],
    ['bundled_hdr_resolution', 'project size and original shape'],
    ['bundled_invalid_mastering', 'HDR mastering display settings'],
    ['bundled_hdr_mastering_exceeded', 'Review the grading'],
    ['bundled_hdr_master_failed', 'HDR encoder support'],
    ['bundled_inputs_too_large', 'larger input size limit'],
  ])('gives the producer-specific remedy for %s', (code, remedy) => {
    expect(studioExportFailure(code)).toContain(remedy);
    expect(studioExportFailure(code)).not.toContain('worker connection');
  });
  it('starts a new cursor when preparation work becomes measured render frames', () => {
    const preparing = advance(null, 1, { stage: 'preparing' }, 100, 100, 1000);
    const rendering = advance(preparing, 1, report, 0, 9000, 2000);
    expect(rendering).toMatchObject({ stage: 'rendering', processed: 0, total: 9000 });
    expect(rendering?.samples).toHaveLength(1);
    expect(advance(rendering, 1, { stage: 'preparing' }, 100, 100, 3000)).toBeNull();
    expect(advance(rendering, 1, { stage: 'rendering' }, 80, 100, 3000)).toBeNull();
    const finalising = advance(rendering, 1, { stage: 'finalising' }, 0, null, 3000);
    expect(finalising?.stage).toBe('finalising');
    expect(studioRenderProgressOf(operation(finalising))?.framesPerSecond).toBeNull();
  });
});
