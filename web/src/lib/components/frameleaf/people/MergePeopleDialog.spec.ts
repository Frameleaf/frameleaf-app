import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { personFactory } from '@test-data/factories/person-factory';
import MergePeopleDialog from './MergePeopleDialog.svelte';

describe('MergePeopleDialog (PD-4)', () => {
  const ada = { ...personFactory.build({ id: 'ada', name: 'Ada' }), assetCount: 4, lastSeenAt: null };
  const grace = { ...personFactory.build({ id: 'grace', name: 'Grace' }), assetCount: 9, lastSeenAt: null };
  const unnamed = { ...personFactory.build({ id: 'unnamed', name: '' }), assetCount: 20, lastSeenAt: null };

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const pickerRows = (...people: { id: string; name: string; assetCount: number }[]) =>
    sdkMock.getPeoplePicker.mockResolvedValue({
      people: people.map(({ id, name, assetCount }) => ({ id, name, assetCount, updatedAt: '2026-11-01T00:00:00Z' })),
      hasNextPage: false,
    });

  it('lists everyone else through the shared person picker, and Merge waits for a choice', async () => {
    pickerRows(ada, unnamed, grace);
    render(MergePeopleDialog, { person: ada, open: true, onMerged: vi.fn() });

    expect(await screen.findByRole('button', { name: /Grace\s*9 items/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Unnamed person\s*20 items/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ada/ })).toBeNull();
    expect(screen.getByText('Choose a person')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('merges the person into the chosen one, which survives', async () => {
    pickerRows(ada, grace);
    sdkMock.mergePeople.mockResolvedValue([]);
    const onMerged = vi.fn();
    render(MergePeopleDialog, { person: ada, open: true, onMerged });
    await fireEvent.click(await screen.findByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(onMerged).toHaveBeenCalledWith(expect.objectContaining({ id: 'grace' })));
    expect(sdkMock.mergePeople).toHaveBeenCalledWith({ mergePersonDto: { ids: ['grace', 'ada'] } });
  });

  it('announces the moved faces so open chips and person pages re-read them (FL-37)', async () => {
    pickerRows(ada, grace);
    sdkMock.mergePeople.mockResolvedValue([]);
    const changes = vi.fn();
    const stop = eventManager.on({ PersonFacesChange: changes });
    render(MergePeopleDialog, { person: ada, open: true, onMerged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(changes).toHaveBeenCalledWith({ personIds: ['grace', 'ada'], removedPersonIds: ['ada'] }),
    );
    stop();
  });

  it('announces nothing when the merge is refused', async () => {
    pickerRows(ada, grace);
    sdkMock.mergePeople.mockRejectedValue(new Error('no'));
    const changes = vi.fn();
    const stop = eventManager.on({ PersonFacesChange: changes });
    const onMerged = vi.fn();
    render(MergePeopleDialog, { person: ada, open: true, onMerged });
    await fireEvent.click(await screen.findByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(sdkMock.mergePeople).toHaveBeenCalled());
    expect(changes).not.toHaveBeenCalled();
    expect(onMerged).not.toHaveBeenCalled();
    stop();
  });

  it('preselects the person a rename collided with, wherever they are in the list', async () => {
    pickerRows(ada, grace);
    const outside = personFactory.build({ id: 'outside', name: 'Outside' });
    sdkMock.getPerson.mockResolvedValue(outside);
    render(MergePeopleDialog, { person: ada, initialChoice: 'outside', open: true, onMerged: vi.fn() });

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getAllByText('Outside').length).toBeGreaterThan(0);
    expect(sdkMock.getPerson).toHaveBeenCalledWith({ id: 'outside' });
  });
});
