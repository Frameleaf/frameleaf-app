import { PersonCorrectionAction, type PersonCorrectionDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { personFactory } from '@test-data/factories/person-factory';
import CorrectionHistoryPanel from './CorrectionHistoryPanel.svelte';

/**
 * FL-57: the correction history panel pages the owner's decisions 25 at a time, never shows a
 * photo the server no longer authorizes (a placeholder instead), and undoes one decision,
 * showing the server's reason when the face has changed since.
 */
describe('CorrectionHistoryPanel', () => {
  const person = personFactory.build({ id: 'ada', name: 'Ada' });
  const ada = { id: 'ada', name: 'Ada', exists: true };
  const grace = { id: 'grace', name: 'Grace', exists: true };
  const correction = (id: string, overrides: Partial<PersonCorrectionDto> = {}): PersonCorrectionDto => ({
    id,
    action: PersonCorrectionAction.Reassign,
    createdAt: '2026-09-20T10:00:00.000Z',
    undoneAt: null,
    fromPerson: grace,
    toPerson: ada,
    evidence: { assetId: `asset-${id}`, faceId: `face-${id}`, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    evidenceRevoked: false,
    undoable: true,
    ...overrides,
  });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pages through the history with Show more', async () => {
    sdkMock.getCorrectionHistory
      .mockResolvedValueOnce({ corrections: [correction('one')], hasNextPage: true })
      .mockResolvedValueOnce({
        corrections: [correction('two', { action: PersonCorrectionAction.Merge })],
        hasNextPage: false,
      });
    render(CorrectionHistoryPanel, { person, close: vi.fn() });

    expect(await screen.findByText('Moved from Grace to Ada')).toBeTruthy();
    expect(sdkMock.getCorrectionHistory).toHaveBeenCalledWith({ id: 'ada', page: 1, size: 25 });

    await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Merged Grace into Ada')).toBeTruthy();
    expect(sdkMock.getCorrectionHistory).toHaveBeenLastCalledWith({ id: 'ada', page: 2, size: 25 });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows "No longer available" instead of a photo the owner can no longer see', async () => {
    sdkMock.getCorrectionHistory.mockResolvedValue({
      corrections: [correction('shown'), correction('revoked', { evidence: null, evidenceRevoked: true })],
      hasNextPage: false,
    });
    const { container } = render(CorrectionHistoryPanel, { person, close: vi.fn() });

    await screen.findAllByText('Moved from Grace to Ada');
    const rows = container.querySelectorAll('.pd-history-row');
    expect(rows).toHaveLength(2);
    // the shown decision has its face photo; the revoked one only a placeholder, never an image
    expect(rows[0].querySelectorAll('img')).toHaveLength(1);
    expect(rows[1].querySelectorAll('img')).toHaveLength(0);
    expect(rows[1].querySelector('.is-unavailable')).toBeTruthy();
    expect(rows[1].textContent).toContain('No longer available');
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
  });

  it('undoes a change and reports it on close', async () => {
    sdkMock.getCorrectionHistory.mockResolvedValue({ corrections: [correction('one')], hasNextPage: false });
    sdkMock.undoCorrection.mockResolvedValue(
      correction('one', { undoneAt: '2026-09-21T10:00:00.000Z', undoable: false }),
    );
    const onChanged = vi.fn();
    const close = vi.fn();
    render(CorrectionHistoryPanel, { person, onChanged, close });

    await fireEvent.click(await screen.findByRole('button', { name: 'Undo: Moved from Grace to Ada' }));
    await waitFor(() => expect(sdkMock.undoCorrection).toHaveBeenCalledWith({ id: 'one' }));
    expect(await screen.findByText(/^Undone /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo: Moved from Grace to Ada' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // the people the face went back to and left, announced once by the caller
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(['grace', 'ada']);
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows the server's reason when the face has changed since", async () => {
    sdkMock.getCorrectionHistory.mockResolvedValue({ corrections: [correction('one')], hasNextPage: false });
    sdkMock.undoCorrection.mockRejectedValue({ status: 409, data: { reason: 'face-changed' } });
    render(CorrectionHistoryPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Undo: Moved from Grace to Ada' }));
    expect((await screen.findAllByText("This face has changed since, so this can't be undone")).length).toBeGreaterThan(
      0,
    );
  });

  it('offers no undo for a merge', async () => {
    sdkMock.getCorrectionHistory.mockResolvedValue({
      corrections: [correction('merge', { action: PersonCorrectionAction.Merge, evidence: null, undoable: false })],
      hasNextPage: false,
    });
    render(CorrectionHistoryPanel, { person, close: vi.fn() });

    expect(await screen.findByText('Merged Grace into Ada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });
});
