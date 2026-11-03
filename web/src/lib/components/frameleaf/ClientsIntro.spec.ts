import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import ClientsIntro from './ClientsIntro.svelte';

describe('ClientsIntro (owner, October 28)', () => {
  beforeAll(() => addMessages('dev', en));

  it('introduces Clients with the four points, the way back and the note', () => {
    render(ClientsIntro, { onStart: vi.fn() });

    const region = screen.getByRole('region', { name: 'Clients' });
    expect(within(region).getByRole('heading', { level: 1, name: 'Clients' })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/photos');
    expect(
      within(region).getByText(
        'For photographers who work for clients: shoots, proofing and delivery in one place, on your own server.',
      ),
    ).toBeInTheDocument();
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('strong')?.textContent),
    ).toEqual(['Shoots', 'Proof galleries', 'Delivery', 'Your website']);
    expect(within(region).getByText(en.frameleaf_clients_intro_note)).toBeInTheDocument();
  });

  it('starts Clients from its one primary action, and waits while it is saved', async () => {
    const onStart = vi.fn();
    const view = render(ClientsIntro, { onStart });

    await fireEvent.click(screen.getByRole('button', { name: 'Start using Clients' }));
    expect(onStart).toHaveBeenCalledOnce();

    await view.rerender({ onStart, starting: true });
    expect(screen.getByRole('button', { name: 'Start using Clients' })).toBeDisabled();
  });
});
