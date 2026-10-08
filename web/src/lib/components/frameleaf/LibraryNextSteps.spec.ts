import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextStepsOffered, offerNextSteps, resetNextSteps } from '$lib/components/timeline/next-steps.svelte';
import LibraryNextSteps from './LibraryNextSteps.svelte';

const auth = vi.hoisted(() => ({ authenticated: true, user: { id: 'admin', isAdmin: true } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));

/** Review finding 98: setup promises Library Care, Cloud backup and Activity; the library delivers them once. */
describe('LibraryNextSteps', () => {
  beforeEach(() => {
    localStorage.clear();
    resetNextSteps();
    auth.user = { id: 'admin', isAdmin: true };
  });

  it('shows nothing until setup has offered it', () => {
    render(LibraryNextSteps);
    expect(screen.queryByTestId('frameleaf-next-steps')).not.toBeInTheDocument();
  });

  it('links Library Care, Cloud backup and Activity for the administrator who finished setup', () => {
    offerNextSteps('admin');
    render(LibraryNextSteps);
    const card = screen.getByTestId('frameleaf-next-steps');
    expect(card).toHaveAccessibleName('frameleaf_next_steps_title');
    const links = [...card.querySelectorAll<HTMLAnchorElement>(':scope a')];
    expect(links.map((link) => link.dataset.step)).toEqual(['care', 'backup', 'activity']);
    expect(links[0].getAttribute('href')).toContain('area=care');
    expect(links[1].getAttribute('href')).toContain('section=cloud-backup');
    expect(links[2].getAttribute('href')).toBe('/activity');
  });

  it('leaves on Dismiss and is not offered again', async () => {
    offerNextSteps('admin');
    render(LibraryNextSteps);
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_next_steps_dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('frameleaf-next-steps')).not.toBeInTheDocument());
    expect(nextStepsOffered('admin')).toBe(false);
  });

  it('is not shown to an account that does not run the server', () => {
    offerNextSteps('member');
    auth.user = { id: 'member', isAdmin: false };
    render(LibraryNextSteps);
    expect(screen.queryByTestId('frameleaf-next-steps')).not.toBeInTheDocument();
  });
});
