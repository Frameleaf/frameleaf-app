import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import CloudProcessingSettings from './CloudProcessingSettings.svelte';

const choice = vi.hoisted(() => ({
  draft: {} as Record<string, unknown>,
  baseline: {} as Record<string, unknown>,
  dirty: false,
  stale: false,
  loading: false,
  saving: false,
  error: null,
  notice: null,
  set: vi.fn(),
  follow: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  loadLatest: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => choice }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));

describe('CloudProcessingSettings (FL-1484)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    choice.draft = { 'cloudProcessing.enabled': true };
    choice.baseline = { 'cloudProcessing.enabled': true };
  });

  it('lets the person keep their photos at home', async () => {
    render(CloudProcessingSettings);

    const anywhere = screen.getByRole('button', { name: /At home or on Frameleaf Cloud/ });
    expect(anywhere).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Where your photos go' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /Only at home/ }));
    expect(choice.set).toHaveBeenCalledWith('cloudProcessing.enabled', false);
  });

  it('says what changes once the photos stay at home', () => {
    choice.draft = { 'cloudProcessing.enabled': false };
    render(CloudProcessingSettings);

    expect(screen.getByRole('button', { name: /Only at home/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'What changes for your photos' })).toBeInTheDocument();
    expect(screen.getByText('Search text is never sent to Frameleaf Cloud, whatever you choose.')).toBeInTheDocument();
  });
});
