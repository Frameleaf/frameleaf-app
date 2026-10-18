import { EventEmitter } from 'node:events';
import { PhotoSourceController } from 'src/controllers/photo-source.controller.js';

const dto = { uploadResourceId: '11111111-1111-4111-8111-111111111111' };
const params = { id: dto.uploadResourceId, runId: dto.uploadResourceId, itemId: dto.uploadResourceId };
it('disconnect cancels verification and removes its response listener without masking unrelated errors', async () => {
  for (const unrelated of [false, true]) {
    const response = Object.assign(new EventEmitter(), { destroyed: false });
    const failure = new Error('unrelated');
    const service = {
      verify: vi.fn(
        (_auth, _source, _run, _item, _dto, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(unrelated ? failure : signal.reason), { once: true }),
          ),
      ),
    };
    const controller = new PhotoSourceController(service as never);
    const pending = controller.verifyPhotoSourceCopy({} as never, params, dto, response as never);
    response.destroyed = true;
    response.emit('close');
    if (unrelated) await expect(pending).rejects.toBe(failure);
    else await expect(pending).resolves.toBeUndefined();
    expect(response.listenerCount('close')).toBe(0);
  }
});
it('normal completion removes its close listener', async () => {
  const response = Object.assign(new EventEmitter(), { destroyed: false });
  const receipt = { storage: 'managed' };
  const controller = new PhotoSourceController({ verify: vi.fn().mockResolvedValue(receipt) } as never);
  expect(await controller.verifyPhotoSourceCopy({} as never, params, dto, response as never)).toBe(receipt);
  expect(response.listenerCount('close')).toBe(0);
});
