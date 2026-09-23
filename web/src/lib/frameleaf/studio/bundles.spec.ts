import {
  StudioBundleSourceMode,
  StudioBundleSourceResolution,
  type MediaOperationDto,
  type StudioBundleUploadDto,
} from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createStudioBridge } from './bridge';
import { createStudioBundleHandlers, studioBundleDownloadPath, type StudioBundleApi } from './bundles';
import { createStudioCommandEnvelope } from './commands';
import { emptyStudioCapabilities } from './host-contract';

const operation = { id: '0195e2a0-0000-7000-8000-0000000000b1' } as MediaOperationDto;

const upload = {
  id: '0195e2a0-0000-7000-8000-0000000000c1',
  sources: [
    {
      key: 'library-asset:a',
      kind: 'library-asset',
      id: 'a',
      mode: StudioBundleSourceMode.Reference,
      fileName: null,
      contentType: null,
      sizeBytes: null,
      resolution: StudioBundleSourceResolution.Suggested,
      suggestedAssetId: 'mine-a',
    },
    {
      key: 'library-asset:b',
      kind: 'library-asset',
      id: 'b',
      mode: StudioBundleSourceMode.Embedded,
      fileName: 'b.jpg',
      contentType: 'image/jpeg',
      sizeBytes: '10',
      resolution: StudioBundleSourceResolution.Missing,
      suggestedAssetId: null,
    },
  ],
} as StudioBundleUploadDto;

const savedProject = { id: 'p-1', revision: 4, saved: true };

const setup = (project = savedProject, askIncludeMedia?: () => Promise<boolean | null>) => {
  const api: StudioBundleApi = {
    exportProject: vi.fn().mockResolvedValue(operation),
    getUpload: vi.fn().mockResolvedValue(upload),
    importUpload: vi.fn().mockResolvedValue(operation),
  };
  const onQueued = vi.fn();
  const onRefused = vi.fn();
  const handlers = createStudioBundleHandlers({
    api,
    project: () => project,
    askIncludeMedia,
    onQueued,
    onRefused,
  });
  const bridge = createStudioBridge({
    context: () => ({
      revision: project.revision,
      hasLease: true,
      hasAccess: true,
      online: true,
      capabilities: emptyStudioCapabilities(),
    }),
    handlers,
  });
  return { api, onQueued, onRefused, bridge };
};

describe('studio bundle commands', () => {
  it('queues an export of the stored revision and answers with the revision unchanged', async () => {
    const { api, onQueued, bridge } = setup();
    const envelope = createStudioCommandEnvelope('project.exportBundle', {}, 4, { idempotencyKey: 'export-key-1' });

    const [result] = await bridge.submit([envelope]);

    expect(result).toEqual({ status: 'accepted', idempotencyKey: 'export-key-1', revision: 4 });
    expect(api.exportProject).toHaveBeenCalledWith('p-1', { includeMedia: false, requestKey: 'export-key-1' });
    expect(onQueued).toHaveBeenCalledWith(operation);
  });

  it('refuses to export a subset of sequences, which needs the editor, instead of exporting everything', async () => {
    const { api, onRefused, bridge } = setup();
    const [result] = await bridge.submit([
      createStudioCommandEnvelope('project.exportBundle', { sequenceIds: ['seq-2'] }, 4),
    ]);

    expect(result.status).toBe('rejected');
    expect(onRefused).toHaveBeenCalledWith('frameleaf_studio_bundle_sequences_unavailable');
    expect(api.exportProject).not.toHaveBeenCalled();
  });

  it('asks for a save before exporting a project that has none, without asking about copies', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const { api, onRefused, bridge } = setup({ id: 'draft', revision: 0, saved: false }, ask);
    await bridge.submit([createStudioCommandEnvelope('project.exportBundle', {}, 0)]);

    expect(onRefused).toHaveBeenCalledWith('frameleaf_studio_bundle_save_first');
    expect(ask).not.toHaveBeenCalled();
    expect(api.exportProject).not.toHaveBeenCalled();
  });

  it('sends the choice to include copies of owned media exactly as the payload states it', async () => {
    const ask = vi.fn();
    const { api, bridge } = setup(undefined, ask);
    await bridge.submit([
      createStudioCommandEnvelope('project.exportBundle', { includeMedia: true }, 4, { idempotencyKey: 'with-media' }),
      createStudioCommandEnvelope('project.exportBundle', { includeMedia: false }, 4, { idempotencyKey: 'no-media' }),
    ]);

    expect(api.exportProject).toHaveBeenNthCalledWith(1, 'p-1', { includeMedia: true, requestKey: 'with-media' });
    expect(api.exportProject).toHaveBeenNthCalledWith(2, 'p-1', { includeMedia: false, requestKey: 'no-media' });
    // An explicit choice is never asked again.
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks the person in the export dialog when the payload leaves the choice open', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const { api, onQueued, bridge } = setup(undefined, ask);
    const [result] = await bridge.submit([
      createStudioCommandEnvelope('project.exportBundle', {}, 4, { idempotencyKey: 'asked' }),
    ]);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(api.exportProject).toHaveBeenCalledWith('p-1', { includeMedia: true, requestKey: 'asked' });
    expect(onQueued).toHaveBeenCalledWith(operation);
    expect(result.status).toBe('accepted');
  });

  it('queues nothing and reports nothing when the person cancels the export dialog', async () => {
    const ask = vi.fn().mockResolvedValue(null);
    const { api, onQueued, onRefused, bridge } = setup(undefined, ask);
    const [result] = await bridge.submit([createStudioCommandEnvelope('project.exportBundle', {}, 4)]);

    expect(result.status).toBe('rejected');
    expect(api.exportProject).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('says so when the server does not take the export', async () => {
    const { api, onRefused, bridge } = setup();
    vi.mocked(api.exportProject).mockRejectedValueOnce(new Error('offline'));
    const [result] = await bridge.submit([createStudioCommandEnvelope('project.exportBundle', {}, 4)]);

    expect(result.status).toBe('rejected');
    expect(onRefused).toHaveBeenCalledWith('frameleaf_studio_bundle_export_failed');
  });

  it('imports into a new project with the accepted suggestions and leaves the open project alone', async () => {
    const { api, onQueued, bridge } = setup();
    const [result] = await bridge.submit([
      createStudioCommandEnvelope('project.importBundle', { bundleUploadId: upload.id }, 4, {
        idempotencyKey: 'import-key-1',
      }),
    ]);

    expect(result).toEqual({ status: 'accepted', idempotencyKey: 'import-key-1', revision: 4 });
    expect(api.importUpload).toHaveBeenCalledWith({
      uploadId: upload.id,
      mapping: { 'library-asset:a': 'mine-a' },
      requestKey: 'import-key-1',
    });
    expect(onQueued).toHaveBeenCalledWith(operation);
  });

  it('never sends an idempotency key the server would refuse', async () => {
    const { api, bridge } = setup();
    await bridge.submit([
      createStudioCommandEnvelope('project.exportBundle', {}, 4, { idempotencyKey: 'has spaces/and slashes' }),
    ]);
    expect(api.exportProject).toHaveBeenCalledWith('p-1', { includeMedia: false, requestKey: undefined });
  });

  it('downloads through the owner-scoped route only', () => {
    expect(studioBundleDownloadPath('abc')).toBe('/studio/bundles/exports/abc/download');
  });
});
