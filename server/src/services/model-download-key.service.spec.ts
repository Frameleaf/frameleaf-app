import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ModelDownloadKeyState } from 'src/types.js';
import { ModelDownloadKeyService } from 'src/services/model-download-key.service.js';
import { openModelDownloadKey, sealModelDownloadKey } from 'src/utils/model-download-key.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const KEY = `hf_${'a'.repeat(34)}`;
const HASH = 'server-keyed-hash';

describe(ModelDownloadKeyService.name, () => {
  let sut: ModelDownloadKeyService;
  let mocks: ServiceMocks;
  let stored: ModelDownloadKeyState | undefined;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ModelDownloadKeyService));
    stored = undefined;
    mocks.crypto.serverKeyedHash.mockResolvedValue(HASH);
    mocks.systemMetadata.get.mockImplementation(() => Promise.resolve(stored as never));
    mocks.systemMetadata.set.mockImplementation((_key, value) => {
      stored = value as ModelDownloadKeyState;
      return Promise.resolve();
    });
    mocks.systemMetadata.delete.mockImplementation(() => {
      stored = undefined;
      return Promise.resolve();
    });
  });

  it('says there is no key', async () => {
    await expect(sut.getStatus()).resolves.toEqual({ status: 'none', savedAt: null, checkedAt: null });
  });

  it('saves a key Hugging Face accepts, sealed, and gives it to the ML service', async () => {
    sut.check = vi.fn().mockResolvedValue('accepted');
    const result = await sut.save({ key: KEY });
    expect(result.status).toBe('saved');
    expect(stored?.sealed).toBeDefined();
    expect(stored?.sealed).not.toContain(KEY);
    expect(openModelDownloadKey(HASH, stored!.sealed)).toBe(KEY);
    expect(mocks.machineLearning.setModelDownloadKey).toHaveBeenCalledWith(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('does not save a key Hugging Face refuses', async () => {
    sut.check = vi.fn().mockResolvedValue('refused');
    await expect(sut.save({ key: KEY })).rejects.toBeInstanceOf(BadRequestException);
    expect(stored).toBeUndefined();
    expect(mocks.machineLearning.setModelDownloadKey).not.toHaveBeenCalled();
  });

  it('does not save a key it could not check', async () => {
    sut.check = vi.fn().mockResolvedValue('unreachable');
    await expect(sut.save({ key: KEY })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(stored).toBeUndefined();
  });

  it('checks a key again only after an hour, and marks one Hugging Face stopped accepting', async () => {
    const check = vi.fn().mockResolvedValue('refused');
    sut.check = check;
    const now = new Date().toISOString();
    stored = { sealed: sealModelDownloadKey(HASH, KEY), savedAt: now, state: 'accepted', checkedAt: now };
    await expect(sut.getStatus()).resolves.toMatchObject({ status: 'saved' });
    expect(check).not.toHaveBeenCalled();

    stored = { ...stored, checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    await expect(sut.getStatus()).resolves.toMatchObject({ status: 'refused' });
    expect(check).toHaveBeenCalledWith(KEY);
    expect(stored?.state).toBe('refused');
  });

  it('keeps the last answer when Hugging Face cannot be reached', async () => {
    sut.check = vi.fn().mockResolvedValue('unreachable');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    stored = { sealed: sealModelDownloadKey(HASH, KEY), savedAt: old, state: 'accepted', checkedAt: old };
    await expect(sut.getStatus()).resolves.toMatchObject({ status: 'saved', checkedAt: old });
  });

  it('never uses, but keeps, a key sealed under another key file', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    stored = { sealed: sealModelDownloadKey('another-server', KEY), savedAt: old, state: 'accepted', checkedAt: old };
    await expect(sut.getStatus()).resolves.toEqual({ status: 'none', savedAt: null, checkedAt: null });
    expect(mocks.systemMetadata.delete).not.toHaveBeenCalled();
    await sut.onBootstrap();
    sut.onShutdown();
    expect(mocks.machineLearning.setModelDownloadKey).toHaveBeenLastCalledWith(null);
  });

  it('does not pass on a key Hugging Face refused', async () => {
    const now = new Date().toISOString();
    stored = { sealed: sealModelDownloadKey(HASH, KEY), savedAt: now, state: 'refused', checkedAt: now };
    await sut.onBootstrap();
    sut.onShutdown();
    expect(mocks.machineLearning.setModelDownloadKey).toHaveBeenLastCalledWith(null);
  });

  it('checks an hour-old key again in the background and stops using it once refused', async () => {
    const check = vi.fn().mockResolvedValue('refused');
    sut.check = check;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    stored = { sealed: sealModelDownloadKey(HASH, KEY), savedAt: old, state: 'accepted', checkedAt: old };
    await sut.onBootstrap();
    sut.onShutdown();
    expect(check).toHaveBeenCalledWith(KEY);
    expect(stored?.state).toBe('refused');
    expect(mocks.machineLearning.setModelDownloadKey).toHaveBeenLastCalledWith(null);
  });

  it('removes the key and takes it from the ML service', async () => {
    const now = new Date().toISOString();
    stored = { sealed: sealModelDownloadKey(HASH, KEY), savedAt: now, state: 'accepted', checkedAt: now };
    await sut.remove();
    expect(stored).toBeUndefined();
    expect(mocks.machineLearning.setModelDownloadKey).toHaveBeenCalledWith(null);
  });

  it('loads the saved key for the ML service when the server starts', async () => {
    const now = new Date().toISOString();
    stored = { sealed: sealModelDownloadKey(HASH, KEY), savedAt: now, state: 'accepted', checkedAt: now };
    await sut.onBootstrap();
    sut.onShutdown();
    expect(mocks.machineLearning.setModelDownloadKey).toHaveBeenCalledWith(KEY);
  });
});
