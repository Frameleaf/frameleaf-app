import request from 'supertest';
import { TagController } from 'src/controllers/tag.controller.js';
import { TagService } from 'src/services/tag.service.js';
import { errorDto } from 'test/medium/responses.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(TagController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(TagService);

  beforeAll(async () => {
    ctx = await controllerSetup(TagController, [{ provide: TagService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /tags', () => {
    it('should a null parentId', async () => {
      await request(ctx.getHttpServer()).post(`/tags`).send({ name: 'tag', parentId: null });
      expect(service.create).toHaveBeenCalledWith(undefined, expect.objectContaining({ parentId: null }));
    });
    it('should require a valid parentId', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/tags`)
        .send({ name: 'tag', parentId: 'invalid-id' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['parentId'], message: 'Invalid UUID' }]));
    });
    it('should throw an error if a slash is in tag name', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/tags`)
        .send({ name: 'tagA/tagB', parentId: factory.uuid() });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['name'], message: 'Tag name cannot contain slash characters ("/")' }]),
      );
    });
    it('should accept a null color', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/tags`).send({ name: 'tagA', color: null });
      expect(status).toBe(201);
    });
    it('should require a valid color', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/tags`)
        .send({ name: 'tagA', color: 'invalid-color' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          {
            path: ['color'],
            message:
              'Invalid string: must match pattern /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/',
          },
        ]),
      );
    });
  });

  describe('GET /tags/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get(`/tags/123`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('PUT /tags/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/tags/123`)
        .send({ name: 'tag', color: '#000000' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
    it('should require a valid color', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/tags/${factory.uuid()}`)
        .send({ name: 'tag', color: 'invalid-color' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          {
            path: ['color'],
            message:
              'Invalid string: must match pattern /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/',
          },
        ]),
      );
    });
    it('should throw an error if a slash is in tag name', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/tags/${factory.uuid()}`)
        .send({ name: 'tagA/tagB', color: '#000000' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['name'], message: 'Tag name cannot contain slash characters ("/")' }]),
      );
    });
    it('should accept a null color', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/tags/${factory.uuid()}`)
        .send({ name: 'tagA', color: null });
      expect(status).toBe(200);
    });
  });

  describe('DELETE /tags/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).delete(`/tags/123`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('POST /tags/:id/merge', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/tags/123/merge`)
        .send({ targetId: factory.uuid() });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
    it('should require the tag to merge into', async () => {
      for (const dto of [{}, { targetId: null }, { targetId: 'invalid-id' }]) {
        const { status, body } = await request(ctx.getHttpServer()).post(`/tags/${factory.uuid()}/merge`).send(dto);
        expect(status).toBe(400);
        expect(body.message).toBe('Validation failed');
        expect(body.errors).toEqual([expect.objectContaining({ path: ['targetId'] })]);
      }
      expect(service.merge).not.toHaveBeenCalled();
    });
    it('should answer the tag that stays with 200', async () => {
      const [id, targetId] = [factory.uuid(), factory.uuid()];
      service.merge.mockResolvedValue({ id: targetId } as never);
      const { status, body } = await request(ctx.getHttpServer()).post(`/tags/${id}/merge`).send({ targetId });
      expect(status).toBe(200);
      expect(body).toEqual({ id: targetId });
      expect(service.merge).toHaveBeenCalledWith(undefined, id, { targetId });
    });
  });
});
