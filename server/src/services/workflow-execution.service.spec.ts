import { CurrentPlugin } from '@extism/extism';
import { WorkflowTrigger } from '@immich/plugin-sdk';
import { createHash } from 'node:crypto';
import { Mocked, vitest } from 'vitest';
import { JobName, JobStatus, WorkflowResult, WorkflowRunErrorCode, WorkflowType } from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
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

  describe('runs', () => {
    const workflowId = newUuid();
    const assetId = newUuid();
    const ownerId = newUuid();
    const filterId = newUuid();
    const webhookId = newUuid();

    const method = (name: string, schema: Record<string, unknown> | null = null) => ({
      id: newUuid(),
      name,
      pluginName: 'immich-plugin-core',
      types: [WorkflowType.AssetV1],
      schema,
    });
    const webhookSchema = {
      type: 'object',
      properties: { url: { type: 'string' }, headerValue: { type: 'string' } },
      required: ['url'],
    };

    const runnableStep = (id: string, methodName: string, order: number, config: Record<string, unknown> = {}) => ({
      id,
      config,
      order,
      pluginId: newUuid(),
      pluginName: 'immich-plugin-core',
      pluginEnabled: true,
      methodName,
      types: [WorkflowType.AssetV1],
      hostFunctions: methodName === 'webhook',
      allowedHosts: methodName === 'webhook' ? ['hooks.example.test'] : [],
    });

    const setup = ({
      steps = [
        runnableStep(filterId, 'assetTypeFilter', 0),
        runnableStep(webhookId, 'webhook', 1, { url: 'https://hooks.example.test' }),
      ],
      definitionSteps,
      methods = [method('assetTypeFilter'), method('webhook', webhookSchema)],
      logging = true,
    }: {
      steps?: ReturnType<typeof runnableStep>[];
      definitionSteps?: Array<{ id: string; method: string; config: Record<string, unknown> | null; enabled: boolean }>;
      methods?: ReturnType<typeof method>[];
      logging?: boolean;
    } = {}) => {
      (sut as unknown as { getConfig: () => Promise<unknown> }).getConfig = vitest.fn().mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: false }, imageDescription: { enabled: false } },
      });
      const workflow = {
        id: workflowId,
        name: 'workflow',
        logging,
        trigger: WorkflowTrigger.AssetCreate,
        steps,
        definition: {
          version: 1,
          trigger: WorkflowTrigger.AssetCreate,
          extra: {},
          steps: (
            definitionSteps ??
            steps.map((step) => ({
              id: step.id,
              method: `immich-plugin-core#${step.methodName}`,
              config: step.config,
              enabled: true,
            }))
          ).map((step) => ({ ...step, extra: {} })),
        },
      };
      mocks.workflow.getForWorkflowRun.mockResolvedValue(workflow as never);
      mocks.plugin.getForValidation.mockResolvedValue(methods);
      mocks.workflow.isWorkflowEligible.mockResolvedValue(true);
      mocks.workflow.getForAssetV1.mockResolvedValue({ id: assetId, ownerId } as never);
      mocks.workflow.log.mockResolvedValue(newUuid());
      return workflow;
    };

    it('passes each workflow method allowedHosts through the Extism call context', async () => {
      setup();
      mocks.plugin.callMethod.mockResolvedValue({});

      await sut.handleAssetTrigger({ workflowId, assetId });

      expect(mocks.plugin.callMethod).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: 'webhook' }),
        expect.any(Object),
        { allowedHosts: ['hooks.example.test'] },
      );
    });

    it('logs a completed first attempt', async () => {
      setup();
      mocks.plugin.callMethod.mockResolvedValue({});

      await sut.handleAssetTrigger({ workflowId, assetId });

      expect(mocks.plugin.callMethod).toHaveBeenCalledTimes(2);
      expect(mocks.workflow.log).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId, result: WorkflowResult.Completed, attempt: 0, triggerDataId: assetId }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('refuses a definition whose method is not installed, without running any step', async () => {
      const unknownId = newUuid();
      setup({
        steps: [runnableStep(webhookId, 'webhook', 1, { url: 'https://hooks.example.test' })],
        definitionSteps: [
          { id: unknownId, method: 'third-party#onlyPortraits', config: { minimum: 3 }, enabled: true },
          {
            id: webhookId,
            method: 'immich-plugin-core#webhook',
            config: { url: 'https://hooks.example.test' },
            enabled: true,
          },
        ],
      });

      await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log).toHaveBeenCalledWith(
        expect.objectContaining({
          result: WorkflowResult.Error,
          errorCode: WorkflowRunErrorCode.Unsupported,
          error: expect.stringContaining('Step 1: this plugin method is unavailable'),
        }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('refuses to run the remaining steps when a plugin upgrade removed a runnable step', async () => {
      // the filter's runnable step was deleted with its method; the method now resolves again (reinstalled)
      setup({
        steps: [runnableStep(webhookId, 'webhook', 1, { url: 'https://hooks.example.test' })],
        definitionSteps: [
          { id: filterId, method: 'immich-plugin-core#assetTypeFilter', config: {}, enabled: true },
          {
            id: webhookId,
            method: 'immich-plugin-core#webhook',
            config: { url: 'https://hooks.example.test' },
            enabled: true,
          },
        ],
      });

      await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: WorkflowRunErrorCode.Unsupported }),
      );
    });

    it('refuses a step whose parameters no longer match the installed schema', async () => {
      setup({ steps: [runnableStep(webhookId, 'webhook', 0, {})] });

      await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log.mock.calls[0]![0].error).toContain('is required');
    });

    it('records a plugin failure without the stored credential and retries once from the failed step', async () => {
      setup({
        steps: [
          runnableStep(filterId, 'assetTypeFilter', 0),
          runnableStep(webhookId, 'webhook', 1, {
            url: 'https://hooks.example.test',
            headerValue: 'Bearer s3cret-token',
          }),
        ],
      });
      mocks.plugin.callMethod
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('401 from hooks.example.test for Bearer s3cret-token'));

      await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

      const [entry] = mocks.workflow.log.mock.calls[0]!;
      expect(entry).toMatchObject({
        result: WorkflowResult.Error,
        errorCode: WorkflowRunErrorCode.StepFailed,
        workflowStepId: webhookId,
        attempt: 0,
      });
      expect(entry.error).not.toContain('s3cret-token');
      expect(entry.error).toContain('[credential]');
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.WorkflowAssetTrigger,
        data: {
          workflowId,
          assetId,
          runId: entry.runId,
          attempt: 1,
          fromStepId: webhookId,
          definitionSha256: expect.stringMatching(/^[\da-f]{64}$/),
          executionId: expect.any(String),
        },
      });
    });

    it('keeps credentials held in a definition’s extra fields out of run history (FL-82)', async () => {
      const workflow = setup();
      (workflow.definition.steps[1] as { extra: Record<string, unknown> }).extra = {
        legacyAuth: { token: 'step-extra-token' },
      };
      (workflow.definition as { extra: Record<string, unknown> }).extra = { apiKey: 'workflow-extra-key' };
      mocks.plugin.callMethod
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('refused step-extra-token and workflow-extra-key'));

      await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

      const [entry] = mocks.workflow.log.mock.calls[0]!;
      expect(entry.error).toBe('refused [credential] and [credential]');
    });

    it('runs the automatic retry from the failed step and does not retry it again', async () => {
      setup();
      mocks.plugin.callMethod.mockResolvedValueOnce({}).mockRejectedValue(new Error('still failing'));
      await sut.handleAssetTrigger({ workflowId, assetId });
      const retryJob = mocks.job.queue.mock.calls[0]![0].data as Parameters<
        WorkflowExecutionService['handleAssetTrigger']
      >[0];
      mocks.plugin.callMethod.mockClear();
      mocks.job.queue.mockClear();

      await expect(sut.handleAssetTrigger(retryJob)).resolves.toBe(JobStatus.Failed);

      expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
      expect(mocks.plugin.callMethod).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: 'webhook' }),
        expect.any(Object),
        expect.any(Object),
      );
      expect(mocks.workflow.log).toHaveBeenCalledWith(expect.objectContaining({ runId: retryJob.runId, attempt: 1 }));
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('continues after an earlier step saved its own config before the next step failed', async () => {
      const workflow = setup();
      const resolvedConfig = { albumId: newUuid(), allowedTypes: ['IMAGE'] };
      mocks.workflow.updateStepConfig.mockImplementation((_workflowId, stepId, config) => {
        expect(stepId).toBe(filterId);
        // A jsonb read can return object keys in a different order than the plugin response.
        const persisted = { allowedTypes: config.allowedTypes, albumId: config.albumId };
        workflow.definition.steps[0]!.config = persisted;
        workflow.steps[0]!.config = persisted;
        return Promise.resolve();
      });
      mocks.plugin.callMethod
        .mockResolvedValueOnce({ config: resolvedConfig })
        .mockRejectedValueOnce(new Error('webhook failed'));

      await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);
      const retryJob = mocks.job.queue.mock.calls[0]![0].data as Parameters<
        WorkflowExecutionService['handleAssetTrigger']
      >[0];
      expect(retryJob.definitionSha256).toMatch(/^[\da-f]{64}$/);

      mocks.plugin.callMethod.mockClear().mockResolvedValue({});
      await expect(sut.handleAssetTrigger(retryJob)).resolves.toBeUndefined();
      expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
      expect(mocks.plugin.callMethod).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: 'webhook' }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('still refuses an owner edit after a step saved its own config', async () => {
      const workflow = setup();
      mocks.workflow.updateStepConfig.mockImplementation((_workflowId, _stepId, config) => {
        workflow.definition.steps[0]!.config = config;
        workflow.steps[0]!.config = config;
        return Promise.resolve();
      });
      mocks.plugin.callMethod
        .mockResolvedValueOnce({ config: { allowedTypes: ['IMAGE'] } })
        .mockRejectedValueOnce(new Error('webhook failed'));

      await sut.handleAssetTrigger({ workflowId, assetId });
      const retryJob = mocks.job.queue.mock.calls[0]![0].data as Parameters<
        WorkflowExecutionService['handleAssetTrigger']
      >[0];
      const insertedId = newUuid();
      workflow.steps.unshift(runnableStep(insertedId, 'assetTypeFilter', 0, { allowedTypes: ['VIDEO'] }));
      workflow.definition.steps.unshift({
        id: insertedId,
        method: 'immich-plugin-core#assetTypeFilter',
        config: { allowedTypes: ['VIDEO'] },
        enabled: true,
        extra: {},
      });
      mocks.plugin.callMethod.mockClear();

      await expect(sut.handleAssetTrigger(retryJob)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, errorCode: WorkflowRunErrorCode.Unsupported }),
      );
    });

    it('refuses to continue after a new restrictive filter is inserted ahead of the failed step', async () => {
      const workflow = setup();
      mocks.plugin.callMethod.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('webhook failed'));
      await sut.handleAssetTrigger({ workflowId, assetId });
      const retryJob = mocks.job.queue.mock.calls[0]![0].data as Parameters<
        WorkflowExecutionService['handleAssetTrigger']
      >[0];
      mocks.plugin.callMethod.mockClear();

      const insertedId = newUuid();
      workflow.steps.unshift(runnableStep(insertedId, 'assetTypeFilter', 0, { allowedTypes: ['IMAGE'] }));
      workflow.definition.steps.unshift({
        id: insertedId,
        method: 'immich-plugin-core#assetTypeFilter',
        config: { allowedTypes: ['IMAGE'] },
        enabled: true,
        extra: {},
      });
      await expect(sut.handleAssetTrigger(retryJob)).resolves.toBe(JobStatus.Skipped);

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          errorCode: WorkflowRunErrorCode.Unsupported,
          error: expect.stringContaining('changed'),
        }),
      );
    });

    it('refuses to continue when a retained step id has edited filter parameters', async () => {
      const workflow = setup();
      mocks.plugin.callMethod.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('webhook failed'));
      await sut.handleAssetTrigger({ workflowId, assetId });
      const retryJob = mocks.job.queue.mock.calls[0]![0].data as Parameters<
        WorkflowExecutionService['handleAssetTrigger']
      >[0];
      mocks.plugin.callMethod.mockClear();

      workflow.definition.steps[0]!.config = { allowedTypes: ['VIDEO'] };
      await expect(sut.handleAssetTrigger(retryJob)).resolves.toBe(JobStatus.Skipped);
      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
    });

    it('never retries a manual retry automatically', async () => {
      setup();
      mocks.plugin.callMethod.mockRejectedValue(new Error('failing'));

      await sut.handleAssetTrigger({ workflowId, assetId, runId: newUuid(), attempt: 2, manual: true });

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('does not run a retry whose failed step was edited away', async () => {
      setup();
      mocks.plugin.callMethod.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('webhook failed'));
      await sut.handleAssetTrigger({ workflowId, assetId });
      const retryJob = mocks.job.queue.mock.calls[0]![0].data as Parameters<
        WorkflowExecutionService['handleAssetTrigger']
      >[0];
      mocks.plugin.callMethod.mockClear();

      await expect(sut.handleAssetTrigger({ ...retryJob, fromStepId: newUuid() })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
    });

    it('refuses an older continuation job without a definition fingerprint', async () => {
      setup();

      await expect(
        sut.handleAssetTrigger({ workflowId, assetId, runId: newUuid(), attempt: 1, fromStepId: webhookId }),
      ).resolves.toBe(JobStatus.Skipped);

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: WorkflowRunErrorCode.Unsupported }),
      );
    });

    it('treats a paused or deleted workflow as a cancelled run', async () => {
      setup();
      mocks.workflow.getForWorkflowRun.mockResolvedValue(undefined);

      await expect(
        sut.handleAssetTrigger({ workflowId, assetId, runId: newUuid(), attempt: 1 }),
      ).resolves.toBeUndefined();

      expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      expect(mocks.workflow.log).not.toHaveBeenCalled();
    });

    it('keeps what a plugin stores in its step in the definition too', async () => {
      setup();
      mocks.plugin.callMethod
        .mockResolvedValueOnce({ config: { allowedTypes: ['IMAGE'], seen: 1 } })
        .mockResolvedValue({});

      await sut.handleAssetTrigger({ workflowId, assetId });

      expect(mocks.workflow.updateStepConfig).toHaveBeenCalledWith(workflowId, filterId, {
        allowedTypes: ['IMAGE'],
        seen: 1,
      });
    });

    describe('a step whose changes were written (FL-169)', () => {
      it('resumes after the step, not at it, when reading the changes back fails', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({ changes: { asset: { isFavorite: true } } });
        // the first read loads the trigger data; the read after the write fails
        mocks.workflow.getForAssetV1
          .mockResolvedValueOnce({ id: assetId, ownerId } as never)
          .mockRejectedValueOnce(new Error('database unavailable'));
        const update = vitest.spyOn(AssetService.prototype, 'update').mockResolvedValue({} as never);

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(update).toHaveBeenCalledOnce();
        expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
        expect(mocks.workflow.log).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: WorkflowRunErrorCode.StepFailed, workflowStepId: filterId }),
        );
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.WorkflowAssetTrigger,
          data: expect.objectContaining({ attempt: 1, fromStepId: webhookId }),
        });
      });

      it('resumes after the step when saving its own config fails', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({ config: { allowedTypes: ['IMAGE'] } });
        mocks.workflow.updateStepConfig.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.WorkflowAssetTrigger,
          data: expect.objectContaining({ attempt: 1, fromStepId: webhookId }),
        });
      });

      it('queues no retry when the last step fails after its changes were written', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({}).mockResolvedValueOnce({ config: { url: 'https://x.test' } });
        mocks.workflow.updateStepConfig.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(mocks.plugin.callMethod).toHaveBeenCalledTimes(2);
        expect(mocks.workflow.log).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: WorkflowRunErrorCode.StepFailed, workflowStepId: webhookId }),
        );
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('queues no retry when a halting step fails after its changes were written', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({ config: { seen: 1 }, workflow: { continue: false } });
        mocks.workflow.updateStepConfig.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('still runs a step again when writing its changes failed', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({ changes: { asset: { isFavorite: true } } });
        vitest.spyOn(AssetService.prototype, 'update').mockRejectedValue(new Error('update refused'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.WorkflowAssetTrigger,
          data: expect.objectContaining({ attempt: 1, fromStepId: filterId }),
        });
      });
    });

    describe('after its steps ran (FL-169)', () => {
      it('does not fail the job when the completed result cannot be saved', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValue({});
        mocks.workflow.log.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBeUndefined();

        expect(mocks.plugin.callMethod).toHaveBeenCalledTimes(2);
        expect(mocks.workflow.log).toHaveBeenCalledWith(expect.objectContaining({ result: WorkflowResult.Completed }));
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('does not fail the job or retry a halting step when the halt cannot be saved', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({ workflow: { continue: false } });
        mocks.workflow.log.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBeUndefined();

        expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
        expect(mocks.workflow.log).toHaveBeenCalledOnce();
        expect(mocks.workflow.log).toHaveBeenCalledWith(
          expect.objectContaining({ result: WorkflowResult.Halted, workflowStepId: filterId }),
        );
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('still queues the retry from the failed step when the step error cannot be saved', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('webhook failed'));
        mocks.workflow.log.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(mocks.job.queue).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ attempt: 1, fromStepId: webhookId }) }),
        );
      });

      it('reports a failed step without throwing when its automatic retry cannot be queued', async () => {
        setup();
        mocks.plugin.callMethod.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('webhook failed'));
        mocks.job.queue.mockRejectedValue(new Error('redis unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).resolves.toBe(JobStatus.Failed);

        expect(mocks.plugin.callMethod).toHaveBeenCalledTimes(2);
        expect(mocks.workflow.log).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: WorkflowRunErrorCode.StepFailed, workflowStepId: webhookId }),
        );
      });

      it('still fails the job when run history cannot be saved before any step ran', async () => {
        setup({ steps: [runnableStep(webhookId, 'webhook', 0, {})] });
        mocks.workflow.log.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetTrigger({ workflowId, assetId })).rejects.toThrow('database unavailable');

        expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
      });
    });

    describe('a stalled job replayed with the same data (FL-179)', () => {
      const runId = newUuid();
      const executionId = newUuid();

      it('records each step it completes under the job’s execution id', async () => {
        setup();
        mocks.workflow.getCompletedSteps.mockResolvedValue(new Map());
        mocks.workflow.completeStep.mockResolvedValue();
        mocks.plugin.callMethod.mockResolvedValue({});

        await expect(sut.handleAssetTrigger({ workflowId, assetId, runId, executionId })).resolves.toBeUndefined();

        expect(mocks.workflow.getCompletedSteps).toHaveBeenCalledWith(executionId);
        expect(mocks.workflow.completeStep.mock.calls).toEqual([
          [{ executionId, workflowId, stepId: filterId, halted: false }],
          [{ executionId, workflowId, stepId: webhookId, halted: false }],
        ]);
        // recorded before the next step starts
        expect(mocks.workflow.completeStep.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.plugin.callMethod.mock.invocationCallOrder[1],
        );
      });

      it('skips the steps an earlier run of the job completed', async () => {
        setup();
        mocks.workflow.getCompletedSteps.mockResolvedValue(new Map([[filterId, { halted: false }]]));
        mocks.workflow.completeStep.mockResolvedValue();
        mocks.plugin.callMethod.mockResolvedValue({});

        await expect(sut.handleAssetTrigger({ workflowId, assetId, runId, executionId })).resolves.toBeUndefined();

        expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
        expect(mocks.plugin.callMethod).toHaveBeenCalledWith(
          expect.objectContaining({ methodName: 'webhook' }),
          expect.any(Object),
          expect.any(Object),
        );
        expect(mocks.workflow.log).toHaveBeenCalledWith(
          expect.objectContaining({ result: WorkflowResult.Completed, runId, attempt: 0 }),
        );
      });

      it('stops where a completed step stopped the run', async () => {
        setup();
        mocks.workflow.getCompletedSteps.mockResolvedValue(new Map([[filterId, { halted: true }]]));

        await expect(sut.handleAssetTrigger({ workflowId, assetId, runId, executionId })).resolves.toBeUndefined();

        expect(mocks.plugin.callMethod).not.toHaveBeenCalled();
        expect(mocks.workflow.log).toHaveBeenCalledWith(
          expect.objectContaining({ result: WorkflowResult.Halted, workflowStepId: filterId }),
        );
      });

      it('records a halting step as halted', async () => {
        setup();
        mocks.workflow.getCompletedSteps.mockResolvedValue(new Map());
        mocks.workflow.completeStep.mockResolvedValue();
        mocks.plugin.callMethod.mockResolvedValueOnce({ workflow: { continue: false } });

        await sut.handleAssetTrigger({ workflowId, assetId, runId, executionId });

        expect(mocks.workflow.completeStep).toHaveBeenCalledExactlyOnceWith({
          executionId,
          workflowId,
          stepId: filterId,
          halted: true,
        });
      });

      it('resumes after a step whose completion could not be recorded, in a job of its own', async () => {
        setup();
        mocks.workflow.getCompletedSteps.mockResolvedValue(new Map());
        mocks.workflow.completeStep.mockRejectedValue(new Error('database unavailable'));
        mocks.plugin.callMethod.mockResolvedValue({});

        await expect(sut.handleAssetTrigger({ workflowId, assetId, runId, executionId })).resolves.toBe(
          JobStatus.Failed,
        );

        expect(mocks.plugin.callMethod).toHaveBeenCalledOnce();
        const [retry] = mocks.job.queue.mock.calls[0]!;
        expect(retry).toMatchObject({
          name: JobName.WorkflowAssetTrigger,
          data: { runId, attempt: 1, fromStepId: webhookId, executionId: expect.any(String) },
        });
        expect((retry as unknown as { data: { executionId: string } }).data.executionId).not.toBe(executionId);
      });

      it('queues every new run with its own run and execution ids', async () => {
        const userId = newUuid();
        mocks.workflow.search.mockResolvedValue([{ id: workflowId }, { id: newUuid() }] as never);

        await sut.onAssetTagged({ userId, assetId });

        const [jobs] = mocks.job.queueAll.mock.calls[0]!;
        const data = jobs.map((job) => (job as unknown as { data: { runId: string; executionId: string } }).data);
        expect(data).toEqual([
          expect.objectContaining({ workflowId, assetId, runId: expect.any(String), executionId: expect.any(String) }),
          expect.objectContaining({ assetId, runId: expect.any(String), executionId: expect.any(String) }),
        ]);
        expect(new Set(data.map(({ executionId }) => executionId)).size).toBe(2);
      });

      it('forgets completed steps a week old in the nightly cleanup, deferring a failure', async () => {
        mocks.workflow.deleteCompletedStepsBefore.mockResolvedValueOnce(3);

        await sut.onNightlyDatabaseCleanup();

        const [before] = mocks.workflow.deleteCompletedStepsBefore.mock.calls[0]!;
        expect(Date.now() - before.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
        expect(Date.now() - before.getTime()).toBeLessThan(8 * 24 * 60 * 60 * 1000);

        mocks.workflow.deleteCompletedStepsBefore.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(sut.onNightlyDatabaseCleanup()).resolves.toBeUndefined();
      });
    });

    it('does not log when run history is off, but still retries', async () => {
      setup({ logging: false });
      mocks.plugin.callMethod.mockRejectedValue(new Error('failing'));

      await sut.handleAssetTrigger({ workflowId, assetId });

      expect(mocks.workflow.log).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledOnce();
    });
  });

  it('only queues runs for enabled workflows', async () => {
    const userId = newUuid();
    const assetId = newUuid();
    mocks.workflow.search.mockResolvedValue([]);

    await sut.onAssetTagged({ userId, assetId } as never);

    expect(mocks.workflow.search).toHaveBeenCalledWith({ userId, trigger: WorkflowTrigger.AssetTagged, enabled: true });
  });
});
