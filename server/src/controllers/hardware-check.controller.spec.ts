import request from 'supertest';
import { HardwareCheckController } from 'src/controllers/hardware-check.controller.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(HardwareCheckController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(HardwareCheckService);

  beforeAll(async () => {
    ctx = await controllerSetup(HardwareCheckController, [{ provide: HardwareCheckService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for every route', async () => {
    for (const [method, path] of [
      ['get', '/admin/hardware'],
      ['post', '/admin/hardware/check'],
      ['post', '/admin/hardware/benchmark'],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('runs a check and a benchmark on request', async () => {
    await request(ctx.getHttpServer()).post('/admin/hardware/check').expect(200);
    await request(ctx.getHttpServer()).post('/admin/hardware/benchmark').expect(200);
    expect(service.runCheck).toHaveBeenCalledTimes(1);
    expect(service.runBenchmark).toHaveBeenCalledTimes(1);
  });
});
