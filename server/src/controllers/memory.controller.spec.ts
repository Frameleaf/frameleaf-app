import request from 'supertest';
import { MemoryController } from 'src/controllers/memory.controller.js';
import { MemoryService } from 'src/services/memory.service.js';
import { errorDto } from 'test/medium/responses.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(MemoryController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(MemoryService);

  beforeAll(async () => {
    ctx = await controllerSetup(MemoryController, [{ provide: MemoryService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /memories', () => {
    it('should not require any parameters', async () => {
      await request(ctx.getHttpServer()).get('/memories').query({});
      expect(service.search).toHaveBeenCalled();
    });
  });

  describe('POST /memories', () => {
    it('should validate data when type is on this day', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/memories')
        .send({
          type: 'on_this_day',
          data: {},
          memoryAt: new Date(2021).toISOString(),
        });

      expect(status).toBe(400);
      // Memory data is a union of event story, year in review and on this day (FL-62), so zod
      // reports the miss on `data` and nests each branch; the on-this-day branch still needs a year.
      expect(body).toEqual({
        message: 'Validation failed',
        errors: [
          expect.objectContaining({
            path: ['data'],
            message: 'Invalid input',
            errors: expect.arrayContaining([
              [
                expect.objectContaining({
                  path: ['year'],
                  message: 'Invalid input: expected number, received undefined',
                }),
              ],
            ]),
          }),
        ],
      });
    });

    it('should accept showAt and hideAt', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/memories')
        .send({
          type: 'on_this_day',
          data: { year: 2020 },
          memoryAt: new Date(2021).toISOString(),
          showAt: new Date(2022).toISOString(),
          hideAt: new Date(2023).toISOString(),
        });

      expect(status).toBe(201);
    });
  });

  describe('GET /memories/:id', () => {
    it('should require a valid id', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get(`/memories/invalid`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('PUT /memories/:id', () => {
    it('should require a valid id', async () => {
      const { status, body } = await request(ctx.getHttpServer()).put(`/memories/invalid`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: [], message: 'Invalid input: expected object, received undefined' }]),
      );
    });

    it('should require at least one field', async () => {
      const { status, body } = await request(ctx.getHttpServer()).put(`/memories/${factory.uuid()}`).send({});
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          {
            path: [],
            message:
              'At least one of the following fields is required: isSaved, seenAt, memoryAt, isHidden, title, assetOrder',
          },
        ]),
      );
    });
  });

  describe('PUT /memories/:id/assets', () => {
    it('should require a valid id', async () => {
      const { status, body } = await request(ctx.getHttpServer()).put(`/memories/invalid/assets`).send({ ids: [] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should require a valid asset id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/memories/${factory.uuid()}/assets`)
        .send({ ids: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
    });
  });

  describe('DELETE /memories/:id/assets', () => {
    it('should require a valid id', async () => {
      const { status, body } = await request(ctx.getHttpServer()).delete(`/memories/invalid/assets`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should require a valid asset id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete(`/memories/${factory.uuid()}/assets`)
        .send({ ids: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
    });
  });

  describe('POST /memories/show-less (FL-62)', () => {
    it('should require a known kind and a value', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/memories/show-less')
        .send({ kind: 'album', value: 'x' });
      expect(status).toBe(400);

      const empty = await request(ctx.getHttpServer()).post('/memories/show-less').send({ kind: 'date', value: '' });
      expect(empty.status).toBe(400);
    });
  });

  describe('PUT /memories/:id curation (FL-62)', () => {
    it('should refuse an empty title and an item order with an invalid id', async () => {
      const id = factory.uuid();
      const title = await request(ctx.getHttpServer())
        .put(`/memories/${id}`)
        .send({ title: ' '.repeat(3) });
      expect(title.status).toBe(400);

      const order = await request(ctx.getHttpServer())
        .put(`/memories/${id}`)
        .send({ assetOrder: ['nope'] });
      expect(order.status).toBe(400);
    });
  });
});
