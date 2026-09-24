import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import PublicShellFrame from './PublicShellFrame.svelte';

const children = createRawSnippet(() => ({ render: () => '<form aria-label="Password prompt"></form>' }));

beforeEach(() => {
  addMessages('dev', en);
});

describe('PublicShellFrame', () => {
  it('draws a public state inside the brand header and the "Go to Frameleaf" footer', () => {
    render(PublicShellFrame, { hero: true, children });

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toContainElement(screen.getByRole('link', { name: 'Go to Frameleaf' }));
    const main = screen.getByRole('main');
    expect(main).toHaveClass('pv-hero');
    expect(main).toContainElement(screen.getByRole('form', { name: 'Password prompt' }));
  });

  it('draws an open share as a plain page, not a centred state', () => {
    render(PublicShellFrame, { children });
    expect(screen.getByRole('main')).not.toHaveClass('pv-hero');
  });
});
