import { EventEmitter } from 'node:events';
import request from 'supertest';
import { PhotoSourceController } from 'src/controllers/photo-source.controller.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { controllerSetup } from 'test/utils.js';

const dto = { uploadResourceId: '11111111-1111-4111-8111-111111111111' };
const params = { id: dto.uploadResourceId, runId: dto.uploadResourceId, itemId: dto.uploadResourceId };
it('keeps folder and Apple registration responses separate and rejects crossed source kinds before creation', async () => {
  const create = vi.fn((_auth, input) =>
    Promise.resolve({ ...input, revokedAt: null, createdAt: '2026-10-21T00:00:00.000Z' }),
  );
  const http = await controllerSetup(PhotoSourceController, [{ provide: PhotoSourceService, useValue: { create } }]);
  try {
    for (const [path, kind] of [
      ['/photo-sources', 'folder'],
      ['/photo-sources/apple-photos', 'apple-photos'],
    ]) {
      const input = {
        id: dto.uploadResourceId,
        deviceId: dto.uploadResourceId,
        kind,
        mode: 'copy',
        name: 'Fixture',
        scopeFingerprint: 'a'.repeat(64),
      };
      const response = await request(http.getHttpServer()).post(path).send(input);
      expect(response.status).toBe(201);
      expect(response.body.kind).toBe(kind);
      expect(response.headers['cache-control']).toBe('private, no-store');
      create.mockClear();
      for (const invalid of [
        { kind: kind === 'folder' ? 'apple-photos' : 'folder' },
        { mode: 'reference' },
        { root: '/private' },
      ]) {
        expect(
          (
            await request(http.getHttpServer())
              .post(path)
              .send({ ...input, ...invalid })
          ).status,
        ).toBe(400);
        expect(create).not.toHaveBeenCalled();
      }
    }
  } finally {
    await http.close();
  }
});
it('carries an optional catalog through registration and refuses a malformed one', async () => {
  const create = vi.fn((_auth, input) =>
    Promise.resolve({ ...input, revokedAt: null, createdAt: '2026-10-21T00:00:00.000Z' }),
  );
  const http = await controllerSetup(PhotoSourceController, [{ provide: PhotoSourceService, useValue: { create } }]);
  try {
    const input = {
      id: dto.uploadResourceId,
      deviceId: dto.uploadResourceId,
      kind: 'folder',
      mode: 'copy',
      name: 'Fixture',
      scopeFingerprint: 'a'.repeat(64),
    };
    const catalog = { app: 'lightroom-classic', catalogId: 'catalog-1', name: 'Main catalog' };
    const response = await request(http.getHttpServer())
      .post('/photo-sources')
      .send({ ...input, catalog });
    expect(response.status).toBe(201);
    expect(response.body.catalog).toEqual(catalog);
    const without = await request(http.getHttpServer()).post('/photo-sources').send(input);
    expect(without.status).toBe(201);
    expect(without.body).not.toHaveProperty('catalog');
    create.mockClear();
    for (const invalid of [
      { ...catalog, app: '' },
      { ...catalog, name: 'Main\ncatalog' },
      { ...catalog, path: '/Users/private' },
      { app: 'lightroom-classic' },
    ]) {
      expect(
        (
          await request(http.getHttpServer())
            .post('/photo-sources')
            .send({ ...input, catalog: invalid })
        ).status,
      ).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  } finally {
    await http.close();
  }
});
it('disconnect cancels verification and removes its response listener without masking unrelated errors', async () => {
  for (const unrelated of [false, true]) {
    const response = Object.assign(new EventEmitter(), { destroyed: false });
    const failure = new Error('unrelated');
    const service = {
      verify: vi.fn(
        (_auth, _source, _run, _item, _dto, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(unrelated ? failure : signal.reason), { once: true }),
          ),
      ),
    };
    const controller = new PhotoSourceController(service as never);
    const pending = controller.verifyPhotoSourceCopy({} as never, params, dto, response as never);
    response.destroyed = true;
    response.emit('close');
    if (unrelated) await expect(pending).rejects.toBe(failure);
    else await expect(pending).resolves.toBeUndefined();
    expect(response.listenerCount('close')).toBe(0);
  }
});
it('normal completion removes its close listener', async () => {
  const response = Object.assign(new EventEmitter(), { destroyed: false });
  const receipt = { storage: 'managed' };
  const controller = new PhotoSourceController({ verify: vi.fn().mockResolvedValue(receipt) } as never);
  expect(await controller.verifyPhotoSourceCopy({} as never, params, dto, response as never)).toBe(receipt);
  expect(response.listenerCount('close')).toBe(0);
});
