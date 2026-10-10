import { resolveCameraIdentification } from 'src/utils/camera-identification.js';

describe('recorded camera identification', () => {
  it('keeps providers coherent and preserves arbitrary models', () => {
    const result = resolveCameraIdentification({ Make: ' Canon ', Device: { ModelName: ' New model Ω ' } });
    expect(result.recorded).toEqual({
      make: null,
      model: 'New model Ω',
      source: 'original',
      modelTag: 'Device.ModelName',
    });
    expect(result.alternatives).toContainEqual({ make: 'Canon', model: null, source: 'original', makeTag: 'Make' });
  });

  it('prefers an original model and retains conflicting sidecar evidence', () => {
    const result = resolveCameraIdentification({ Make: 'A', Model: 'one' }, { Make: 'B', Model: 'two' });
    expect(result.recorded).toMatchObject({ make: 'A', model: 'one', source: 'original' });
    expect(result.alternatives).toContainEqual({
      make: 'B',
      model: 'two',
      source: 'sidecar',
      makeTag: 'Make',
      modelTag: 'Model',
    });
  });

  it('uses a sidecar model without borrowing an original make', () => {
    expect(resolveCameraIdentification({ Make: 'A', Model: '  ' }, { Model: 'B one' }).recorded).toEqual({
      make: null,
      model: 'B one',
      source: 'sidecar',
      modelTag: 'Model',
    });
  });

  it.each([
    [{ Make: 'A', UniqueCameraModel: 'A new' }, 'A', 'A new', 'UniqueCameraModel'],
    [{ Make: 'A', CameraModel: 'new' }, 'A', 'new', 'CameraModel'],
    [{ Device: { Manufacturer: 'A', ModelName: 'new' } }, 'A', 'new', 'Device.ModelName'],
    [{ AndroidMake: 'A', AndroidModel: 'new' }, 'A', 'new', 'AndroidModel'],
    [{ DeviceManufacturer: 'A', DeviceModelName: 'new' }, 'A', 'new', 'DeviceModelName'],
  ])('retains recorded fallbacks: %j', (tags, make, model, modelTag) => {
    expect(resolveCameraIdentification(tags).recorded).toMatchObject({ make, model, modelTag });
  });

  it('retains make-only and does not invent camera facts from software or combined strings', () => {
    expect(resolveCameraIdentification({ Make: 'A' }).recorded).toMatchObject({ make: 'A', model: null });
    expect(resolveCameraIdentification({ Model: 'A one' }).recorded).toMatchObject({ make: null, model: 'A one' });
    expect(
      resolveCameraIdentification({ Software: 'A editor', ProfileDescription: 'A camera profile' }).recorded,
    ).toBeNull();
  });
});
