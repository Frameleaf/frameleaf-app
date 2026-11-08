import {
  CLOUD_CAPTION_ENGINE_STRINGS,
  cloudCaptionEngineStrings,
  createCloudCaptionServices,
  isStudioCloudCaptionRequest,
  type StudioCloudCaptionRequest,
} from './cloud-captions';
import { STUDIO_FRAME_SERVICE_SCHEMA_V9 } from './frame-service-schema';

const ID = '0195e2a0-0000-7000-8000-00000000b162';
const request: StudioCloudCaptionRequest = {
  clipId: 'clip-1',
  language: 'auto',
  name: 'Lake morning.mov',
  anchor: { fromSeconds: 2, sourceStartSeconds: 0, speed: 1 },
};
const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};
const make = (overrides: Partial<Parameters<typeof createCloudCaptionServices>[0]> = {}) =>
  createCloudCaptionServices({
    projectId: () => 'p1',
    save: () => Promise.resolve(),
    confirm: () => Promise.resolve(ID),
    read: () => Promise.resolve({ status: 'rendering', error: null, result: null }),
    storage: memory(),
    ...overrides,
  });

describe('Studio captions on Frameleaf Cloud', () => {
  it('refuses a malformed request at the frame boundary', () => {
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.startCloudCaptions([request])).toBe(true);
    expect(isStudioCloudCaptionRequest({ ...request, clipId: '../x' })).toBe(false);
    expect(isStudioCloudCaptionRequest({ ...request, language: '' })).toBe(false);
    expect(isStudioCloudCaptionRequest({ ...request, anchor: { ...request.anchor, speed: 0 } })).toBe(false);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.readCloudCaptions(['nope'])).toBe(false);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.readCloudCaptions([ID])).toBe(true);
  });

  it('saves before it prices, because the server prices the head revision', async () => {
    const order: string[] = [];
    const services = make({
      save: () => {
        order.push('save');
        return Promise.resolve();
      },
      confirm: () => {
        order.push('confirm');
        return Promise.resolve(ID);
      },
    });
    await expect(services.startCloudCaptions(request)).resolves.toEqual({ ...request, id: ID });
    expect(order).toEqual(['save', 'confirm']);
  });

  it('remembers nothing when the person walks away from the price', async () => {
    const services = make({ confirm: () => Promise.resolve(null) });
    await expect(services.startCloudCaptions(request)).resolves.toBeNull();
    await expect(services.pendingCloudCaptions()).resolves.toEqual([]);
  });

  it('keeps a confirmed job across a reload until it settles', async () => {
    const storage = memory();
    await make({ storage }).startCloudCaptions(request);
    let status = 'rendering';
    const reloaded = make({ storage, read: () => Promise.resolve({ status, error: null, result: null }) });
    await expect(reloaded.pendingCloudCaptions()).resolves.toHaveLength(1);
    await expect(reloaded.readCloudCaptions(ID)).resolves.toMatchObject({ status: 'running' });
    await expect(reloaded.pendingCloudCaptions()).resolves.toHaveLength(1);
    status = 'cancelled';
    await expect(reloaded.readCloudCaptions(ID)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(reloaded.pendingCloudCaptions()).resolves.toEqual([]);
  });

  it('files a job under the id the project has once it is saved, and reads it there after Save as copy', async () => {
    const storage = memory();
    let project = 'draft';
    const read = vi.fn(() => Promise.resolve({ status: 'rendering', error: null, result: null }));
    const services = make({
      storage,
      projectId: () => project,
      read,
      save: () => {
        project = 'saved';
        return Promise.resolve();
      },
    });
    await services.startCloudCaptions(request);
    expect(storage.getItem('frameleaf-studio-cloud-captions:draft')).toBeNull();
    await expect(services.pendingCloudCaptions()).resolves.toHaveLength(1);

    project = 'copy';
    await services.readCloudCaptions(ID);
    expect(read).toHaveBeenCalledWith('saved', ID);
    await expect(services.pendingCloudCaptions()).resolves.toEqual([]);
    project = 'saved';
    await expect(services.pendingCloudCaptions()).resolves.toHaveLength(1);
  });

  it('turns exact cue times into seconds', async () => {
    const services = make({
      read: () =>
        Promise.resolve({
          status: 'completed',
          error: null,
          result: { cues: [{ start: { num: 1, den: 2 }, end: { num: 3, den: 1 }, text: 'Hello' }] },
        }),
    });
    await expect(services.readCloudCaptions(ID)).resolves.toEqual({
      status: 'completed',
      error: null,
      cues: [{ start: 0.5, end: 3, text: 'Hello' }],
    });
  });

  it('reports a completed job with no result as failed', async () => {
    const services = make({ read: () => Promise.resolve({ status: 'completed', error: null, result: null }) });
    await expect(services.readCloudCaptions(ID)).resolves.toMatchObject({ status: 'failed' });
  });

  it('leaves the engine its markers in every translated string', () => {
    const strings = cloudCaptionEngineStrings((key, options) => `${key} ${JSON.stringify(options?.values ?? {})}`);
    expect(Object.keys(strings)).toEqual(Object.keys(CLOUD_CAPTION_ENGINE_STRINGS));
    expect(strings.cloudCaptionsReadyBody).toContain('{{lines}}');
    expect(strings.cloudCaptionsReadyBody).toContain('{{existing}}');
  });
});
