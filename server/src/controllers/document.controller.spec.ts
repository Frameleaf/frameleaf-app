import request from 'supertest';
import { DocumentController } from 'src/controllers/document.controller.js';
import { DocumentService } from 'src/services/document.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(DocumentController.name, () => {
  let ctx: ControllerContext;
  const service = automock(DocumentService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(DocumentController, [{ provide: DocumentService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /documents', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/documents');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should refuse a page size over the limit', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/documents').query({ size: 1000 });
      expect(status).toEqual(400);
      expect(service.search).not.toHaveBeenCalled();
    });

    it('should refuse an overlong query', async () => {
      const query = 'x'.repeat(201);
      const { status } = await request(ctx.getHttpServer()).get('/documents').query({ query });
      expect(status).toEqual(400);
      expect(service.search).not.toHaveBeenCalled();
    });
  });

  describe('GET /documents/:id', () => {
    it('should require a valid uuid', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/documents/123');
      expect(status).toEqual(400);
      expect(service.get).not.toHaveBeenCalled();
    });
  });

  describe('PUT /documents/:id/lines', () => {
    it('should require the recognized line and the text that was read', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/documents/${factory.uuid()}/lines`)
        .send({ action: 'correct', value: 'Lake Agnes' });
      expect(status).toEqual(400);
      expect(service.editLine).not.toHaveBeenCalled();
    });

    it('should refuse an unknown action', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/documents/${factory.uuid()}/lines`)
        .send({ ocrId: factory.uuid(), recognizedText: 'LAKE AGNES', action: 'overwrite' });
      expect(status).toEqual(400);
      expect(service.editLine).not.toHaveBeenCalled();
    });

    it('should refuse an empty correction', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/documents/${factory.uuid()}/lines`)
        .send({ ocrId: factory.uuid(), recognizedText: 'LAKE AGNES', action: 'correct', value: ' '.repeat(3) });
      expect(status).toEqual(400);
      expect(service.editLine).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /documents/:id/lines/:editId', () => {
    it('should require the revision being removed', async () => {
      const path = `/documents/${factory.uuid()}/lines/${factory.uuid()}`;
      const { status } = await request(ctx.getHttpServer()).delete(path);
      expect(status).toEqual(400);
      expect(service.removeLineEdit).not.toHaveBeenCalled();
    });
  });

  describe('PUT /documents/:id/fields/:field', () => {
    it('should refuse a field that is not suggested', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/documents/${factory.uuid()}/fields/balance`)
        .send({ action: 'dismiss' });
      expect(status).toEqual(400);
      expect(service.editField).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /documents/:id/fields/:field', () => {
    it('should require the revision being removed', async () => {
      const { status } = await request(ctx.getHttpServer()).delete(`/documents/${factory.uuid()}/fields/total`);
      expect(status).toEqual(400);
      expect(service.removeFieldEdit).not.toHaveBeenCalled();
    });
  });
});
