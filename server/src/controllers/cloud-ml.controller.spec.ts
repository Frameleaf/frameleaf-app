import { EventEmitter } from 'node:events';
import { CloudMlController } from 'src/controllers/cloud-ml.controller.js';
import { authStub } from 'test/fixtures/auth.stub.js';

it.each(['connected', 'disconnected', 'already closed'] as const)(
  'binds estimate preparation to its response lifetime when %s',
  async (state) => {
    const res = Object.assign(new EventEmitter(), { destroyed: state === 'already closed' });
    const result = { estimateId: 'estimate' };
    const service = {
      estimate: vi.fn((_auth, _dto, _now, signal: AbortSignal) => {
        if (state === 'disconnected') res.emit('close');
        expect(signal.aborted).toBe(state !== 'connected');
        signal.throwIfAborted();
        return Promise.resolve(result);
      }),
    };
    const controller = new CloudMlController(service as never);
    const work = controller.estimateCloudMlJob(authStub.user1, {} as never, res as never);
    if (state === 'connected') expect(await work).toBe(result);
    else await expect(work).rejects.toThrow();
    expect(res.listenerCount('close')).toBe(0);
  },
);
