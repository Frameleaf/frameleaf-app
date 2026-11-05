import request from 'supertest';
import { MapController } from 'src/controllers/map.controller.js';
import { MapService } from 'src/services/map.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(MapController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(MapService);

  beforeAll(async () => {
    ctx = await controllerSetup(MapController, [{ provide: MapService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /map/clusters (FL-1214)', () => {
    it('should require a zoom level', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/map/clusters');

      expect(status).toBe(400);
      expect(service.getMapClusters).not.toHaveBeenCalled();
    });

    it('should refuse an edge outside the world', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get('/map/clusters')
        .query({ zoom: 3, west: -200, south: 0, east: 10, north: 10 });

      expect(status).toBe(400);
      expect(service.getMapClusters).not.toHaveBeenCalled();
    });

    it('should refuse a zoom level above 22 (FL-1246)', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/map/clusters').query({ zoom: 23 });

      expect(status).toBe(400);
      expect(service.getMapClusters).not.toHaveBeenCalled();
    });

    it('should read the area and zoom as numbers', async () => {
      service.getMapClusters.mockResolvedValue({ complete: false, total: 0, bounds: null, clusters: [], markers: [] });
      const { status } = await request(ctx.getHttpServer())
        .get('/map/clusters')
        .query({ zoom: 3, west: 170.5, south: -10, east: -170, north: 10, withSharedAlbums: true });

      expect(status).toBe(200);
      expect(service.getMapClusters).toHaveBeenCalledWith(undefined, {
        zoom: 3,
        west: 170.5,
        south: -10,
        east: -170,
        north: 10,
        withSharedAlbums: true,
      });
    });
  });

  describe('GET /map/markers paging (FL-1214)', () => {
    it('should refuse a page larger than 1000', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/map/markers').query({ take: 1001 });

      expect(status).toBe(400);
      expect(service.getMapMarkers).not.toHaveBeenCalled();
    });
  });

  describe('GET /map/reverse-geocode', () => {
    it('should require a lat', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/map/reverse-geocode').query({ lon: 123 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lat'], message: 'Invalid input: expected number, received NaN' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });

    it('should require a lat that is a number', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/map/reverse-geocode')
        .query({ lat: 'abc', lon: 123.456 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lat'], message: 'Invalid input: expected number, received NaN' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });

    it('should require a lat that is in range', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/map/reverse-geocode')
        .query({ lat: 91, lon: 123.456 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lat'], message: 'Too big: expected number to be <=90' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });

    it('should require a lon', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/map/reverse-geocode').query({ lat: 75 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lon'], message: 'Invalid input: expected number, received NaN' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });
  });
});
