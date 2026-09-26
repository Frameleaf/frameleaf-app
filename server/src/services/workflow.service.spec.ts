import { WorkflowTrigger } from '@immich/plugin-sdk';
import { BadRequestException } from '@nestjs/common';
import { JobName, WorkflowIssueCode, WorkflowType } from 'src/enum.js';
import { WorkflowService } from 'src/services/workflow.service.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const webhookSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', title: 'URL' },
    headerName: { type: 'string' },
    headerValue: { type: 'string' },
  },
  required: ['url'],
};

const methods = [
  {
    id: newUuid(),
    name: 'assetTypeFilter',
    pluginName: 'immich-plugin-core',
    types: [WorkflowType.AssetV1],
    schema: null,
  },
  {
    id: newUuid(),
    name: 'webhook',
    pluginName: 'immich-plugin-core',
    types: [WorkflowType.AssetV1],
    schema: webhookSchema,
  },
];

describe(WorkflowService.name, () => {
  let sut: WorkflowService;
  let mocks: ServiceMocks;
  const auth = factory.auth();
  const workflowId = newUuid();

  /** The repository echoes what it stores, as the database would. */
  const stored = (overrides: Record<string, unknown> = {}) => ({
    id: workflowId,
    name: 'Receipts',
    description: null,
    trigger: WorkflowTrigger.AssetCreate,
    enabled: false,
    logging: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    steps: [],
    definition: null,
    ...overrides,
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(WorkflowService));
    mocks.plugin.getForValidation.mockResolvedValue(methods as never);
    mocks.access.workflow.checkOwnerAccess.mockResolvedValue(new Set([workflowId]));
    mocks.workflow.create.mockImplementation((dto, definition) =>
      Promise.resolve(stored({ ...dto, definition }) as never),
    );
    mocks.workflow.update.mockImplementation((_id, dto, replacement) =>
      Promise.resolve(stored({ ...dto, ...(replacement && { definition: replacement.definition }) }) as never),
    );
  });

  describe('import and export', () => {
    const imported = {
      trigger: WorkflowTrigger.AssetCreate,
      name: 'Imported',
      enabled: false,
      extra: { source: 'another-server', legacyDefinition: { trigger: 'Asset upload' } },
      steps: [
        { method: 'immich-plugin-core#assetTypeFilter', config: { allowedTypes: ['IMAGE'], futureOption: true } },
        { method: 'third-party#faceCount', config: { minimum: 2 }, enabled: false, extra: { note: 'keep me' } },
      ],
    };

    it('stores unknown methods, parameters and fields paused, and runs only installed steps', async () => {
      const response = await sut.create(auth, imported);

      const [dto, definition, runnable] = mocks.workflow.create.mock.calls[0]!;
      expect(dto).toMatchObject({ enabled: false, trigger: WorkflowTrigger.AssetCreate, ownerId: auth.user.id });
      expect(definition.extra).toEqual(imported.extra);
      expect(
        definition.steps.map(({ method, config, enabled, extra }) => ({ method, config, enabled, extra })),
      ).toEqual([
        {
          method: 'immich-plugin-core#assetTypeFilter',
          config: { allowedTypes: ['IMAGE'], futureOption: true },
          enabled: true,
          extra: {},
        },
        { method: 'third-party#faceCount', config: { minimum: 2 }, enabled: false, extra: { note: 'keep me' } },
      ]);
      expect(runnable).toEqual([
        expect.objectContaining({ id: definition.steps[0]!.id, order: 0, pluginMethodId: methods[0]!.id }),
      ]);
      expect(response.issues).toEqual([
        expect.objectContaining({ step: 1, code: WorkflowIssueCode.MethodUnavailable }),
      ]);
    });

    it('round-trips an export into an identical definition', async () => {
      const created = await sut.create(auth, imported);
      mocks.workflow.get.mockResolvedValue(
        stored({ name: created.name, definition: mocks.workflow.create.mock.calls[0]![1] }) as never,
      );

      const exported = await sut.share(auth, workflowId);
      await sut.create(auth, { ...exported, enabled: false });

      const first = mocks.workflow.create.mock.calls[0]![1];
      const second = mocks.workflow.create.mock.calls[1]![1];
      const withoutIds = (definition: typeof first) => ({
        ...definition,
        steps: definition.steps.map(({ id: _, ...step }) => step),
      });
      expect(withoutIds(second)).toEqual(withoutIds(first));
    });

    it('refuses to enable an unsupported definition and stores nothing', async () => {
      await expect(sut.create(auth, { ...imported, enabled: true })).rejects.toThrow(
        /Pause this workflow before saving. Step 2: this plugin method is unavailable/,
      );
      expect(mocks.workflow.create).not.toHaveBeenCalled();
    });

    it('keeps an unavailable trigger in the definition without inventing one', async () => {
      const response = await sut.create(auth, { trigger: 'Schedule', enabled: false, steps: [] });

      const [dto, definition] = mocks.workflow.create.mock.calls[0]!;
      expect(dto.trigger).toBe(WorkflowTrigger.AssetCreate);
      expect(definition.trigger).toBe('Schedule');
      expect(response.trigger).toBe('Schedule');
      expect(response.issues).toEqual([expect.objectContaining({ code: WorkflowIssueCode.TriggerUnavailable })]);
      expect(sut.getTriggers().map(({ trigger }) => trigger)).not.toContain('Schedule');
    });

    it('refuses definitions that are not ordinary JSON or too large', async () => {
      await expect(
        sut.create(auth, {
          trigger: WorkflowTrigger.AssetCreate,
          enabled: false,
          steps: [{ method: 'immich-plugin-core#assetTypeFilter', config: { value: 'x'.repeat(300_000) } }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('enabling', () => {
    it('refuses a step whose parameters do not match the installed schema', async () => {
      await expect(
        sut.create(auth, {
          trigger: WorkflowTrigger.AssetCreate,
          enabled: true,
          steps: [{ method: 'immich-plugin-core#webhook', config: {} }],
        }),
      ).rejects.toThrow(/URL is required/);
    });

    it('refuses to enable a stored workflow that can no longer run, without changing it', async () => {
      mocks.workflow.get.mockResolvedValue(
        stored({
          definition: {
            version: 1,
            trigger: WorkflowTrigger.AssetCreate,
            extra: {},
            steps: [{ id: newUuid(), method: 'removed-plugin#method', config: {}, enabled: true, extra: {} }],
          },
        }) as never,
      );

      await expect(sut.update(auth, workflowId, { enabled: true })).rejects.toThrow(/unavailable/);
      expect(mocks.workflow.update).not.toHaveBeenCalled();
    });

    it('pauses without re-evaluating or rewriting the definition', async () => {
      mocks.workflow.get.mockResolvedValue(stored({ enabled: true }) as never);

      await sut.update(auth, workflowId, { enabled: false });

      expect(mocks.workflow.update).toHaveBeenCalledWith(workflowId, { enabled: false }, undefined);
    });
  });

  describe('credentials', () => {
    const stepId = newUuid();
    const secretDefinition = {
      version: 1 as const,
      trigger: WorkflowTrigger.AssetCreate,
      extra: {},
      steps: [
        {
          id: stepId,
          method: 'immich-plugin-core#webhook',
          config: { url: 'https://hooks.example.test', headerName: 'Authorization', headerValue: 'Bearer s3cret' },
          enabled: true,
          extra: {},
        },
      ],
    };

    beforeEach(() => {
      mocks.workflow.get.mockResolvedValue(stored({ definition: secretDefinition }) as never);
    });

    it('never returns a stored credential, and says where one is kept', async () => {
      const response = await sut.get(auth, workflowId);

      expect(response.steps[0]).toMatchObject({
        id: stepId,
        config: { url: 'https://hooks.example.test', headerName: 'Authorization' },
        storedSecrets: ['headerValue'],
      });
      expect(JSON.stringify(response)).not.toContain('s3cret');
      expect(JSON.stringify(await sut.share(auth, workflowId))).not.toContain('s3cret');
    });

    describe('in additional fields', () => {
      const withExtraSecrets = {
        ...secretDefinition,
        extra: { integration: { apiKey: 'workflow-key-1', region: 'eu' } },
        steps: [{ ...secretDefinition.steps[0], extra: { remote: { token: 'step-token-1', label: 'hook' } } }],
      };

      beforeEach(() => {
        mocks.workflow.get.mockResolvedValue(stored({ definition: withExtraSecrets }) as never);
      });

      it('never returns a credential-shaped value kept in extra', async () => {
        const response = await sut.get(auth, workflowId);
        const shared = await sut.share(auth, workflowId);
        mocks.workflow.search.mockResolvedValue([stored({ definition: withExtraSecrets })] as never);
        const listed = await sut.search(auth, {});

        expect(response.extra).toEqual({ integration: { region: 'eu' } });
        expect(response.steps[0]!.extra).toEqual({ remote: { label: 'hook' } });
        for (const body of [response, shared, listed]) {
          expect(JSON.stringify(body)).not.toContain('workflow-key-1');
          expect(JSON.stringify(body)).not.toContain('step-token-1');
        }
      });

      it('keeps the stored extra credentials when the returned definition is saved back', async () => {
        const response = await sut.get(auth, workflowId);

        await sut.update(auth, workflowId, {
          extra: response.extra,
          steps: response.steps.map(({ id, method, extra }) => ({
            id,
            method,
            config: { url: 'https://hooks.example.test', headerName: 'Authorization' },
            extra,
          })),
        });

        const replacement = mocks.workflow.update.mock.calls[0]![2]!.definition;
        expect(replacement.extra).toEqual({ integration: { apiKey: 'workflow-key-1', region: 'eu' } });
        expect(replacement.steps[0]!.extra).toEqual({ remote: { token: 'step-token-1', label: 'hook' } });
        expect(replacement.steps[0]!.config).toMatchObject({ headerValue: 'Bearer s3cret' });
      });

      it('keeps the workflow extra credentials when only the steps are saved', async () => {
        await sut.update(auth, workflowId, {
          steps: [
            {
              id: stepId,
              method: 'immich-plugin-core#webhook',
              config: { url: 'https://hooks.example.test', headerName: 'Authorization' },
            },
          ],
        });

        const replacement = mocks.workflow.update.mock.calls[0]![2]!.definition;
        expect(replacement.extra).toEqual(withExtraSecrets.extra);
      });

      it('keeps the stored step extra, credentials included, when a step is saved without extra', async () => {
        await sut.update(auth, workflowId, {
          steps: [
            {
              id: stepId,
              method: 'immich-plugin-core#webhook',
              config: { url: 'https://hooks.example.test', headerName: 'Authorization' },
            },
          ],
        });

        expect(mocks.workflow.update.mock.calls[0]![2]!.definition.steps[0]!.extra).toEqual({
          remote: { token: 'step-token-1', label: 'hook' },
        });
      });

      it('does not carry a step extra over to a different method', async () => {
        await sut.update(auth, workflowId, {
          steps: [{ id: stepId, method: 'immich-plugin-core#assetTypeFilter', config: { allowedTypes: ['IMAGE'] } }],
        });

        expect(mocks.workflow.update.mock.calls[0]![2]!.definition.steps[0]!.extra).toEqual({});
      });

      it('replaces an extra credential that is sent', async () => {
        await sut.update(auth, workflowId, { extra: { integration: { apiKey: 'workflow-key-2', region: 'eu' } } });

        expect(mocks.workflow.update.mock.calls[0]![2]!.definition.extra).toEqual({
          integration: { apiKey: 'workflow-key-2', region: 'eu' },
        });
      });
    });

    it('keeps a stored credential the edit leaves out, for the same step and method', async () => {
      await sut.update(auth, workflowId, {
        steps: [
          {
            id: stepId,
            method: 'immich-plugin-core#webhook',
            config: { url: 'https://hooks.example.test', headerName: 'Authorization' },
          },
        ],
      });

      const replacement = mocks.workflow.update.mock.calls[0]![2];
      expect(replacement!.definition.steps[0]!.config).toEqual({
        url: 'https://hooks.example.test',
        headerName: 'Authorization',
        headerValue: 'Bearer s3cret',
      });
    });

    it('requires a credential again when the destination changes', async () => {
      await expect(
        sut.update(auth, workflowId, {
          steps: [{ id: stepId, method: 'immich-plugin-core#webhook', config: { url: 'https://other.test' } }],
        }),
      ).rejects.toThrow(/Re-enter stored credentials/);
      expect(mocks.workflow.update).not.toHaveBeenCalled();
    });

    it('replaces or clears a credential that is sent', async () => {
      await sut.update(auth, workflowId, {
        steps: [
          { id: stepId, method: 'immich-plugin-core#webhook', config: { url: 'https://h.test', headerValue: '' } },
        ],
      });

      const replacement = mocks.workflow.update.mock.calls[0]![2];
      expect(replacement!.definition.steps[0]!.config).toEqual({ url: 'https://h.test', headerValue: '' });
    });

    it('does not hand a credential to a different step or method', async () => {
      await sut.update(auth, workflowId, {
        steps: [{ method: 'immich-plugin-core#webhook', config: { url: 'https://other.test' } }],
      });

      const replacement = mocks.workflow.update.mock.calls[0]![2];
      expect(replacement!.definition.steps[0]!.config).toEqual({ url: 'https://other.test' });
    });

    it('keeps two different webhook credentials with their ids when the steps are reordered', async () => {
      const secondId = newUuid();
      mocks.workflow.get.mockResolvedValue(
        stored({
          definition: {
            ...secretDefinition,
            steps: [
              { ...secretDefinition.steps[0], config: { url: 'https://a.test', headerValue: 'secret-a' } },
              {
                ...secretDefinition.steps[0],
                id: secondId,
                config: { url: 'https://b.test', headerValue: 'secret-b' },
              },
            ],
          },
        }) as never,
      );

      await sut.update(auth, workflowId, {
        steps: [
          { id: secondId, method: 'immich-plugin-core#webhook', config: { url: 'https://b.test' } },
          { id: stepId, method: 'immich-plugin-core#webhook', config: { url: 'https://a.test' } },
        ],
      });

      expect(
        mocks.workflow.update.mock.calls[0]![2]!.definition.steps.map(({ id, config }) => ({ id, config })),
      ).toEqual([
        { id: secondId, config: { url: 'https://b.test', headerValue: 'secret-b' } },
        { id: stepId, config: { url: 'https://a.test', headerValue: 'secret-a' } },
      ]);
    });

    it('does not restore a credential twice from a duplicate step id', async () => {
      await sut.update(auth, workflowId, {
        steps: [
          {
            id: stepId,
            method: 'immich-plugin-core#webhook',
            config: { url: 'https://hooks.example.test', headerName: 'Authorization' },
          },
          { id: stepId, method: 'immich-plugin-core#webhook', config: { url: 'https://other.test' } },
        ],
      });
      const steps = mocks.workflow.update.mock.calls[0]![2]!.definition.steps;
      expect(steps[0]!.config).toMatchObject({ headerValue: 'Bearer s3cret' });
      expect(steps[1]!.id).not.toBe(stepId);
      expect(steps[1]!.config).toEqual({ url: 'https://other.test' });
    });

    it('rejects prototype keys on create and credential restoration without changing Object.prototype', async () => {
      const malicious = JSON.parse('{"nested":{"__proto__":{"token":"probe"}}}') as Record<string, unknown>;
      await expect(
        sut.create(auth, {
          trigger: WorkflowTrigger.AssetCreate,
          enabled: false,
          steps: [{ method: 'immich-plugin-core#webhook', config: malicious }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.workflow.create).not.toHaveBeenCalled();

      mocks.workflow.get.mockResolvedValue(
        stored({
          definition: { ...secretDefinition, steps: [{ ...secretDefinition.steps[0], config: malicious }] },
        }) as never,
      );
      await expect(
        sut.update(auth, workflowId, {
          steps: [{ id: stepId, method: 'immich-plugin-core#webhook', config: {} }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.workflow.update).not.toHaveBeenCalled();
      expect(Object.hasOwn(Object.prototype, 'token')).toBe(false);
    });
  });

  describe('retryRun', () => {
    const runId = newUuid();
    const assetId = newUuid();

    it('queues the next attempt of the run as a manual retry', async () => {
      mocks.workflow.get.mockResolvedValue(stored({ enabled: true }) as never);
      mocks.workflow.getLatestRunAttempt.mockResolvedValue({ runId, triggerDataId: assetId, attempt: 1 } as never);

      await sut.retryRun(auth, workflowId, runId);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.WorkflowAssetTrigger,
        data: { workflowId, assetId, runId, attempt: 2, manual: true, executionId: expect.any(String) },
      });
    });

    it('refuses to retry a paused workflow', async () => {
      mocks.workflow.get.mockResolvedValue(stored({ enabled: false }) as never);
      mocks.workflow.getLatestRunAttempt.mockResolvedValue({ runId, triggerDataId: assetId, attempt: 0 } as never);

      await expect(sut.retryRun(auth, workflowId, runId)).rejects.toThrow(/Enable this workflow/);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('refuses to retry a run without the photo that started it', async () => {
      mocks.workflow.get.mockResolvedValue(stored({ enabled: true }) as never);
      mocks.workflow.getLatestRunAttempt.mockResolvedValue(undefined);

      await expect(sut.retryRun(auth, workflowId, runId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires update access to the workflow', async () => {
      mocks.access.workflow.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.retryRun(auth, workflowId, runId)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
});
