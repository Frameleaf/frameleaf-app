import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { NextFunction, Response } from 'express';
import { PhotographyWorkflowController } from 'src/controllers/photography-workflow.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';

vi.mock('src/services/photography-workflow.service.js', () => ({ PhotographyWorkflowService: class {} }));
vi.mock('src/services/auth.service.js', () => ({ AuthService: class {} }));
vi.mock('src/utils/file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/file.js')>()),
  sendFile: async (_res: unknown, _next: unknown, prepare: () => Promise<unknown>) => {
    await prepare();
  },
}));

describe.each(['archive', 'output', 'file'] as const)('photography %s delivery recording', (route) => {
  it.each([
    ['HEAD', 200, 'finish', false],
    ['GET', 200, 'finish', true],
    ['GET', 206, 'finish', false],
    ['GET', 404, 'finish', false],
    ['GET', 200, 'close', false],
  ] as const)('records %s status %i on %s only for a completed GET', async (method, statusCode, event, recorded) => {
    const deliveries: unknown[][] = [];
    const stream = Readable.from(Buffer.from('archive'));
    const service = {
      archive: () => Promise.resolve({ stream, type: 'application/zip' }),
      outputFile: () => Promise.resolve({}),
      file: () => Promise.resolve({}),
      recordDelivery: (...args: unknown[]) => {
        deliveries.push(args);
        return Promise.resolve();
      },
    } as unknown as PhotographyWorkflowService;
    const controller = new PhotographyWorkflowController(service, { warn: vi.fn() } as unknown as LoggingRepository);
    const response = Object.assign(new EventEmitter(), {
      statusCode,
      req: { method },
      header: () => {},
      destroyed: false,
      writableEnded: false,
    }) as unknown as Response;
    const next: NextFunction = () => {};
    try {
      if (route === 'archive') await controller.archive('gallery', 'zip', 'session', response);
      else if (route === 'output') await controller.output('gallery', 'capture', 'output', 'session', response, next);
      else await controller.file('gallery', 'capture', 'download', 'session', response, next);
      response.emit(event);
      const expected =
        route === 'archive'
          ? ['gallery', 'session', undefined, 'zip']
          : route === 'output'
            ? ['gallery', 'session', 'capture', undefined, 'output']
            : ['gallery', 'session', 'capture'];
      expect(deliveries).toEqual(recorded ? [expected] : []);
    } finally {
      stream.destroy();
    }
  });
});
