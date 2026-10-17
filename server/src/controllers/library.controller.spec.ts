import request from 'supertest';
import { LibraryController } from 'src/controllers/library.controller.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(LibraryController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(LibraryService);
  const scans = automock(LibraryScanService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(LibraryController, [
      { provide: LibraryService, useValue: service },
      { provide: LibraryScanService, useValue: scans },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    scans.resetAllMocks();
    ctx.reset();
  });

  const id = factory.uuid();

  describe('POST /libraries', () => {
    it('should require an owner id', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/libraries').send({});

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['ownerId'], message: 'Invalid input: expected string, received undefined' },
        ]),
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should reject duplicate import paths', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/libraries')
        .send({ ownerId: id, importPaths: ['/path', '/path'] });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['importPaths'], message: 'Array must have unique items' }]),
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should reject duplicate exclusion patterns', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/libraries')
        .send({ ownerId: id, exclusionPatterns: ['**/Raw/**', '**/Raw/**'] });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['exclusionPatterns'], message: 'Array must have unique items' }]),
      );
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('PUT /libraries/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put('/libraries/invalid')
        .send({ name: 'New Library Name' });

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.update).not.toHaveBeenCalled();
    });

    it('should reject an empty name', async () => {
      const { status, body } = await request(ctx.getHttpServer()).put(`/libraries/${id}`).send({ name: '' });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['name'], message: 'Too small: expected string to have >=1 characters' },
        ]),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('should reject an empty import path', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/libraries/${id}`)
        .send({ importPaths: [''] });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['importPaths'], message: 'Array items must not be empty' }]),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('should reject duplicate import paths', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/libraries/${id}`)
        .send({ importPaths: ['/path', '/path'] });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['importPaths'], message: 'Array must have unique items' }]),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('should reject an empty exclusion pattern', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/libraries/${id}`)
        .send({ exclusionPatterns: [''] });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['exclusionPatterns'], message: 'Array items must not be empty' }]),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('should reject duplicate exclusion patterns', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/libraries/${id}`)
        .send({ exclusionPatterns: ['**/*.jpg', '**/*.jpg'] });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['exclusionPatterns'], message: 'Array must have unique items' }]),
      );
      expect(service.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /libraries/:id/validate', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/libraries/invalid/validate').send({});

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.validate).not.toHaveBeenCalled();
    });

    it('should not require import paths', async () => {
      service.validate.mockResolvedValue({ importPaths: [] });

      const { status } = await request(ctx.getHttpServer()).post(`/libraries/${id}/validate`).send({});

      expect(status).toBe(200);
      expect(service.validate).toHaveBeenCalledWith(id, {});
    });
  });

  describe('GET /libraries/:id/statistics', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/libraries/invalid/statistics');

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.getStatistics).not.toHaveBeenCalled();
    });
  });

  describe('POST /libraries/:id/scan', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/libraries/invalid/scan');

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(scans.queueManual).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /libraries/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).delete('/libraries/invalid');

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.delete).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /libraries/:id/scan (FL-78)', () => {
    it('should require a valid uuid', async () => {
      const { status } = await request(ctx.getHttpServer()).delete('/libraries/invalid/scan');

      expect(status).toBe(400);
      expect(scans.cancel).not.toHaveBeenCalled();
    });

    it('should cancel the library scan', async () => {
      scans.cancel.mockResolvedValue();
      const { status } = await request(ctx.getHttpServer()).delete(`/libraries/${id}/scan`);

      expect(status).toBe(204);
      expect(scans.cancel.mock.calls[0][1]).toBe(id);
    });
  });

  describe('GET /libraries/:id/removal (FL-78)', () => {
    it('adds whether a scan is running to the review', async () => {
      service.getRemovalReview.mockResolvedValue({ libraryId: id, scanActive: false } as never);
      scans.isActive.mockResolvedValue(true);

      const { status, body } = await request(ctx.getHttpServer()).get(`/libraries/${id}/removal`);

      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ libraryId: id, scanActive: true }));
    });
  });

  describe('POST /libraries/:id/removal (FL-78)', () => {
    it('requires the review token and the typed name', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/libraries/${id}/removal`).send({});

      expect(status).toBe(400);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('passes a complete confirmation on', async () => {
      service.remove.mockResolvedValue();
      const { status } = await request(ctx.getHttpServer())
        .post(`/libraries/${id}/removal`)
        .send({ reviewToken: 'token', confirmName: 'Archive' });

      expect(status).toBe(204);
      expect(service.remove.mock.calls[0].slice(1)).toEqual([id, { reviewToken: 'token', confirmName: 'Archive' }]);
    });
  });

  describe('GET /libraries/managed-uploads (FL-78)', () => {
    it('is not mistaken for a library id', async () => {
      service.getManagedUploads.mockResolvedValue([]);
      const { status } = await request(ctx.getHttpServer()).get('/libraries/managed-uploads');

      expect(status).toBe(200);
      expect(service.getManagedUploads).toHaveBeenCalled();
    });
  });
});
