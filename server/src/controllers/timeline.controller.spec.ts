import request from 'supertest';
import { TimelineController } from 'src/controllers/timeline.controller.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(TimelineController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(TimelineService);

  beforeAll(async () => {
    ctx = await controllerSetup(TimelineController, [{ provide: TimelineService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /timeline/buckets', () => {
    it('should parse bbox query string into an object', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get('/timeline/buckets')
        .query({ bbox: '11.075683,49.416711,11.117589,49.454875' });

      expect(status).toBe(200);
      expect(service.getTimeBuckets).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          bbox: { west: 11.075683, south: 49.416711, east: 11.117589, north: 49.454875 },
        }),
      );
    });

    it('should parse recently added date type', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/timeline/buckets').query({ dateType: 'added' });

      expect(status).toBe(200);
      expect(service.getTimeBuckets).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          dateType: 'added',
        }),
      );
    });

    it('should reject invalid date type', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/timeline/buckets')
        .query({ dateType: 'modified' });

      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['dateType'], message: 'Invalid option: expected one of "added"|"taken"' }]),
      );
    });

    it('should reject incomplete bbox query string', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/timeline/buckets').query({ bbox: '1,2,3' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['bbox'], message: 'bbox must have 4 comma-separated numbers: west,south,east,north' },
        ]),
      );
    });

    it('should reject invalid bbox query string', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/timeline/buckets')
        .query({ bbox: '1,2,3,invalid' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['bbox'], message: 'bbox parts must be valid numbers' }]));
    });
  });

  describe('GET /timeline/bucket', () => {
    it.each([
      '1970-02-01',
      '12345-01-01',
      '012345-01-01',
      '-000001-01-01',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00+05:30',
    ])('should accept valid time bucket %s', async (timeBucket) => {
      const { status } = await request(ctx.getHttpServer()).get('/timeline/bucket').query({ timeBucket });
      expect(status).toBe(200);
    });

    it.each(['foo', '2026', '2026-02-30', '2026-13-01'])('should reject invalid time bucket %s', async (timeBucket) => {
      const { status, body } = await request(ctx.getHttpServer()).get('/timeline/bucket').query({ timeBucket });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['timeBucket'], message: 'Invalid time bucket format' }]));
    });
  });

  describe('GET /timeline/highlights (FL-33)', () => {
    it('defaults to months and coerces the highlight count', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get('/timeline/highlights')
        .query({ highlightCount: '3', withPartners: 'true' });

      expect(status).toBe(200);
      expect(service.getTimelineHighlights).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ grouping: 'month', highlightCount: 3, withPartners: true }),
      );
    });

    it('rejects an unknown grouping and too many highlights', async () => {
      const grouping = await request(ctx.getHttpServer()).get('/timeline/highlights').query({ grouping: 'day' });
      expect(grouping.status).toBe(400);

      const count = await request(ctx.getHttpServer()).get('/timeline/highlights').query({ highlightCount: '13' });
      expect(count.status).toBe(400);
    });
  });
});
