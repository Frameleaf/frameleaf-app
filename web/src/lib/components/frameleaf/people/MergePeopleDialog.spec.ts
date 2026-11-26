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

  it('lists everyone else, named people first, with their item counts', () => {
    render(MergePeopleDialog, { person: ada, candidates: [ada, unnamed, grace], open: true, onMerged: vi.fn() });

    const rows = screen.getAllByRole('button', { pressed: false }).filter((button) => button.closest('li'));
    expect(rows.map((row) => row.textContent?.replaceAll(/\s+/g, ' ').trim())).toEqual([
      'Grace 9 items',
      'Unnamed person 20 items',
    ]);
    expect(screen.getByText('Choose a person')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // FL-1803: opened without the caller's list (the person page), the dialog read the first 1,000 people
  // and searched only those, so anyone after them could not be merged into.
  it('finds someone past the first page by asking the server for the name typed', async () => {
    const everyone = Array.from({ length: 1500 }, (_, index) => ({
      ...personFactory.build({ id: `p${index}`, name: `Person ${String(index).padStart(4, '0')}` }),
      assetCount: 1,
      lastSeenAt: null,
    }));
    // a page here is 40 people, whatever size is asked for: enough to stand for "more than one page"
    const PAGE = 40;
    sdkMock.getAllPeople.mockImplementation((options) => {
      const name = options?.name;
      const matching = name
        ? everyone.filter((person) => person.name.toLowerCase().includes(name.toLowerCase()))
        : everyone;
      return Promise.resolve({
        people: matching.slice(0, PAGE),
        total: everyone.length,
        hidden: 0,
        hasNextPage: matching.length > PAGE,
      });
    });
    render(MergePeopleDialog, { person: ada, open: true, onMerged: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: /Person 0039/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Person 1400/ })).toBeNull();

    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'person 1400' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Person 1400/ })).toBeTruthy());
    expect(sdkMock.getAllPeople).toHaveBeenLastCalledWith({ withHidden: true, size: 1000, name: 'person 1400' });
  });

  it('keeps to the caller’s list when it is given one, without reading people', async () => {
    render(MergePeopleDialog, { person: ada, candidates: [ada, grace], open: true, onMerged: vi.fn() });

    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'gra' } });

    expect(screen.getByRole('button', { name: /Grace/ })).toBeTruthy();
    expect(sdkMock.getAllPeople).not.toHaveBeenCalled();
  });

  it('merges the person into the chosen one, which survives', async () => {
    sdkMock.mergePeople.mockResolvedValue([]);
    const onMerged = vi.fn();
    render(MergePeopleDialog, { person: ada, candidates: [ada, grace], open: true, onMerged });

    await fireEvent.click(screen.getByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledWith(grace));
    expect(sdkMock.mergePeople).toHaveBeenCalledWith({ mergePersonDto: { ids: ['grace', 'ada'] } });
  });

  it('announces the moved faces so open chips and person pages re-read them (FL-37)', async () => {
    sdkMock.mergePeople.mockResolvedValue([]);
    const changes = vi.fn();
    const stop = eventManager.on({ PersonFacesChange: changes });
    render(MergePeopleDialog, { person: ada, candidates: [ada, grace], open: true, onMerged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() =>
      expect(changes).toHaveBeenCalledWith({ personIds: ['grace', 'ada'], removedPersonIds: ['ada'] }),
    );
    stop();
  });

  it('announces nothing when the merge is refused', async () => {
    sdkMock.mergePeople.mockRejectedValue(new Error('no'));
    const changes = vi.fn();
    const stop = eventManager.on({ PersonFacesChange: changes });
    const onMerged = vi.fn();
    render(MergePeopleDialog, { person: ada, candidates: [ada, grace], open: true, onMerged });

    await fireEvent.click(screen.getByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(sdkMock.mergePeople).toHaveBeenCalled());
    expect(changes).not.toHaveBeenCalled();
    expect(onMerged).not.toHaveBeenCalled();
    stop();
  });

  it('preselects the person a rename collided with', () => {
    render(MergePeopleDialog, {
      person: ada,
      candidates: [ada, grace],
      initialChoice: 'grace',
      open: true,
      onMerged: vi.fn(),
    });

    expect(screen.getByRole('button', { name: /Grace/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads a preselected person the list does not include', async () => {
    const outside = personFactory.build({ id: 'outside', name: 'Outside' });
    sdkMock.getPerson.mockResolvedValue(outside);
    render(MergePeopleDialog, {
      person: ada,
      candidates: [ada, grace],
      initialChoice: 'outside',
      open: true,
      onMerged: vi.fn(),
    });

    const row = await screen.findByRole('button', { name: /Outside/ });
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(sdkMock.getPerson).toHaveBeenCalledWith({ id: 'outside' });
  });
});
