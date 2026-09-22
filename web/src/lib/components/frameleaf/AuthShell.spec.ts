import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import AuthShellHarness from '$lib/../test-data/frameleaf/AuthShellHarness.svelte';

describe('AuthShell', () => {
  it('renders the route-supplied heading and passes through the route content untouched', () => {
    render(AuthShellHarness, { title: 'Sign in' });

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('themes the panel from the shared shell theme rather than a component-local default', () => {
    const { container } = render(AuthShellHarness);

    expect(container.querySelector('.frameleaf')?.hasAttribute('data-theme')).toBe(true);
  });
});
