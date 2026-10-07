import { BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AssetDevelopController } from 'src/controllers/asset-develop.controller.js';
import { authStub } from 'test/fixtures/auth.stub.js';

it('propagates explicit export refusals and disconnects before filesystem handling', async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false });
  const refusal = new BadRequestException({
    code: 'hdr_heic_export_unavailable',
    message: 'HDR HEIC export is unavailable',
  });
  const service = { getFile: vi.fn().mockRejectedValue(refusal) };
  const controller = new AssetDevelopController(service as never, {} as never);
  const next = vi.fn();
  await expect(
    controller.viewAssetDevelopFile(
      authStub.user1,
      { id: 'asset', revisionId: 'revision' },
      { kind: 'master', format: 'hdr-heic' } as never,
      res as never,
      next,
    ),
  ).rejects.toBe(refusal);
  expect(next).not.toHaveBeenCalled();
  expect(res.listenerCount('close')).toBe(0);
  service.getFile.mockImplementation((_auth, _id, _revision, _kind, _range, _format, signal: AbortSignal) => {
    res.emit('close');
    signal.throwIfAborted();
    return Promise.resolve();
  });
  await expect(
    controller.viewAssetDevelopFile(
      authStub.user1,
      { id: 'asset', revisionId: 'revision' },
      { kind: 'master', format: 'sdr-jpeg' } as never,
      res as never,
      next,
    ),
  ).rejects.toThrow();
  expect(res.listenerCount('close')).toBe(0);
});

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

it('delivers authoritative HDR histogram evidence on the private preview response', async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false, set: vi.fn(), end: vi.fn() });
  const histogram = { version: 1, peakStops: 3 };
  const service = {
    preview: vi.fn().mockResolvedValue({ buffer: Buffer.from('hdr'), contentType: 'image/jpeg', histogram }),
  };
  await new AssetDevelopController(service as never, {} as never).previewAssetDevelop(
    authStub.user1,
    { id: 'id' },
    {} as never,
    res as never,
  );
  expect(res.set).toHaveBeenCalledWith(
    expect.objectContaining({
      'Cache-Control': 'private, no-store',
      'X-Frameleaf-HDR-Histogram': JSON.stringify(histogram),
    }),
  );
  expect(res.end).toHaveBeenCalledWith(Buffer.from('hdr'));
});
