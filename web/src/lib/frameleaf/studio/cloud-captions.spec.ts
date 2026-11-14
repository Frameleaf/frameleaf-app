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
};
const placement = { start: { num: 2, den: 1 }, sourceStart: { num: 3, den: 1 }, speed: { num: 2, den: 1 } };
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
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.readCloudCaptions(['nope'])).toBe(false);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.readCloudCaptions([ID])).toBe(true);
  });

  it('accepts a clip of a batch only where the batch names it (FL-1429)', () => {
    const clips = [
      { clipId: 'clip-1', name: 'Lake morning.mov' },
      { clipId: 'clip-2', name: 'Forest trail.mov' },
    ];
    const batched = { ...request, batch: { id: 'batch-1', index: 0, clips } };
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.startCloudCaptions([batched])).toBe(true);
    expect(isStudioCloudCaptionRequest({ ...batched, batch: { ...batched.batch, index: 1 } })).toBe(false);
    expect(isStudioCloudCaptionRequest({ ...batched, batch: { ...batched.batch, index: 2 } })).toBe(false);
    expect(isStudioCloudCaptionRequest({ ...batched, batch: { ...batched.batch, clips: [clips[0]] } })).toBe(false);
    expect(isStudioCloudCaptionRequest({ ...batched, batch: { ...batched.batch, clips: [clips[0], clips[0]] } })).toBe(
      false,
    );
    expect(isStudioCloudCaptionRequest({ ...batched, batch: { ...batched.batch, id: '../x' } })).toBe(false);
  });

  it('remembers a batched job as its one clip', async () => {
    const storage = memory();
    const services = make({ storage });
    const batch = {
      id: 'batch-1',
      index: 0,
      clips: [
        { clipId: 'clip-1', name: 'Lake morning.mov' },
        { clipId: 'clip-2', name: 'Forest trail.mov' },
      ],
    };
    await expect(services.startCloudCaptions({ ...request, batch })).resolves.toEqual({ ...request, id: ID });
    await expect(make({ storage }).pendingCloudCaptions()).resolves.toEqual([{ ...request, id: ID }]);
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

  it('does not request an estimate if the project did not save', async () => {
    const confirm = vi.fn(() => Promise.resolve(ID));
    const services = make({ save: () => Promise.resolve(false), confirm });
    await expect(services.startCloudCaptions(request)).resolves.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('resumes a confirmation that settled after a project switch only in its saved project', async () => {
    let project = 'original';
    const storage = memory();
    const confirm = vi.fn(async () => {
      project = 'copy';
      return ID;
    });
    const services = make({ storage, projectId: () => project, confirm });
    await expect(services.startCloudCaptions(request)).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledWith(request, 'original');
    await expect(services.pendingCloudCaptions()).resolves.toEqual([]);

    project = 'original';
    await expect(services.pendingCloudCaptions()).resolves.toEqual([{ ...request, id: ID }]);
  });

  it('reads a job resumed after a reload under its own project, even after Save as copy', async () => {
    const storage = memory();
    await make({ storage, projectId: () => 'original' }).startCloudCaptions(request);
    let project = 'original';
    const read = vi.fn(() => Promise.resolve({ status: 'rendering', error: null, result: null }));
    const reloaded = make({ storage, projectId: () => project, read });
    await reloaded.pendingCloudCaptions();
    project = 'copy';
    await reloaded.readCloudCaptions(ID);
    expect(read).toHaveBeenCalledWith('original', ID);
  });

  it('keeps a completed job until the editor is done with it', async () => {
    const storage = memory();
    const result = { cues: [{ start: { num: 1, den: 1 }, end: { num: 2, den: 1 }, text: 'Hello' }] };
    const services = make({
      storage,
      read: () => Promise.resolve({ status: 'completed', error: null, result, placement }),
    });
    await services.startCloudCaptions(request);
    await services.readCloudCaptions(ID);
    await expect(make({ storage }).pendingCloudCaptions()).resolves.toHaveLength(1);
    await services.forgetCloudCaptions(ID);
    await expect(make({ storage }).pendingCloudCaptions()).resolves.toEqual([]);
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
          placement,
        }),
    });
    await expect(services.readCloudCaptions(ID)).resolves.toEqual({
      status: 'completed',
      error: null,
      cues: [{ start: 0.5, end: 3, text: 'Hello' }],
      anchor: { fromSeconds: 2, sourceStartSeconds: 3, speed: 2 },
    });
  });

  it('reports a completed job with no placement as failed, since its lines could not be placed', async () => {
    const result = { cues: [] };
    const services = make({
      read: () => Promise.resolve({ status: 'completed', error: null, result, placement: null }),
    });
    await expect(services.readCloudCaptions(ID)).resolves.toMatchObject({ status: 'failed' });
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
