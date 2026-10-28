import {
  cancelDevelopBatch,
  confirmDevelopBatchReturns,
  createDevelopBatch,
  getDevelopBatch,
  getDevelopBatchCapabilities,
  getDevelopBatches,
  importDevelopBatchReturn,
  matchDevelopBatchReturns,
  prepareDevelopBatchItem,
  type DevelopBatchResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DevelopBatchPanel from './DevelopBatchPanel.svelte';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  cancelDevelopBatch: vi.fn(),
  confirmDevelopBatchReturns: vi.fn(),
  createDevelopBatch: vi.fn(),
  getDevelopBatch: vi.fn(),
  getDevelopBatchCapabilities: vi.fn(),
  getDevelopBatches: vi.fn(),
  importDevelopBatchReturn: vi.fn(),
  matchDevelopBatchReturns: vi.fn(),
  prepareDevelopBatchItem: vi.fn(),
}));
vi.mock('$lib/workers/hash-file', () => ({
  hashFile: vi.fn(async (file: File) => (file.name.startsWith('other') ? 'b'.repeat(64) : 'a'.repeat(64))),
}));
const first = {
  id: 'item-1',
  assetId: 'asset-1',
  exportId: 'export-1',
  exportName: 'Photo__fl_export-1.jpg',
  fileName: 'Photo.jpg',
  sourceChecksum: 'c'.repeat(64),
  available: true,
  hasSidecar: false,
  preparationStatus: 'prepared',
  error: null,
  errorCode: null,
  returns: [
    {
      id: 'return-1',
      checksum: 'a'.repeat(64),
      confirmationId: 'confirm-1',
      expectedCurrentRevisionId: null,
      revisionId: null,
      status: 'confirmed',
      progress: 0,
      error: null,
      errorCode: null,
    },
  ],
};
const second = {
  ...first,
  id: 'item-2',
  assetId: 'asset-2',
  exportId: 'export-2',
  fileName: 'Other.jpg',
  returns: [{ ...first.returns[0], id: 'return-2', confirmationId: 'confirm-2', checksum: 'b'.repeat(64) }],
};
const batch = () =>
  ({
    id: 'batch-1',
    status: 'open',
    createdAt: '2026-10-28T00:00:00Z',
    includeSidecars: true,
    items: [structuredClone(first), structuredClone(second)],
  }) as unknown as DevelopBatchResponseDto;
const mount = () => render(DevelopBatchPanel, { props: { initialBatchId: 'batch-1' } });
const choose = async (names = ['return.png']) => {
  await screen.findByLabelText('Choose returned files');
  await fireEvent.change(screen.getByLabelText('Choose returned files'), {
    target: { files: names.map((name) => new File(['fixture'], name, { type: 'image/png' })) },
  });
  await screen.findByRole('button', { name: 'Confirm matches and import' });
};
beforeAll(async () => {
  await init({ fallbackLocale: 'en-US' });
  register('en-US', () => import('$i18n/en.json'));
  await waitLocale('en-US');
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDevelopBatchCapabilities).mockResolvedValue({ version: 1 } as never);
  vi.mocked(getDevelopBatches).mockResolvedValue([batch()]);
  vi.mocked(getDevelopBatch).mockResolvedValue(batch());
  vi.mocked(confirmDevelopBatchReturns).mockResolvedValue(batch());
  vi.mocked(importDevelopBatchReturn).mockResolvedValue(batch().items[0]);
  vi.mocked(cancelDevelopBatch).mockResolvedValue({ ...batch(), status: 'cancelled' } as never);
  vi.mocked(prepareDevelopBatchItem).mockResolvedValue(batch().items[0]);
  vi.mocked(matchDevelopBatchReturns).mockResolvedValue([
    { index: 0, fileName: 'return.png', checksum: 'a'.repeat(64), itemId: 'item-1', status: 'matched' },
  ] as never);
});

