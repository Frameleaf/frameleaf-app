import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  StudioEditorScope,
  StudioProjectImportRef,
  StudioPublicationReceipt,
  StudioReceiptPage,
} from './host-contract';
import {
  onStudioImportSessionRetired,
  reconcileRetainedImports,
  retireStudioImportSessions,
  submitRetainedImport,
  type RetentionApi,
} from './import-retention';

const KEY = {
  ownerId: '0198a1c2-0000-7000-8000-00000000000a',
  projectId: '0198a1c2-0000-7000-8000-0000000000aa',
  importId: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01',
  publicationId: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e02',
};
const scope: StudioEditorScope = { userId: KEY.ownerId, projectId: KEY.projectId, graphVersion: 1 };
const upload = { id: KEY.importId, publicationId: KEY.publicationId, fileName: 'a.mp4', file: new Blob(['data']) };
const imported: StudioProjectImportRef = {
  id: KEY.importId,
  name: 'a.mp4',
  kind: 'video',
  mimeType: 'video/mp4',
  sizeBytes: 4,
  url: '/file',
};
const receipt: StudioPublicationReceipt = {
  publicationId: KEY.publicationId,
  importId: KEY.importId,
  state: 'registered',
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(21600000).toISOString(),
  cleanupPending: false,
};
const page: StudioReceiptPage = { items: [receipt], nextCursor: null };
const setup = () => ({
  register: vi.fn(async () => receipt),
  upload: vi.fn(async () => imported),
  discover: vi.fn(async (_project: string, _cursor?: string) => page),
  cancel: vi.fn(async (_projectId: string, _importId: string, _publicationId: string) => ({
    status: 'cancelled' as const,
    receipt: { ...receipt, state: 'aborted' as const },
  })),
});
afterEach(() => retireStudioImportSessions());

