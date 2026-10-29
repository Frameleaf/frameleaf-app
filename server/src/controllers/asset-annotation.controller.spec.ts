import request from 'supertest';
import { AssetAnnotationController } from 'src/controllers/asset-annotation.controller.js';
import { AssetAnnotationService } from 'src/services/asset-annotation.service.js';
import { controllerSetup } from 'test/utils.js';

const id = '11111111-1111-4111-8111-111111111111';
const items = [{ id: 'a1', kind: 'arrow', geometry: { x: 0.3, y: 0.6, endX: 0.2, endY: 0.5 }, note: 'Bigger' }];
const document = { version: 1, sourceRevision: 'rev', sourceChanged: false, canEdit: true, items, updatedAt: null };

it('reads and replaces a picture’s annotations, refusing malformed documents before the service', async () => {
  const get = vi.fn().mockResolvedValue(document);
  const replace = vi.fn().mockResolvedValue(document);
  const http = await controllerSetup(AssetAnnotationController, [
    { provide: AssetAnnotationService, useValue: { get, replace } },
  ]);
  try {
    const read = await request(http.getHttpServer()).get(`/assets/${id}/annotations`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(document);
    expect(read.headers['cache-control']).toBe('private, no-store');

    const saved = await request(http.getHttpServer())
      .put(`/assets/${id}/annotations`)
      .send({ version: 1, sourceRevision: 'rev', items });
    expect(saved.status).toBe(200);
    expect(replace).toHaveBeenCalledWith(undefined, id, { version: 1, sourceRevision: 'rev', items });

    replace.mockClear();
    for (const body of [
      { version: 2, sourceRevision: 'rev', items },
      { version: 1, items },
      { items },
      { version: 1, sourceRevision: 'rev', items: [{ ...items[0], geometry: { x: 0.3, y: 0.6 } }] },
      { version: 1, sourceRevision: 'rev', items: [{ ...items[0], kind: 'circle' }] },
    ]) {
      expect((await request(http.getHttpServer()).put(`/assets/${id}/annotations`).send(body)).status).toBe(400);
    }
    expect(replace).not.toHaveBeenCalled();
    expect((await request(http.getHttpServer()).get('/assets/not-a-uuid/annotations')).status).toBe(400);
  } finally {
    await http.close();
  }
});
