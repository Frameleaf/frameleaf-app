import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { EagleImportController } from 'src/controllers/eagle-import.controller.js';
import { EagleImportService } from 'src/services/eagle-import.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(EagleImportController.name, () => {
  let ctx: ControllerContext;
  const service = { get: vitest.fn(), stop: vitest.fn(), listUnfinished: vitest.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(EagleImportController, [{ provide: EagleImportService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    vitest.resetAllMocks();
    ctx.reset();
  });

  // Import ids come from `eagle_import.id`, which is a UUID v7.
  it('accepts a real import id when following and stopping an import', async () => {
    const id = uuidv7();
    service.get.mockResolvedValue({ id });
    service.stop.mockResolvedValue({ id });
    expect((await request(ctx.getHttpServer()).get(`/eagle-imports/${id}?outcomes=true`)).status).toBe(200);
    expect(service.get).toHaveBeenCalledWith(undefined, id, { outcomes: true });
    expect((await request(ctx.getHttpServer()).post(`/eagle-imports/${id}/stop`)).status).toBe(200);
    expect(service.stop).toHaveBeenCalledWith(undefined, id);
  });

  it('refuses an id that is not one', async () => {
    for (const id of ['nope', uuidv4()]) {
      expect((await request(ctx.getHttpServer()).get(`/eagle-imports/${id}`)).status).toBe(400);
    }
    expect(service.get).not.toHaveBeenCalled();
  });
});
