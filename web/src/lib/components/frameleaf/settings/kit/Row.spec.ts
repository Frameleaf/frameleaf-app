import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';

describe('kit Row', () => {
  it('draws no link unless one is given', () => {
    render(Row, { label: 'Mail server', help: 'Where email is handed over.' });

    expect(screen.getByText('Mail server')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('draws the link after the help, opening an outside guide in a new tab', () => {
    render(Row, {
      label: 'App password',
      help: 'A password made for one app.',
      link: { text: 'How to make one', href: 'https://example.test/app-passwords', external: true },
    });

    const link = screen.getByRole('link', { name: 'How to make one' });
    expect(link).toHaveAttribute('href', 'https://example.test/app-passwords');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByText('A password made for one app.').compareDocumentPosition(link)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('draws the choice the help says back in bold (ADMIN-P6)', () => {
    render(Row, {
      label: 'Search quality',
      lead: 'Balanced',
      help: 'Balanced: good results for everyday searches.',
    });

    const bold = screen.getByText('Balanced:');
    expect(bold.tagName).toBe('B');
    expect(bold.parentElement).toHaveTextContent('Balanced: good results for everyday searches.');
  });

  it('draws help that does not start with the choice as it is', () => {
    render(Row, { label: 'Search quality', lead: 'Custom', help: 'A model saved outside the choices.' });

    expect(screen.getByText('A model saved outside the choices.').tagName).toBe('P');
    expect(document.querySelector('b')).toBeNull();
  });

  it('keeps a link inside the app in the same tab', () => {
    render(Row, { label: 'Email', link: { text: 'Set up email', href: '/user-settings?area=notifications' } });

    expect(screen.getByRole('link', { name: 'Set up email' })).not.toHaveAttribute('target');
  });
});
