import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BackgroundWorkEveryday from '$lib/components/frameleaf/jobs/BackgroundWorkEveryday.svelte';
import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';

const flags = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: flags }));

const mount = (job: Record<string, unknown>) => {
  const store = { draft: { job }, baseline: { job: { ...job } }, changes: [] } as unknown as SystemConfigDraftStore;
  render(BackgroundWorkEveryday, {
    rows: [],
    store,
    href: () => '#',
    computersHref: '#',
    overnightHref: '#',
    onPauseAll: vi.fn(),
    onResumeAll: vi.fn(),
    onFeature: vi.fn(),
    onTask: vi.fn(),
    onAdvanced: vi.fn(),
    onRetry: vi.fn(),
  });
  return job;
};

beforeAll(async () => {
  register('en', () => Promise.resolve(en));
  await init({ fallbackLocale: 'en', initialLocale: 'en' });
  await waitLocale();
});
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.listMlDestinations.mockResolvedValue([]);
  sdkMock.getMlWorkloadRoutes.mockResolvedValue({ routes: [] } as never);
});

describe('Jobs running at once (FL-1265)', () => {
  it('offers Automatic or 1-32 and writes the choice to the settings draft', async () => {
    flags.value = { jobCapacity: { value: 8, fromEnvironment: false } };
    const job = mount({ capacity: 0 });
    const control = screen.getByRole('combobox', { name: 'Jobs running at once' });
    expect(control).toHaveValue('0');
    expect(control).toBeEnabled();
    expect(screen.getAllByRole('option')).toHaveLength(33);
    expect(screen.getByText(/Up to 8 jobs at once right now/)).toBeInTheDocument();
    await fireEvent.change(control, { target: { value: '12' } });
    expect(job.capacity).toBe(12);
  });

  it('shows the number the server set and does not let it be changed', () => {
    flags.value = { jobCapacity: { value: 6, fromEnvironment: true } };
    mount({ capacity: 0 });
    const control = screen.getByRole('combobox', { name: 'Jobs running at once' });
    expect(control).toHaveValue('6');
    expect(control).toBeDisabled();
    expect(screen.getByText(/Set by the server to 6 jobs at once/)).toBeInTheDocument();
  });
});
