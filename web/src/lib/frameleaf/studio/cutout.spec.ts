import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import { createStudioCutoutServices, isStudioCutoutRequest, type StudioCutoutApi } from './cutout';
import { CUTOUT_ENGINE_STRINGS, cutoutEngineStrings } from './cutout-strings';
import { STUDIO_FRAME_SERVICE_SCHEMA_V8, isStudioFrameServiceName } from './frame-service-schema';

const projectId = '0195e2a0-0000-7000-8000-000000000060';
const jamie = '0195e2a0-0000-4000-8000-000000000061';
const matte = {
  importId: '0195e2a0-0000-4000-8000-000000000062',
  startSeconds: 3,
  durationSeconds: 2,
  fps: 10,
  frames: 20,
  columns: 20,
  frameWidth: 192,
  frameHeight: 108,
};

const messages = en as unknown as Record<string, string>;
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

const api = (): StudioCutoutApi & { [K in keyof StudioCutoutApi]: ReturnType<typeof vi.fn> } => ({
  subjects: vi.fn().mockResolvedValue({ subjects: [{ kind: 'person', personId: jamie, name: 'Jamie' }] }),
  create: vi.fn().mockResolvedValue({ id: 'c1', status: 'queued', progress: 0, error: null, matte: null }),
  get: vi.fn().mockResolvedValue({ id: 'c1', status: 'running', progress: 50, error: null, matte: null }),
});

describe('FL-639 Cut out the subject (host)', () => {
  it('offers the cut-out services to the editor frame and checks their arguments', () => {
    for (const name of ['listCutoutSubjects', 'startCutout', 'readCutout']) {
      expect(isStudioFrameServiceName(name), name).toBe(true);
    }
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V8.listCutoutSubjects(['clip-1'])).toBe(true);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V8.listCutoutSubjects([''])).toBe(false);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V8.readCutout([matte.importId])).toBe(true);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V8.readCutout(['../imports'])).toBe(false);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V8.startCutout([{ clipId: 'clip-1', personId: null, points: [] }])).toBe(true);
  });

  it('passes only the request the server takes', () => {
    const point = { sourceSeconds: 3.5, x: 0.5, y: 0.25, label: 1 };
    expect(isStudioCutoutRequest({ clipId: 'clip-1', personId: jamie, points: [point] })).toBe(true);
    expect(isStudioCutoutRequest({ clipId: 'clip-1', personId: jamie, points: [point], destination: 'cloud' })).toBe(
      false,
    );
    expect(isStudioCutoutRequest({ clipId: 'clip-1', personId: 'jamie', points: [] })).toBe(false);
    expect(isStudioCutoutRequest({ clipId: 'clip-1', personId: null, points: [{ ...point, x: 2 }] })).toBe(false);
    expect(isStudioCutoutRequest({ clipId: 'clip-1', personId: null, points: [{ ...point, label: 2 }] })).toBe(false);
    expect(isStudioCutoutRequest({ clipId: 'clip-1', personId: null, points: Array.from({ length: 65 }, () => point) })).toBe(
      false,
    );
  });

  it('asks the server for the open project and reloads its files before a completed cut-out is answered', async () => {
    const server = api();
    const order: string[] = [];
    const matteKept = vi.fn(async () => {
      order.push('reloaded');
    });
    const services = createStudioCutoutServices({ projectId: () => projectId, api: server, matteKept });

    await expect(services.listCutoutSubjects('clip-1')).resolves.toEqual([
      { kind: 'person', personId: jamie, name: 'Jamie' },
    ]);
    expect(server.subjects).toHaveBeenCalledWith(projectId, 'clip-1');

    const request = { clipId: 'clip-1', personId: jamie, points: [] };
    await expect(services.startCutout(request)).resolves.toMatchObject({ id: 'c1', status: 'queued' });
    expect(server.create).toHaveBeenCalledWith(projectId, request);

    await expect(services.readCutout('c1')).resolves.toMatchObject({ status: 'running', progress: 50, matte: null });
    expect(matteKept).not.toHaveBeenCalled();

    server.get.mockImplementation(async () => {
      order.push('read');
      return { id: 'c1', status: 'completed', progress: 100, error: null, matte: { ...matte, extra: 'dropped' } };
    });
    const done = await services.readCutout('c1');
    expect(done.matte).toEqual(matte);
    expect(order).toEqual(['read', 'reloaded']);
  });

  it('has an English host message for every cut-out card string, with its run-time values', () => {
    for (const entry of Object.values(CUTOUT_ENGINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
    const strings = cutoutEngineStrings(translate);
    expect(strings.cutoutFind).toBe('Find {{name}}');
    expect(strings.cutoutFinding).toBe('Finding {{name}} in each frame…');
    expect(strings.cutoutTitle).toBe('Cut out the subject');
    expect(Object.keys(strings)).toEqual(Object.keys(CUTOUT_ENGINE_STRINGS));
  });
});
