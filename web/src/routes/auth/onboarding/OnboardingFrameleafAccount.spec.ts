import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import OnboardingFrameleafAccount from './OnboardingFrameleafAccount.svelte';

describe('OnboardingFrameleafAccount (FL-158)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
  });

  it('leaves loading when Frameleaf Cloud cannot be checked, stays skippable and can try again', async () => {
    sdkMock.getCloudStatus.mockRejectedValueOnce(new Error('down'));
    sdkMock.getCloudStatus.mockResolvedValue({ state: 'not-configured', configured: false } as never);
    render(OnboardingFrameleafAccount);

    expect(await screen.findByText(/could not be checked right now/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/not set up on this server/i)).toBeInTheDocument();
  });
});
