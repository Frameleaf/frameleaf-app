import request from 'supertest';
import { PersonController } from 'src/controllers/person.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonService } from 'src/services/person.service.js';
import { errorDto } from 'test/medium/responses.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(PersonController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PersonService);

  beforeAll(async () => {
    ctx = await controllerSetup(PersonController, [
      { provide: PersonService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /people', () => {
    it(`should require closestPersonId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/people`)
        .query({ closestPersonId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['closestPersonId'], message: 'Invalid UUID' }]));
    });

    it(`should require closestAssetId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/people`)
        .query({ closestAssetId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['closestAssetId'], message: 'Invalid UUID' }]));
    });
  });

  describe('DELETE /people', () => {
    it('should require uuids in the body', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete('/people')
        .send({ ids: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
    });

    it('should respond with 204', async () => {
      const { status } = await request(ctx.getHttpServer())
        .delete(`/people`)
        .send({ ids: [factory.uuid()] });
      expect(status).toBe(204);
      expect(service.deleteAll).toHaveBeenCalled();
    });
  });

  describe('PUT /people/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).put(`/people/123`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: [], message: 'Invalid input: expected object, received undefined' }]),
      );
    });

    it(`should not allow a null name`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/people`)
        .send({ name: null })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['name'], message: 'Invalid input: expected string, received null' }]),
      );
    });

    it(`should require featureFaceAssetId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ featureFaceAssetId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['featureFaceAssetId'], message: 'Invalid UUID' }]));
    });

    it(`should require isFavorite to be a boolean`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ isFavorite: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['isFavorite'], message: 'Invalid input: expected boolean, received string' },
        ]),
      );
    });

    it(`should require isHidden to be a boolean`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ isHidden: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['isHidden'], message: 'Invalid input: expected boolean, received string' }]),
      );
    });

    it('should not accept an invalid birth date (false)', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ birthDate: false });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['birthDate'], message: 'Invalid input: expected string, received boolean' },
        ]),
      );
    });

    it('should not accept an invalid birth date (number)', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ birthDate: 123_456 });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['birthDate'], message: 'Invalid input: expected string, received number' }]),
      );
    });

    it('should not accept a birth date in the future)', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ birthDate: '9999-01-01' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['birthDate'], message: 'Birth date cannot be in the future' }]),
      );
    });
  });

  describe('DELETE /people/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).delete(`/people/invalid`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should respond with 204', async () => {
      const { status } = await request(ctx.getHttpServer()).delete(`/people/${factory.uuid()}`);
      expect(status).toBe(204);
      expect(service.delete).toHaveBeenCalled();
    });
  });
  describe('GET /people/merge-suggestions', () => {
    it('should not be swallowed by GET /people/:id (route order regression)', async () => {
      // FL-57: `merge-suggestions` must be declared before `:id` in the controller, or
      // this path is matched by `getPerson` instead and 400s on UUID validation.
      service.getMergeSuggestions.mockResolvedValue({ suggestions: [] });
      const { status, body } = await request(ctx.getHttpServer()).get('/people/merge-suggestions');
      expect(status).toBe(200);
      expect(body).toEqual({ suggestions: [] });
      expect(service.getMergeSuggestions).toHaveBeenCalled();
    });
  });

  describe('PUT /people/merge-suggestions/verdicts', () => {
    it('should reject an unknown verdict', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/people/merge-suggestions/verdicts')
        .send({ personId: factory.uuid(), suggestionId: factory.uuid(), verdict: 'maybe' });
      expect(status).toBe(400);
      expect(service.setMergeVerdict).not.toHaveBeenCalled();
    });

    it('should record a verdict', async () => {
      const dto = { personId: factory.uuid(), suggestionId: factory.uuid(), verdict: 'different' };
      service.setMergeVerdict.mockResolvedValue({
        ...dto,
        verdict: 'different',
        createdAt: '2026-09-24T00:00:00.000Z',
      });
      const { status } = await request(ctx.getHttpServer()).put('/people/merge-suggestions/verdicts').send(dto);
      expect(status).toBe(200);
      expect(service.setMergeVerdict).toHaveBeenCalledWith(undefined, dto);
    });
  });

  describe('DELETE /people/merge-suggestions/verdicts', () => {
    it('should require valid uuids', async () => {
      const { status } = await request(ctx.getHttpServer())
        .delete('/people/merge-suggestions/verdicts')
        .send({ personId: 'invalid', suggestionId: factory.uuid() });
      expect(status).toBe(400);
    });

    it('should undo a verdict', async () => {
      const dto = { personId: factory.uuid(), suggestionId: factory.uuid() };
      const { status } = await request(ctx.getHttpServer()).delete('/people/merge-suggestions/verdicts').send(dto);
      expect(status).toBe(204);
      expect(service.deleteMergeVerdict).toHaveBeenCalledWith(undefined, dto);
    });
  });

  describe('GET /people/:id/corrections', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/people/invalid/corrections');
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should return a page of the correction history', async () => {
      const id = factory.uuid();
      service.getCorrectionHistory.mockResolvedValue({ corrections: [], hasNextPage: false });
      const { status, body } = await request(ctx.getHttpServer()).get(`/people/${id}/corrections?page=2&size=10`);
      expect(status).toBe(200);
      expect(body).toEqual({ corrections: [], hasNextPage: false });
      expect(service.getCorrectionHistory).toHaveBeenCalledWith(undefined, id, { page: 2, size: 10 });
    });

    it('should default to the first page of 25 and refuse pages over 100', async () => {
      const id = factory.uuid();
      service.getCorrectionHistory.mockResolvedValue({ corrections: [], hasNextPage: false });
      await request(ctx.getHttpServer()).get(`/people/${id}/corrections`);
      expect(service.getCorrectionHistory).toHaveBeenCalledWith(undefined, id, { page: 1, size: 25 });

      const { status } = await request(ctx.getHttpServer()).get(`/people/${id}/corrections?size=101`);
      expect(status).toBe(400);
    });
  });

  describe('POST /people/corrections/:id/undo', () => {
    it('should require a valid uuid', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/people/corrections/invalid/undo');
      expect(status).toBe(400);
    });

    it('should undo one correction', async () => {
      const id = factory.uuid();
      service.undoCorrection.mockResolvedValue({} as never);
      const { status } = await request(ctx.getHttpServer()).post(`/people/corrections/${id}/undo`);
      expect(status).toBe(200);
      expect(service.undoCorrection).toHaveBeenCalledWith(undefined, id);
    });
  });

  it('should accept the ignore and same verdicts', async () => {
    for (const verdict of ['ignore', 'same']) {
      const dto = { personId: factory.uuid(), suggestionId: factory.uuid(), verdict };
      const { status } = await request(ctx.getHttpServer()).put('/people/merge-suggestions/verdicts').send(dto);
      expect(status).toBe(200);
      expect(service.setMergeVerdict).toHaveBeenCalledWith(undefined, dto);
    }
  });

  it('should expose ordered and legacy merge routes', async () => {
    const ids = [factory.uuid(), factory.uuid()];
    service.mergePeople.mockResolvedValue([{ id: ids[1], success: true }]);
    const ordered = await request(ctx.getHttpServer()).post('/people/merge').send({ ids });
    expect(ordered.status).toBe(200);
    expect(service.mergePeople).toHaveBeenLastCalledWith(undefined, { ids });
    const legacy = await request(ctx.getHttpServer())
      .post(`/people/${ids[0]}/merge`)
      .send({ ids: [ids[1]] });
    expect(legacy.status).toBe(200);
    expect(service.mergePeople).toHaveBeenLastCalledWith(undefined, { ids });
  });
});
