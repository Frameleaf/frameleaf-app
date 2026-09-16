import { CurrentPlugin } from '@extism/extism';
import { WorkflowTrigger } from '@immich/plugin-sdk';
import { createHash } from 'node:crypto';
import { Mocked, vitest } from 'vitest';
import { WorkflowType } from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(WorkflowExecutionService.name, () => {
  let sut: WorkflowExecutionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(WorkflowExecutionService));
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  const request = async (allowedHosts: string[], url: string, options = {}) => {
    mocks.crypto.verifyJwt.mockReturnValue({ userId: newUuid() });
    mocks.plugin.getForLoad.mockResolvedValue([
      {
        id: newUuid(),
        name: 'test-plugin',
        version: '1.0.0',
        wasmBytes: Buffer.from('test'),
        methods: [{ name: 'webhook', hostFunctions: true }],
      },
    ]);
    await sut.onPluginLoad();
    const functions = mocks.plugin.load.mock.calls[0]![1].functions!;
    const store = vitest.fn().mockReturnValue(1n);
    const plugin = {
      hostContext: () => ({ allowedHosts }),
      read: () => ({ json: () => ({ authToken: 'token', args: [url, options] }) }),
      store,
    } as unknown as CurrentPlugin;
    await functions.httpRequest!(plugin, 0n);
    return JSON.parse(store.mock.calls.at(-1)![0]);
  };

  it('reimports changed WASM with an unchanged manifest and skips identical content', async () => {
    const manifest = Buffer.from(
      JSON.stringify({
        name: 'test-plugin',
        version: '1.0.0',
        title: 'Test',
        description: 'Test',
        author: 'Test',
        wasmPath: 'plugin.wasm',
      }),
    );
    let wasm = Buffer.from('first wasm');
    let persistedHash: Buffer | undefined;
    mocks.config.getEnv.mockReturnValue(mockEnvData({}));
    mocks.database.withLock.mockImplementation(async (_lock, callback) => callback());
    mocks.storage.readFile.mockImplementation((path) =>
      Promise.resolve(path.endsWith('manifest.json') ? manifest : wasm),
    );
    mocks.crypto.hashSha256.mockImplementation((value) => createHash('sha256').update(value).digest());
    mocks.plugin.getByHash.mockImplementation((hash) =>
      Promise.resolve(
        hash.equals(persistedHash ?? Buffer.alloc(0))
          ? {
              id: newUuid(),
              name: 'test-plugin',
              version: '1.0.0',
              title: 'Test',
              description: 'Test',
              author: 'Test',
              createdAt: new Date(),
              updatedAt: new Date(),
              methods: [],
              templates: [],
            }
          : undefined,
      ),
    );
    mocks.plugin.getByName.mockResolvedValue(undefined);
    mocks.plugin.upsert.mockImplementation((dto) => {
      persistedHash = dto.sha256hash as Buffer;
      return Promise.resolve({ id: newUuid(), name: dto.name, methods: [] });
    });

    await sut.onPluginSync();
    await sut.onPluginSync();
    expect(mocks.plugin.upsert).toHaveBeenCalledOnce();
    wasm = Buffer.from('updated wasm');
    await sut.onPluginSync();
    expect(mocks.plugin.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.plugin.upsert.mock.calls[1]![0].wasmBytes).toEqual(wasm);
  });

  describe('plugin HTTP permissions', () => {
    it.each(['https://trusted.example.attacker.test', 'https://nottrusted.example'])(
      'rejects partial hostname matches: %s',
      async (url) => {
        const fetchMock = vitest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected'));
        expect(await request(['trusted.example'], url)).toMatchObject({ success: false });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('permits wildcard subdomains and matches hostnames case-insensitively', async () => {
      const fetchMock = vitest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      expect(await request(['*.TRUSTED.EXAMPLE'], 'https://hooks.trusted.example')).toMatchObject({
        success: true,
        response: { status: 200, body: 'ok' },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('checks redirect destinations before making another request', async () => {
      const fetchMock = vitest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://private.test/secret' } }));
      expect(await request(['trusted.example'], 'https://trusted.example')).toMatchObject({ success: false });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    });

    it('preserves the method, body, and credentials on a same-origin 307 redirect', async () => {
      const fetchMock = vitest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/done' } }))
        .mockResolvedValueOnce(new Response('done'));
      expect(
        await request(['trusted.example'], 'https://trusted.example/start', {
          method: 'POST',
          body: 'payload',
          headers: { Authorization: 'secret' },
        }),
      ).toMatchObject({ success: true });
      const [url, options] = fetchMock.mock.calls[1]!;
      expect(url).toBe('https://trusted.example/done');
      expect(options).toMatchObject({ method: 'POST', body: 'payload' });
      expect(new Headers(options?.headers).get('Authorization')).toBe('secret');
    });

    it('stops redirect loops', async () => {
      const fetchMock = vitest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 302, headers: { location: '/loop' } }));
      expect(await request(['trusted.example'], 'https://trusted.example/loop')).toMatchObject({ success: false });
      expect(fetchMock).toHaveBeenCalledTimes(21);
    });

    it('follows allowed redirects without forwarding credentials across origins', async () => {
      const fetchMock = vitest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example/done' } }))
        .mockResolvedValueOnce(new Response('done'));
      expect(
        await request(['*.example'], 'https://hooks.example', {
          method: 'POST',
          body: 'payload',
          headers: { Authorization: 'secret', 'Content-Type': 'text/plain' },
        }),
      ).toMatchObject({ success: true, response: { status: 200, body: 'done' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const options = fetchMock.mock.calls[1]![1]!;
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
      expect(new Headers(options.headers).has('Authorization')).toBe(false);
    });
  });

  it('loads preserved official v3 plugin bytes with the official host ABI in both execution modes', async () => {
    const pluginId = newUuid();
    const officialV3Wasm = Buffer.from('preserved-official-v3.0.3-wasm');
    mocks.plugin.getForLoad.mockResolvedValue([
      {
        id: pluginId,
        name: 'immich-plugin-core',
        version: '2.0.1',
        wasmBytes: officialV3Wasm,
        methods: [
          { name: 'assetFavorite', hostFunctions: false },
          { name: 'webhook', hostFunctions: true },
        ],
      },
    ]);

    await sut.onPluginLoad();

    expect(mocks.plugin.load).toHaveBeenCalledTimes(2);
    for (const [load] of mocks.plugin.load.mock.calls) {
      expect(load.wasmBytes).toBe(officialV3Wasm);
    }

    const [, inProcessOptions] = mocks.plugin.load.mock.calls[0]!;
    const [, workerOptions] = mocks.plugin.load.mock.calls[1]!;
    const officialHostAbi = [
      'addAssetsToAlbum',
      'addAssetsToAlbums',
      'bulkTagAssets',
      'createAlbum',
      'httpRequest',
      'searchAlbums',
    ];
    // albumAddAssets is a fork-legacy alias the un-ported plugin-core wasm still imports.
    // Official plugins only import from the official set, so the superset preserves the ABI.
    const hostFunctions = [...officialHostAbi, 'albumAddAssets'].toSorted();

    expect(inProcessOptions.runInWorker).toBe(false);
    expect(Object.keys(inProcessOptions.functions ?? {}).toSorted()).toEqual(hostFunctions);
    expect(workerOptions.runInWorker).toBe(true);
    expect(Object.keys(workerOptions.functions ?? {}).toSorted()).toEqual(hostFunctions);
  });

  it('preserves the fork privacy auth gate for official host functions', async () => {
    const userId = newUuid();
    const albumId = newUuid();
    const assetId = newUuid();
    const addAssets = vitest.spyOn(AlbumService.prototype, 'addAssets').mockResolvedValue([]);
    mocks.crypto.verifyJwt.mockReturnValue({ userId });
    mocks.plugin.getForLoad.mockResolvedValue([
      {
        id: newUuid(),
        name: 'immich-plugin-core',
        version: '2.0.1',
        wasmBytes: Buffer.from('preserved-official-v3.0.3-wasm'),
        methods: [{ name: 'assetAddToAlbums', hostFunctions: true }],
      },
    ]);

    await sut.onPluginLoad();

    const [, workerOptions] = mocks.plugin.load.mock.calls[0]!;
    const functions = workerOptions.functions as Record<
      string,
      (plugin: CurrentPlugin, offset: bigint) => Promise<bigint>
    >;
    const plugin = {
      hostContext: vitest.fn().mockReturnValue({ allowedHosts: [] }),
      read: vitest.fn().mockReturnValue({
        json: () => ({ authToken: 'official-workflow-token', args: [albumId, { ids: [assetId] }] }),
      }),
      store: vitest.fn().mockReturnValue(1n),
    } as unknown as Mocked<CurrentPlugin>;

    await functions.addAssetsToAlbum!(plugin, 0n);

    expect(addAssets).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: userId }, hideNsfwAssets: true }),
      albumId,
      { ids: [assetId] },
    );
    expect(plugin.hostContext).toHaveBeenCalled();
  });

  it('passes each workflow method allowedHosts through the Extism call context', async () => {
    const workflowId = newUuid();
    const assetId = newUuid();
    const ownerId = newUuid();
    const allowedHosts = ['hooks.example.test', '*.trusted.example'];
    (sut as unknown as { getConfig: () => Promise<unknown> }).getConfig = vitest.fn().mockResolvedValue({
      machineLearning: { nsfwDetection: { enabled: false }, imageDescription: { enabled: false } },
    });
    mocks.workflow.getForWorkflowRun.mockResolvedValue({
      id: workflowId,
      name: 'webhook workflow',
      logging: false,
      trigger: WorkflowTrigger.AssetCreate,
      steps: [
        {
          id: newUuid(),
          config: {},
          pluginId: newUuid(),
          methodName: 'webhook',
          types: [WorkflowType.AssetV1],
          hostFunctions: true,
          allowedHosts,
        },
      ],
    });
    mocks.workflow.isWorkflowEligible.mockResolvedValue(true);
    mocks.workflow.getForAssetV1.mockResolvedValue({ id: assetId, ownerId } as never);
    mocks.plugin.callMethod.mockResolvedValue({});

    await sut.handleAssetTrigger({ workflowId, assetId });

    expect(mocks.plugin.callMethod).toHaveBeenCalledWith(
      expect.objectContaining({ methodName: 'webhook' }),
      expect.any(Object),
      { allowedHosts },
    );
  });
});
