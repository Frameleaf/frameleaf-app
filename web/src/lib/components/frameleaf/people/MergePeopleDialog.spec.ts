import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
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

  it('merges the person into the chosen one, which survives', async () => {
    sdkMock.mergePeople.mockResolvedValue([]);
    const onMerged = vi.fn();
    render(MergePeopleDialog, { person: ada, candidates: [ada, grace], open: true, onMerged });

    await fireEvent.click(screen.getByRole('button', { name: /Grace/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledWith(grace));
    expect(sdkMock.mergePeople).toHaveBeenCalledWith({ mergePersonDto: { ids: ['grace', 'ada'] } });
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
});
