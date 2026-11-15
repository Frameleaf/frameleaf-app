import request from 'supertest';
import { PhotoSourceCatalogController } from 'src/controllers/photo-source-catalog.controller.js';
import { PhotoSourceCatalogService } from 'src/services/photo-source-catalog.service.js';
import { controllerSetup } from 'test/utils.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const result = {
  summary: { applied: 1, unchanged: 0, keptEdits: 0, notReady: 0, notFound: 0 },
  items: [{ itemId, status: 'applied', applied: ['rating'], keptEdits: [] }],
};

it('validates a catalog batch before it reaches the service', async () => {
  const apply = vi.fn().mockResolvedValue(result);
  const http = await controllerSetup(PhotoSourceCatalogController, [
    { provide: PhotoSourceCatalogService, useValue: { apply } },
  ]);
  try {
    const item = {
      itemId,
      rating: 4,
      flag: 'reject',
      colorLabel: 'Red',
      keywords: ['Places|France|Paris'],
      title: 'Title',
      caption: 'Caption',
      collections: [{ path: ['Travel'], name: 'Paris' }],
    };
    const response = await request(http.getHttpServer())
      .post(`/photo-sources/${sourceId}/catalog-metadata`)
      .send({ items: [item] });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual(result);
    expect(apply).toHaveBeenCalledWith(undefined, sourceId, { items: [item] });
    apply.mockClear();

    for (const body of [
      { items: [] },
      { items: Array.from({ length: 501 }, () => ({ itemId })) },
      { items: [{ itemId, rating: 6 }] },
      { items: [{ itemId, rating: -1 }] },
      { items: [{ itemId, flag: 'favourite' }] },
      { items: [{ itemId, developSettings: {} }] },
      { items: [{ itemId, collections: [{ name: 'No path' }] }] },
      { items: [{ itemId }, { itemId }] },
      { items: [{ itemId: 'not-a-uuid' }] },
    ]) {
      expect(
        (await request(http.getHttpServer()).post(`/photo-sources/${sourceId}/catalog-metadata`).send(body)).status,
      ).toBe(400);
    }
    expect(apply).not.toHaveBeenCalled();
  } finally {
    await http.close();
  }
});