describe('batch external editor review', () => {
  it('reviews the returned file before confirmation, then uploads only the confirmed item and checksum', async () => {
    mount();
    await choose();
    expect(importDevelopBatchReturn).not.toHaveBeenCalled();
    expect(confirmDevelopBatchReturns).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm matches and import' }));
    await waitFor(() => expect(importDevelopBatchReturn).toHaveBeenCalledOnce());
    expect(confirmDevelopBatchReturns).toHaveBeenCalledWith({
      id: 'batch-1',
      developBatchConfirmDto: { files: [{ fileName: 'return.png', checksum: 'a'.repeat(64), itemId: 'item-1' }] },
    });
    expect(importDevelopBatchReturn).toHaveBeenCalledWith({
      id: 'batch-1',
      itemId: 'item-1',
      developBatchImportDto: { file: expect.any(File), confirmationId: 'confirm-1', renditionChecksum: 'a'.repeat(64) },
    });
  });
  it('requires explicit mapping for a renamed/ambiguous file and sends the choice back for authoritative review', async () => {
    vi.mocked(matchDevelopBatchReturns).mockResolvedValueOnce([
      { index: 0, fileName: 'renamed.png', checksum: 'a'.repeat(64), itemId: null, status: 'ambiguous' },
    ] as never);
    mount();
    await choose(['renamed.png']);
    expect(screen.getByRole('button', { name: 'Confirm matches and import' })).toBeDisabled();
    await fireEvent.change(screen.getByLabelText('Photo for renamed.png'), { target: { value: 'item-1' } });
    await waitFor(() =>
      expect(matchDevelopBatchReturns).toHaveBeenLastCalledWith({
        id: 'batch-1',
        developBatchMatchDto: { files: [{ fileName: 'renamed.png', checksum: 'a'.repeat(64), itemId: 'item-1' }] },
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm matches and import' })).not.toBeDisabled());
  });
  it('preserves partial successes and retries only the failed local file', async () => {
    vi.mocked(matchDevelopBatchReturns).mockResolvedValue([
      { index: 0, fileName: 'return.png', checksum: 'a'.repeat(64), itemId: 'item-1', status: 'matched' },
      { index: 1, fileName: 'other.png', checksum: 'b'.repeat(64), itemId: 'item-2', status: 'matched' },
    ] as never);
    vi.mocked(importDevelopBatchReturn)
      .mockResolvedValueOnce(batch().items[0])
      .mockRejectedValueOnce({ status: 400, data: { code: 'transfer_checksum' } })
      .mockResolvedValue(batch().items[1]);
    mount();
    await choose(['return.png', 'other.png']);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm matches and import' }));
    await screen.findByRole('button', { name: 'Retry failed files' });
    expect(screen.getByText('1 of 2 files uploaded')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry failed files' }));
    await waitFor(() => expect(importDevelopBatchReturn).toHaveBeenCalledTimes(3));
    expect(vi.mocked(importDevelopBatchReturn).mock.calls[2][0].itemId).toBe('item-2');
  });
  it('cancels unfinished work and reselects local files after reopening instead of retaining pretend handles', async () => {
    const firstMount = mount();
    await choose();
    firstMount.unmount();
    mount();
    await screen.findByLabelText('Choose returned files');
    expect(screen.queryByRole('button', { name: 'Confirm matches and import' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel unfinished work' }));
    await waitFor(() => expect(cancelDevelopBatch).toHaveBeenCalledWith({ id: 'batch-1' }));
    await waitFor(() => expect(screen.queryByLabelText('Choose returned files')).not.toBeInTheDocument());
  });
  it('resumes the batch selected from the list', async () => {
    vi.mocked(getDevelopBatches).mockResolvedValue([batch(), { ...batch(), id: 'batch-2' }]);
    mount();
    const select = await screen.findByLabelText('Resume a batch');
    await fireEvent.change(select, { target: { value: 'batch-2' } });
    await waitFor(() => expect(getDevelopBatch).toHaveBeenCalledWith({ id: 'batch-2' }));
  });
  it.each([404, 405])('shows old-server capability only for HTTP %s', async (status) => {
    vi.mocked(getDevelopBatchCapabilities).mockRejectedValue({ status });
    mount();
    await screen.findByText('This server does not support batch external editing yet.');
    expect(getDevelopBatches).not.toHaveBeenCalled();
  });
  it.each([401, 500])('retains an HTTP %s capability failure as an error', async (status) => {
    vi.mocked(getDevelopBatchCapabilities).mockRejectedValue({ status });
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByText('This server does not support batch external editing yet.')).not.toBeInTheDocument();
  });
  it('creates a durable batch before preparing each selected original', async () => {
    vi.mocked(createDevelopBatch).mockResolvedValue({
      ...batch(),
      items: [{ ...first, preparationStatus: 'pending' }],
    } as never);
    vi.mocked(getDevelopBatch).mockResolvedValue({
      ...batch(),
      items: [{ ...first, preparationStatus: 'pending' }],
    } as never);
    render(DevelopBatchPanel, { props: { assetIds: ['asset-1'] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create batch of 1 photos' })).not.toBeDisabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Create batch of 1 photos' }));
    await screen.findByRole('button', { name: 'Prepare originals' });
    expect(prepareDevelopBatchItem).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare originals' })).not.toBeDisabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Prepare originals' }));
    await waitFor(() => expect(prepareDevelopBatchItem).toHaveBeenCalledWith({ id: 'batch-1', itemId: 'item-1' }));
  });
});