describe('host retained import boundary', () => {
  it('sends no file after lost registration acknowledgement or account retirement', async () => {
    const api = setup();
    api.register.mockRejectedValueOnce(new Error('network_unknown'));
    await expect(submitRetainedImport(api, scope, () => true, upload)).rejects.toThrow('network_unknown');
    expect(api.upload).not.toHaveBeenCalled();
    await expect(submitRetainedImport(api, scope, () => false, upload)).rejects.toThrow('origin_retired');
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('waits for durable matching registration, then sends the original scoped bytes exactly once', async () => {
    const api = setup();
    let acknowledge!: (value: StudioPublicationReceipt) => void;
    api.register.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const pending = submitRetainedImport(api, scope, () => true, upload);
    expect(api.register).toHaveBeenCalledWith(KEY.projectId, KEY.importId, KEY.publicationId);
    expect(api.upload).not.toHaveBeenCalled();
    acknowledge(receipt);
    expect(await pending).toEqual(imported);
    expect(api.upload).toHaveBeenCalledExactlyOnceWith(scope.projectId, { ...upload, scope });
  });

  it.each(['importId', 'publicationId'] as const)('refuses a changed %s binding', async (field) => {
    const api = setup();
    api.register.mockResolvedValueOnce({ ...receipt, [field]: 'other' });
    await expect(submitRetainedImport(api, scope, () => true, upload)).rejects.toThrow('receipt_binding_changed');
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('refuses registration acknowledgement after retirement', async () => {
    let current = true;
    const api = setup();
    api.register.mockImplementationOnce(async () => {
      current = false;
      return receipt;
    });
    await expect(submitRetainedImport(api, scope, () => current, upload)).rejects.toThrow('origin_retired');
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('honors cancellation before registration and never revives an aborted receipt', async () => {
    const api = setup();
    const result = await api.cancel(scope.projectId, upload.id, upload.publicationId);
    api.register.mockResolvedValueOnce(result.receipt);
    await expect(submitRetainedImport(api, scope, () => true, upload)).rejects.toThrow('publication_aborted');
    expect(api.upload).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'published'] as const)(
    'uses immutable upload verification for a matching %s receipt',
    async (state) => {
      const api = setup();
      api.register.mockResolvedValueOnce({ ...receipt, state, ...(state === 'published' ? { imported } : {}) });
      expect(await submitRetainedImport(api, scope, () => true, upload)).toEqual(imported);
      expect(api.upload).toHaveBeenCalledTimes(1);
      expect(receipt.expiresAt).toBe(new Date(21600000).toISOString());
    },
  );

  it('does not automatically resend after an unknown upload and does not cancel on late committed success', async () => {
    const api = setup();
    api.upload.mockRejectedValueOnce(new Error('network_unknown'));
    await expect(submitRetainedImport(api, scope, () => true, upload)).rejects.toThrow('network_unknown');
    expect(api.upload).toHaveBeenCalledTimes(1);
    let current = true;
    api.upload.mockImplementationOnce(async () => {
      current = false;
      return imported;
    });
    expect(await submitRetainedImport(api, scope, () => current, upload)).toEqual(imported);
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('discovers after all local IDs are lost and refuses a result for a retired account', async () => {
    const api = setup();
    expect(await reconcileRetainedImports(api, scope, () => true)).toEqual(page);
    expect(api.discover).toHaveBeenCalledWith(scope.projectId, undefined);
    expect(api.upload).not.toHaveBeenCalled();
    let current = true;
    api.discover.mockImplementationOnce(async () => {
      current = false;
      return page;
    });
    await expect(reconcileRetainedImports(api, scope, () => current)).rejects.toThrow('origin_retired');
    expect(api.upload).not.toHaveBeenCalled();
  });

  it.each(['userId', 'projectId'] as const)('discards deferred discovery after the %s changes', async (field) => {
    const api = setup();
    const active = { ...scope };
    let resolve!: (value: StudioReceiptPage) => void;
    api.discover.mockImplementationOnce(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    const pending = reconcileRetainedImports(
      api,
      scope,
      () => active.userId === scope.userId && active.projectId === scope.projectId,
    );
    active[field] = 'replacement';
    resolve(page);
    await expect(pending).rejects.toThrow('origin_retired');
    await expect(reconcileRetainedImports(api, scope, () => false)).rejects.toThrow('origin_retired');
    expect(api.discover).toHaveBeenCalledTimes(1);
  });

  it('reads more than100 same-timestamp receipts only when an explicit cursor is supplied', async () => {
    const api = setup();
    const first: StudioReceiptPage = {
      items: Array.from({ length: 100 }, (_, i) => ({
        ...receipt,
        publicationId: `4b0f4b2e-5d3a-4c55-9e0e-${String(i).padStart(12, '0')}`,
      })),
      nextCursor: 'opaque_server_cursor',
    };
    api.discover.mockResolvedValueOnce(first).mockResolvedValueOnce(page);
    expect(await reconcileRetainedImports(api, scope, () => true)).toEqual(first);
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(await reconcileRetainedImports(api, scope, () => true, first.nextCursor!)).toEqual(page);
    expect(api.discover).toHaveBeenLastCalledWith(scope.projectId, first.nextCursor);
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('keeps an unavailable page unknown and does not reconstruct bytes from registered receipts', async () => {
    const api = setup();
    api.discover.mockRejectedValueOnce(new Error('unavailable'));
    await expect(reconcileRetainedImports(api, scope, () => true)).rejects.toThrow('unavailable');
    expect(await reconcileRetainedImports(api, scope, () => true)).toEqual(page);
    expect(api.register).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('refuses a receipt page larger than100 rather than silently truncating it', async () => {
    const api = setup();
    api.discover.mockResolvedValueOnce({ items: Array.from({ length: 101 }, () => receipt), nextCursor: null });
    await expect(reconcileRetainedImports(api, scope, () => true)).rejects.toThrow('invalid_receipt_page');
  });

  it('detaches session callbacks and aborts local requests without issuing server cancellation', () => {
    const api: RetentionApi = setup();
    const controller = new AbortController();
    const detached = vi.fn(() => controller.abort());
    const remove = onStudioImportSessionRetired(detached);
    retireStudioImportSessions();
    retireStudioImportSessions();
    expect(controller.signal.aborted).toBe(true);
    expect(detached).toHaveBeenCalledTimes(1);
    expect(api.cancel).not.toHaveBeenCalled();
    remove();
    const removed = vi.fn();
    onStudioImportSessionRetired(removed)();
    retireStudioImportSessions();
    expect(removed).not.toHaveBeenCalled();
  });
});
