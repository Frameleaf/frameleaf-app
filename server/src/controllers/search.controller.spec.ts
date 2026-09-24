import request from 'supertest';
import { SearchController } from 'src/controllers/search.controller.js';
import { SearchService } from 'src/services/search.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(SearchController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(SearchService);

  beforeAll(async () => {
    ctx = await controllerSetup(SearchController, [{ provide: SearchService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /search/metadata', () => {
    it('should reject page as a string', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/search/metadata').send({ page: 'abc' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['page'], message: 'Invalid input: expected number, received string' }]),
      );
    });

    it('should reject page as a negative number', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/search/metadata').send({ page: -10 });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['page'], message: 'Too small: expected number to be >=1' }]),
      );
    });

    it('should reject page as 0', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/search/metadata').send({ page: 0 });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['page'], message: 'Too small: expected number to be >=1' }]),
      );
    });

    it('should reject size as a string', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/search/metadata').send({ size: 'abc' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['size'], message: 'Invalid input: expected number, received string' }]),
      );
    });

    it('should reject an invalid size', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/search/metadata').send({ size: -1 });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['size'], message: 'Too small: expected number to be >=1' }]),
      );
    });

    it('should reject an visibility as not an enum', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ visibility: 'immich' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['visibility'], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
    });

    it('should reject an isFavorite as not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ isFavorite: 'immich' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['isFavorite'], message: 'Invalid input: expected boolean, received string' },
        ]),
      );
    });

    it('should reject an isEncoded as not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ isEncoded: 'immich' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['isEncoded'], message: 'Invalid input: expected boolean, received string' },
        ]),
      );
    });

    it('should reject an isOffline as not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ isOffline: 'immich' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['isOffline'], message: 'Invalid input: expected boolean, received string' },
        ]),
      );
    });

    it('should reject an isMotion as not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/search/metadata').send({ isMotion: 'immich' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['isMotion'], message: 'Invalid input: expected boolean, received string' }]),
      );
    });

    it('should reject a deprecated field combined with a new structure field', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ filter: {}, city: 'Oslo' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['city'], message: 'Deprecated field city cannot be combined with filter' }]),
      );
    });

    it('should reject an unknown key in the filter', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ filter: { previewPath: { eq: 'preview.webp' } } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['filter'], message: 'Unrecognized key: "previewPath"' }]),
      );
    });

    it('should reject a nested or', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ filter: { or: [{ or: [{ city: { eq: 'Oslo' } }] }] } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['filter', 'or', 0], message: 'Unrecognized key: "or"' }]),
      );
    });

    it('should reject an empty or branch', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/search/metadata')
        .send({ filter: { or: [{}] } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['filter', 'or', 0], message: 'At least one filter condition is required' }]),
      );
    });

    describe('POST /search/random', () => {
      it('should reject if withStacked is not a boolean', async () => {
        const { status, body } = await request(ctx.getHttpServer())
          .post('/search/random')
          .send({ withStacked: 'immich' });
        expect(status).toBe(400);
        expect(body).toEqual(
          errorDto.validationError([
            { path: ['withStacked'], message: 'Invalid input: expected boolean, received string' },
          ]),
        );
      });

      it('should reject if withPeople is not a boolean', async () => {
        const { status, body } = await request(ctx.getHttpServer())
          .post('/search/random')
          .send({ withPeople: 'immich' });
        expect(status).toBe(400);
        expect(body).toEqual(
          errorDto.validationError([
            { path: ['withPeople'], message: 'Invalid input: expected boolean, received string' },
          ]),
        );
      });
    });

    describe('POST /search/smart', () => {
      it('should be an authenticated route', async () => {
        await request(ctx.getHttpServer()).post('/search/smart');
        expect(ctx.authenticate).toHaveBeenCalled();
      });
    });

    describe('POST /search/ask', () => {
      it('should be an authenticated route', async () => {
        await request(ctx.getHttpServer()).post('/search/ask').send({ query: 'photos of Alice' });
        expect(ctx.authenticate).toHaveBeenCalled();
      });

      it('should require a query', async () => {
        const { status, body } = await request(ctx.getHttpServer()).post('/search/ask').send({});
        expect(status).toBe(400);
        expect(body).toEqual(
          errorDto.validationError([
            { path: ['query'], message: 'Invalid input: expected string, received undefined' },
          ]),
        );
      });
    });

    describe('GET /search/explore', () => {
      it('should be an authenticated route', async () => {
        await request(ctx.getHttpServer()).get('/search/explore');
        expect(ctx.authenticate).toHaveBeenCalled();
      });
    });

    describe('POST /search/person', () => {
      it('should require a name', async () => {
        const { status, body } = await request(ctx.getHttpServer()).get('/search/person').send({});
        expect(status).toBe(400);
        expect(body).toEqual(
          errorDto.validationError([{ path: ['name'], message: 'Invalid input: expected string, received undefined' }]),
        );
      });
    });

    describe('GET /search/places', () => {
      it('should require a name', async () => {
        const { status, body } = await request(ctx.getHttpServer()).get('/search/places').send({});
        expect(status).toBe(400);
        expect(body).toEqual(
          errorDto.validationError([{ path: ['name'], message: 'Invalid input: expected string, received undefined' }]),
        );
      });
    });

    describe('GET /search/suggestions', () => {
      it('should require a type', async () => {
        const { status, body } = await request(ctx.getHttpServer()).get('/search/suggestions').send({});
        expect(status).toBe(400);
        expect(body).toEqual(
          errorDto.validationError([
            { path: ['type'], message: expect.stringContaining('Invalid option: expected one of') },
          ]),
        );
      });
    });
  });

  describe('FL-49 facets, histogram and smart statistics', () => {
    it('POST /search/facets accepts a structured body with facet options', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/search/facets')
        .send({ filter: { isFavorite: { eq: true } }, facets: ['people', 'city'], facetLimit: 5 });
      expect(status).toBe(200);
      expect(service.searchFacets).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ facets: ['people', 'city'], facetLimit: 5 }),
      );
    });

    it('POST /search/facets rejects an unknown facet and mixing flat fields with a filter', async () => {
      const unknown = await request(ctx.getHttpServer())
        .post('/search/facets')
        .send({ facets: ['iso'] });
      expect(unknown.status).toBe(400);
      const mixed = await request(ctx.getHttpServer())
        .post('/search/facets')
        .send({ city: 'Lisbon', filter: { isFavorite: { eq: true } } });
      expect(mixed.status).toBe(400);
      const limit = await request(ctx.getHttpServer()).post('/search/facets').send({ facetLimit: 101 });
      expect(limit.status).toBe(400);
      const tooMany = await request(ctx.getHttpServer())
        .post('/search/facets')
        .send({ facets: Array.from({ length: 11 }, () => 'city') });
      expect(tooMany.status).toBe(400);
    });

    it('POST /search/histogram defaults to months and rejects other granularities', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/search/histogram').send({});
      expect(status).toBe(200);
      expect(service.searchHistogram).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ granularity: 'month' }),
      );
      const week = await request(ctx.getHttpServer()).post('/search/histogram').send({ granularity: 'week' });
      expect(week.status).toBe(400);
    });

    it('POST /search/smart/statistics takes a smart search body', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/search/smart/statistics').send({ query: 'beach' });
      expect(status).toBe(200);
      expect(service.searchSmartStatistics).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ query: 'beach' }),
      );
    });
  });
});
