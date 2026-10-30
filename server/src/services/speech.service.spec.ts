import { ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationStatus, MlDestinationKind } from 'src/enum.js';
import { TranscriptionUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { SpeechService, speechFolder } from 'src/services/speech.service.js';
import { factory } from 'test/small.factory.js';

vi.mock('src/utils/ml-destination.js', () => ({
  selectMlDestination: vi.fn().mockResolvedValue({ kind: 'local', id: 'worker' }),
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'frameleaf-speech-unit-'));
  vi.spyOn(StorageCore, 'getFolderLocation').mockReturnValue(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const setup = async (audio = true, duration = 10) => {
  const input = join(root, 'synthetic.bin');
  await writeFile(input, 'synthetic-only');
  const operation = {
    id: randomUUID(),
    ownerId: randomUUID(),
    assetId: randomUUID(),
    snapshot: { destinationId: randomUUID(), modelFingerprint: 'a'.repeat(64) },
  } as unknown as MediaOperation;
  const claimToken = randomUUID(),
    identity = { model: 'whisper-small', fingerprint: 'a'.repeat(64) };
  const repository = {
    source: vi.fn().mockResolvedValue({
      id: operation.assetId,
      originalPath: input,
      checksum: createHash('sha256').update('synthetic-only').digest(),
    }),
    checkpoint: vi.fn().mockResolvedValue(undefined),
    saveChunk: vi.fn().mockResolvedValue(true),
    publish: vi.fn().mockResolvedValue(true),
  };
  const operations = {
    heartbeat: vi.fn().mockResolvedValue(true),
    reportProgress: vi.fn().mockResolvedValue(true),
    beginValidation: vi.fn().mockResolvedValue(true),
    getForWorker: vi.fn().mockResolvedValue({ claimToken, status: MediaOperationStatus.Rendering }),
    fail: vi.fn(),
    acknowledgeCancel: vi.fn(),
  };
  const media = { probe: vi.fn().mockResolvedValue({ format: { duration }, audioStreams: audio ? [{}] : [] }) };
  const storage = {
    mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
    unlinkDir: (path: string, options: Parameters<typeof rm>[1]) => rm(path, options),
  };
  const extractor = {
    extractAudio: vi.fn(async (_source: string, destination: string, _options?: unknown, _signal?: AbortSignal) => {
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, 'wav');
    }),
  };
  const ml = {
    transcriptionIdentity: vi.fn().mockResolvedValue(identity),
    transcribe: vi.fn().mockResolvedValue({ info: { ...identity, language: 'en' }, segments: [] }),
  };
  const destinations = { getById: vi.fn().mockResolvedValue({ kind: MlDestinationKind.Local }) };
  const websocket = { clientSend: vi.fn() };
  const service = new SpeechService(
    repository as never,
    operations as never,
    media as never,
    storage as never,
    extractor as never,
    ml as never,
    destinations as never,
    { setContext: vi.fn() } as never,
    websocket as never,
  );
  return { service, operation, claimToken, repository, operations, media, extractor, ml, websocket, destinations };
};
it.each(['persist', 'refresh'] as const)(
  'refuses stale-model search when a known new identity cannot %s',
  async (step) => {
    const f = await setup();
    const old = {
      enabled: true,
      generation: randomUUID(),
      destinationId: randomUUID(),
      modelFingerprint: 'a'.repeat(64),
    };
    const failure = new Error('Model invalidation transaction failed');
    const repository = Object.assign(f.repository, {
      settings: vi.fn().mockResolvedValue(old),
      setModel: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({ indexed: 1, pending: 0, failed: 0 }),
      search: vi.fn().mockResolvedValue({ items: ['old-model transcript'], total: 1 }),
    });
    if (step === 'persist') repository.setModel.mockRejectedValue(failure);
    else repository.settings.mockResolvedValueOnce(old).mockRejectedValue(failure);
    f.ml.transcriptionIdentity.mockResolvedValue({ model: 'whisper-small', fingerprint: 'b'.repeat(64) });
    await expect(f.service.search(factory.auth(), { query: 'hello', size: 25 })).rejects.toThrow(failure);
    expect(repository.setModel).toHaveBeenCalledWith(expect.any(String), old.generation, 'b'.repeat(64));
    expect(repository.search).not.toHaveBeenCalled();
  },
);
it('keeps live private search available when the worker identity is unavailable', async () => {
  const f = await setup();
  const repository = Object.assign(f.repository, {
    settings: vi
      .fn()
      .mockResolvedValue({ enabled: true, destinationId: randomUUID(), modelFingerprint: 'a'.repeat(64) }),
    setModel: vi.fn(),
    status: vi.fn().mockResolvedValue({ indexed: 1, pending: 0, failed: 0 }),
    search: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  });
  f.ml.transcriptionIdentity.mockRejectedValue(new ServiceUnavailableException());
  await expect(f.service.search(factory.auth(), { query: 'hello', size: 25 })).resolves.toMatchObject({ total: 0 });
  expect(repository.setModel).not.toHaveBeenCalled();
  expect(repository.search).toHaveBeenCalledOnce();
  // Search pages never pay for the library-wide status counts.
  expect(repository.status).not.toHaveBeenCalled();
});
it('completes no-audio and no-speech videos as empty without leaving temporary audio', async () => {
  for (const audio of [false, true]) {
    const f = await setup(audio);
    await f.service.run(f.operation, f.claimToken);
    expect(f.repository.publish).toHaveBeenCalledWith(f.operation, f.claimToken, 'whisper-small', audio ? 'en' : null);
    expect(f.ml.transcribe).toHaveBeenCalledTimes(audio ? 1 : 0);
    expect(await readdir(join(speechFolder(f.operation.ownerId), f.operation.id))).toEqual([]);
    expect(f.operations.fail).not.toHaveBeenCalled();
  }
});
it('resumes completed chunks and retains original media timestamps', async () => {
  const f = await setup(true, 601);
  f.repository.checkpoint.mockResolvedValue({ nextChunk: 1, language: 'en' });
  f.ml.transcribe.mockResolvedValue({
    info: { model: 'whisper-small', fingerprint: 'a'.repeat(64), language: 'en' },
    segments: [{ text: 'hello', words: [{ text: 'hello', start: 2.1, end: 2.2 }] }],
  });
  await f.service.run(f.operation, f.claimToken);
  expect(f.extractor.extractAudio).toHaveBeenCalledTimes(2);
  expect(f.extractor.extractAudio.mock.calls[0][2]).toMatchObject({ startSeconds: '298', durationSeconds: '303' });
  expect(f.repository.saveChunk).toHaveBeenNthCalledWith(
    1,
    f.operation,
    f.claimToken,
    1,
    [{ text: 'hello', startMs: 300_100, endMs: 300_200 }],
    'whisper-small',
    'en',
  );
});
it('rechecks source authority after extraction and never sends revoked audio to the worker', async () => {
  const f = await setup();
  f.extractor.extractAudio.mockImplementation(() => {
    f.repository.source.mockResolvedValue(undefined);
    return Promise.resolve();
  });
  await f.service.run(f.operation, f.claimToken);
  expect(f.ml.transcribe).not.toHaveBeenCalled();
  expect(f.repository.publish).not.toHaveBeenCalled();
  expect(f.operations.fail).toHaveBeenCalledWith(
    f.operation.id,
    f.claimToken,
    expect.objectContaining({ errorCode: 'speech_failed' }),
  );
});
it('reports unavailable workers without paths, quotes, or automatic cloud fallback', async () => {
  const f = await setup();
  f.ml.transcriptionIdentity.mockRejectedValue(new TranscriptionUnavailableError('private-worker-url'));
  await f.service.run(f.operation, f.claimToken);
  expect(f.extractor.extractAudio).not.toHaveBeenCalled();
  expect(f.repository.publish).not.toHaveBeenCalled();
  expect(f.operations.fail).toHaveBeenCalledWith(f.operation.id, f.claimToken, {
    errorCode: 'speech_unavailable',
    error: 'Speech indexing could not finish. Check the worker and retry from Spoken words settings.',
  });
});

it('requeues a gracefully stopped claim without discarding its durable checkpoints', async () => {
  const f = await setup();
  const requeue = vi.fn().mockResolvedValue(true);
  Object.assign(f.operations, { requeue });
  let started!: () => void;
  const transcribing = new Promise<void>((resolve) => (started = resolve));
  f.ml.transcribe.mockImplementation(
    async (_selection: unknown, _path: unknown, _options: unknown, signal: AbortSignal) => {
      started();
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
      );
    },
  );
  const running = f.service.run(f.operation, f.claimToken);
  await transcribing;
  await f.service.onShutdown();
  await running;
  expect(requeue).toHaveBeenCalledWith(f.operation.id, f.claimToken, {
    delayMs: 0,
    returnAttempt: true,
    requireActiveClaim: true,
  });
  expect(f.operations.fail).not.toHaveBeenCalled();
  expect(f.repository.publish).not.toHaveBeenCalled();
});

it('allows current-generation disable after the selected destination was deleted', async () => {
  const f = await setup();
  f.destinations.getById.mockResolvedValue(undefined as never);
  const configure = vi.fn();
  Object.assign(f.repository, { configure });
  vi.spyOn(f.service, 'status').mockResolvedValue({ enabled: false } as never);
  const dto = {
    enabled: false,
    expectedGeneration: randomUUID(),
    destinationId: randomUUID(),
    scope: 'library' as const,
    albumIds: [],
  };
  await expect(f.service.configure({ user: { id: f.operation.ownerId } } as never, dto)).resolves.toMatchObject({
    enabled: false,
  });
  expect(configure).toHaveBeenCalledWith(f.operation.ownerId, dto);
});

it('defers unavailable accounts so they cannot monopolize the bounded scheduler page', async () => {
  const f = await setup();
  const first = { ownerId: randomUUID(), generation: randomUUID(), destinationId: randomUUID() };
  const second = {
    ownerId: randomUUID(),
    generation: randomUUID(),
    destinationId: randomUUID(),
    modelFingerprint: 'a'.repeat(64),
  };
  const defer = vi.fn(),
    reconcile = vi.fn();
  Object.assign(f.repository, {
    owners: vi.fn().mockResolvedValue([]),
    due: vi.fn().mockResolvedValue([first, second]),
    defer,
    reconcile,
    cleanup: vi.fn(),
  });
  Object.assign(f.operations, { claimNext: vi.fn().mockResolvedValue(undefined) });
  f.ml.transcriptionIdentity.mockRejectedValueOnce(new Error('offline'));
  await f.service.drain();
  expect(defer).toHaveBeenCalledWith(first.ownerId, first.generation);
  expect(reconcile).toHaveBeenCalledWith(second.ownerId);
});

it('requeues upstream worker capacity refusals without spending attempts or losing checkpoints', async () => {
  const f = await setup();
  const requeue = vi.fn().mockResolvedValue(true);
  Object.assign(f.operations, { requeue });
  f.repository.checkpoint.mockResolvedValue({ nextChunk: 0, language: 'en' } as never);
  f.ml.transcribe.mockRejectedValue(
    new ServiceUnavailableException('Machine learning worker is busy; try again shortly'),
  );
  await f.service.run(f.operation, f.claimToken);
  expect(requeue).toHaveBeenCalledWith(f.operation.id, f.claimToken, {
    delayMs: 5000,
    returnAttempt: true,
    requireActiveClaim: true,
  });
  expect(f.operations.fail).not.toHaveBeenCalled();
  expect(f.repository.publish).not.toHaveBeenCalled();
});

describe('AssetsChanged', () => {
  it('wakes the speech index of every owner in a bulk change, once each', async () => {
    const repository = { assetOwners: vi.fn().mockResolvedValue(['owner-a', 'owner-b']), wake: vi.fn() };
    const websocket = { clientSend: vi.fn() };
    const logger = { setContext: vi.fn() };
    const none = {} as never;
    const service = new SpeechService(
      repository as never,
      none,
      none,
      none,
      none,
      none,
      none,
      logger as never,
      websocket as never,
    );

    await service.onAssetsChanged({ assetIds: ['a1', 'a2', 'a3'] });

    expect(repository.assetOwners).toHaveBeenCalledWith(['a1', 'a2', 'a3']);
    expect(repository.wake.mock.calls).toEqual([['owner-a'], ['owner-b']]);
    expect(websocket.clientSend).toHaveBeenCalledWith('on_speech_index_change', 'owner-a');
  });
});
