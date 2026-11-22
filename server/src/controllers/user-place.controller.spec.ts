import request from 'supertest';
import { vi } from 'vitest';
import { UserPlaceController } from 'src/controllers/user-place.controller.js';
import { UserPlaceService } from 'src/services/user-place.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(UserPlaceController.name, () => {
  let ctx: ControllerContext;
  const service = { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const base = '/users/me/places';
  const id = factory.uuid();
  const home = { name: 'Home', latitude: 51.05, longitude: -114.07, radiusMeters: 200 };

  beforeAll(async () => {
    ctx = await controllerSetup(UserPlaceController, [{ provide: UserPlaceService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    await request(ctx.getHttpServer()).get(base);
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  it('names a place, trimming the name', async () => {
    const { status } = await request(ctx.getHttpServer())
      .post(base)
      .send({ ...home, name: '  Home ' });
    expect(status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(undefined, home);
  });

  it.each([
    ['no name', { ...home, name: '   ' }],
    ['a name over 80 characters', { ...home, name: 'x'.repeat(81) }],
    ['a radius under 25 m', { ...home, radiusMeters: 24 }],
    ['a radius over 5 km', { ...home, radiusMeters: 5001 }],
    ['a radius that is not whole metres', { ...home, radiusMeters: 99.5 }],
    ['a latitude off the map', { ...home, latitude: 91 }],
    ['a longitude off the map', { ...home, longitude: -181 }],
    ['no centre', { name: 'Home', radiusMeters: 200 }],
  ])('refuses %s', async (_, body) => {
    const { status } = await request(ctx.getHttpServer()).post(base).send(body);
    expect(status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('changes one thing or several, never nothing', async () => {
    const renamed = await request(ctx.getHttpServer()).patch(`${base}/${id}`).send({ name: 'Our house' });
    expect(renamed.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(undefined, id, { name: 'Our house' });
    const nothing = await request(ctx.getHttpServer()).patch(`${base}/${id}`).send({});
    expect(nothing.status).toBe(400);
    const tooWide = await request(ctx.getHttpServer()).patch(`${base}/${id}`).send({ radiusMeters: 6000 });
    expect(tooWide.status).toBe(400);
    expect(service.update).toHaveBeenCalledOnce();
  });

  it('removes a place', async () => {
    const { status } = await request(ctx.getHttpServer()).delete(`${base}/${id}`);
    expect(status).toBe(204);
    expect(service.delete).toHaveBeenCalledWith(undefined, id);
  });
});
