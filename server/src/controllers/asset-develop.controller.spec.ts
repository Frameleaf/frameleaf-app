import { EventEmitter } from 'node:events';
import { AssetDevelopController } from 'src/controllers/asset-develop.controller.js';
import { authStub } from 'test/fixtures/auth.stub.js';

it('propagates a disconnected preview to native work and removes its response listener', async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false, set: vi.fn(), end: vi.fn() });
  const service = {
    preview: vi.fn((_auth, _id, _dto, signal: AbortSignal) => {
      res.emit('close');
      signal.throwIfAborted();
      return Promise.resolve();
    }),
  };
  const controller = new AssetDevelopController(service as never, {} as never);
  await expect(
    controller.previewAssetDevelop(authStub.user1, { id: 'id' }, {} as never, res as never),
  ).rejects.toThrow();
  expect(res.listenerCount('close')).toBe(0);
  expect(res.end).not.toHaveBeenCalled();
});
it('propagates proposal disconnects and preserves the existing artifact response', async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false });
  const artifact = { id: 'artifact' };
  const service = {
    proposeSemanticMask: vi.fn((_auth, _id, _dto, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return Promise.resolve(artifact);
    }),
  };
  const controller = new AssetDevelopController(service as never, {} as never);
  expect(await controller.proposeAssetDevelopMask(authStub.user1, { id: 'id' }, { target: 'sky' }, res as never)).toBe(
    artifact,
  );
  expect(res.listenerCount('close')).toBe(0);
});
