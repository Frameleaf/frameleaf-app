import { IntegrityReport, ManualJobName } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import IntegrityReportSection from './IntegrityReportSection.svelte';

const handleCreateJob = vi.fn();
vi.mock('$lib/services/job.service', () => ({ handleCreateJob: (...args: unknown[]) => handleCreateJob(...args) }));

const finding = (id: string) => ({ id, path: `/data/upload/${id}.png`, type: IntegrityReport.UntrackedFile });

const queue = (waiting = 0) =>
  ({
    integrityCheck: {
      jobCounts: { active: 0, waiting, delayed: 0, paused: 0, completed: 0, failed: 0 },
      queueStatus: { isActive: false, isPaused: false },
    },
  }) as never;
const idle = queue();

describe('IntegrityReportSection (FL-81)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getQueuesLegacy.mockResolvedValue(idle);
  });

  it('re-reads the findings after "Recheck findings" even when the refresh finishes between polls', async () => {
    sdkMock.getIntegrityReport.mockResolvedValueOnce({ items: [finding('a')] }).mockResolvedValue({ items: [] });
    handleCreateJob.mockResolvedValue(true);

    render(IntegrityReportSection, { type: IntegrityReport.UntrackedFile, pollMs: 5 });
    expect(await screen.findByText('/data/upload/a.png')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.admin.frameleaf_maintenance_report_recheck }));

    expect(handleCreateJob).toHaveBeenCalledWith({ name: ManualJobName.IntegrityUntrackedFilesRefresh });
    await waitFor(() => expect(screen.queryByText('/data/upload/a.png')).not.toBeInTheDocument());
    expect(sdkMock.getIntegrityReport).toHaveBeenLastCalledWith({ $type: IntegrityReport.UntrackedFile });
  });

  it('waits while the refresh is still queued behind other work', async () => {
    sdkMock.getIntegrityReport.mockResolvedValueOnce({ items: [finding('a')] }).mockResolvedValue({ items: [] });
    sdkMock.getQueuesLegacy.mockResolvedValue(queue(1));
    handleCreateJob.mockResolvedValue(true);

    render(IntegrityReportSection, { type: IntegrityReport.UntrackedFile, pollMs: 5 });
    expect(await screen.findByText('/data/upload/a.png')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.admin.frameleaf_maintenance_report_recheck }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sdkMock.getIntegrityReport).toHaveBeenCalledTimes(1);

    sdkMock.getQueuesLegacy.mockResolvedValue(idle);
    await waitFor(() => expect(screen.queryByText('/data/upload/a.png')).not.toBeInTheDocument());
  });

  it('keeps the loaded findings when the refresh job could not be created', async () => {
    sdkMock.getIntegrityReport.mockResolvedValue({ items: [finding('a')] });
    handleCreateJob.mockResolvedValue(undefined);

    render(IntegrityReportSection, { type: IntegrityReport.UntrackedFile, pollMs: 5 });
    expect(await screen.findByText('/data/upload/a.png')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.admin.frameleaf_maintenance_report_recheck }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sdkMock.getIntegrityReport).toHaveBeenCalledTimes(1);
  });

  it('loads the next page of findings with the cursor', async () => {
    sdkMock.getIntegrityReport
      .mockResolvedValueOnce({ items: [finding('a')], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [finding('b')] });

    render(IntegrityReportSection, { type: IntegrityReport.UntrackedFile, pollMs: 60_000 });
    await fireEvent.click(await screen.findByRole('button', { name: en.load_more }));

    expect(await screen.findByText('/data/upload/b.png')).toBeInTheDocument();
    expect(screen.getByText('/data/upload/a.png')).toBeInTheDocument();
    expect(sdkMock.getIntegrityReport).toHaveBeenLastCalledWith({
      $type: IntegrityReport.UntrackedFile,
      cursor: 'next',
    });
    expect(screen.queryByRole('button', { name: en.load_more })).not.toBeInTheDocument();
  });
});
