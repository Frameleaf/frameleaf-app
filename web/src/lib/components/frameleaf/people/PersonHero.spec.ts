import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { personFactory } from '@test-data/factories/person-factory';
import PersonHero from './PersonHero.svelte';

vi.mock('$lib/components/frameleaf/people/FixMatchPanel.svelte', async () => {
  return await import('@test-data/mocks/FixMatchPanel.mock.svelte');
});

describe('PersonHero (PD-1, PD-2, PD-7, PD-8)', () => {
  const props = (overrides: Partial<ComponentProps<typeof PersonHero>> = {}) => ({
    person: personFactory.build({ id: 'ada', name: 'Ada', isHidden: false, isFavorite: false, birthDate: null }),
    statistics: { assets: 3, photos: 2, videos: 1 },
    onBack: vi.fn(),
    onPersonChange: vi.fn(),
    onMergedAway: vi.fn(),
    onFacesChanged: vi.fn(),
    onOpenAsset: vi.fn(),
    onOpenRecognitionGroups: vi.fn(),
    ...overrides,
  });

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

  it('counts photos and videos as PersonDetail.jsx does', () => {
    render(PersonHero, props());
    expect(screen.getByText('2 photos · 1 video')).toBeTruthy();
  });

  it('leaves out a kind the person has none of', () => {
    render(PersonHero, props({ statistics: { assets: 1, photos: 1, videos: 0 } }));
    expect(screen.getByText('1 photo')).toBeTruthy();
  });

  it('says there are no photos yet and disables the photo actions', () => {
    render(PersonHero, props({ statistics: { assets: 0, photos: 0, videos: 0 } }));
    expect(screen.getByText('No photos yet')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Featured photo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Fix incorrect match' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Select featured photo for Ada' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('hides the person, announces the change and says what happened', async () => {
    const view = props();
    const hidden = { ...view.person, isHidden: true };
    sdkMock.updatePerson.mockResolvedValue(hidden);
    const announced = vi.fn();
    const stop = eventManager.on({ PersonUpdate: announced });
    render(PersonHero, view);

    await fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    await waitFor(() => expect(view.onPersonChange).toHaveBeenCalledWith(hidden));
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({ id: 'ada', personUpdateDto: { isHidden: true } });
    expect(announced).toHaveBeenCalledWith(hidden);
    expect(screen.getByRole('status').textContent).toContain('Ada is hidden from the People page');
    stop();
  });

  it('favorites the person', async () => {
    const view = props();
    const favorite = { ...view.person, isFavorite: true };
    sdkMock.updatePerson.mockResolvedValue(favorite);
    render(PersonHero, view);

    await fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));

    await waitFor(() => expect(view.onPersonChange).toHaveBeenCalledWith(favorite));
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({ id: 'ada', personUpdateDto: { isFavorite: true } });
  });

  it('shows the age next to a date of birth and marks a hidden person', () => {
    const born = new Date();
    born.setFullYear(born.getFullYear() - 30);
    born.setDate(born.getDate() - 1);
    const birthDate = born.toISOString().slice(0, 10);
    render(PersonHero, props({ person: personFactory.build({ id: 'ada', name: 'Ada', isHidden: true, birthDate }) }));
    expect(screen.getByText(/30 years old/)).toBeTruthy();
    expect(screen.getByText('Hidden from People')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unhide' })).toBeTruthy();
  });

  it('announces moved faces after Fix incorrect match so chips and search re-read them', async () => {
    const view = props();
    const changes = vi.fn();
    const stop = eventManager.on({ PersonFacesChange: changes });
    render(PersonHero, view);

    await fireEvent.click(screen.getByRole('button', { name: 'Fix incorrect match' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Moved a face' }));

    // announced once, by the hero, for this person and the person the face moved to
    expect(changes).toHaveBeenCalledExactlyOnceWith({ personIds: ['ada', 'grace'] });
    expect(view.onFacesChanged).toHaveBeenCalledOnce();
    stop();
  });
});
