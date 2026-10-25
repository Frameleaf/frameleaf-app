import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { StudioCatalogController } from 'src/controllers/studio-catalog.controller.js';
import { authStub } from 'test/fixtures/auth.stub.js';

describe(StudioCatalogController.name, () => {
  it('cancels media facts on response close and removes the listener after settlement', async () => {
    const response = Object.assign(new EventEmitter(), { destroyed: false });
    const service = {
      getMediaFacts: vi.fn((_auth, _id, signal: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
    };
    const sut = new StudioCatalogController(service as never, {} as never);
    const result = sut.getStudioMediaFacts(authStub.admin, { id: 'asset' }, response as unknown as Response);
    const rejected = expect(result).rejects.toThrow();
    response.emit('close');
    await rejected;
    expect(service.getMediaFacts.mock.calls[0][2].aborted).toBe(true);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('does not start media facts for an already closed response', async () => {
    const response = Object.assign(new EventEmitter(), { destroyed: true });
    const service = { getMediaFacts: vi.fn() };
    const sut = new StudioCatalogController(service as never, {} as never);
    await expect(
      sut.getStudioMediaFacts(authStub.admin, { id: 'asset' }, response as unknown as Response),
    ).rejects.toThrow();
    expect(service.getMediaFacts).not.toHaveBeenCalled();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('returns completed facts and removes its response listener', async () => {
    const response = Object.assign(new EventEmitter(), { destroyed: false });
    const service = { getMediaFacts: vi.fn().mockResolvedValue({ source: 'stored' }) };
    const sut = new StudioCatalogController(service as never, {} as never);
    await expect(
      sut.getStudioMediaFacts(authStub.admin, { id: 'asset' }, response as unknown as Response),
    ).resolves.toEqual({ source: 'stored' });
    expect(response.listenerCount('close')).toBe(0);
  });
});
