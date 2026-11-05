import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import StudioDomainStatus from './StudioDomainStatus.svelte';

const site = (status: string, problem: string | null = null) => ({
  site: {
    domain: 'photos.cedarandlight.ca',
    slug: 'cedar-and-light',
    status,
    problem,
    records: [
      { type: 'CNAME', name: 'photos.cedarandlight.ca', value: 'sites.frameleaf.cloud' },
      { type: 'TXT', name: '_frameleaf.photos.cedarandlight.ca', value: 'frameleaf-site=abc123' },
    ],
    checkedAt: null,
  },
  problem: null,
});

beforeAll(async () => {
  await init({ fallbackLocale: 'en-US' });
  register('en-US', () => import('$i18n/en.json'));
  await waitLocale('en-US');
});
beforeEach(() => vi.clearAllMocks());

it('shows the two records exactly as Frameleaf Cloud gives them, and checks again', async () => {
  sdkMock.photographySiteDomain.mockResolvedValue(site('waiting_for_dns', 'txt_missing') as never);
  render(StudioDomainStatus, { domain: 'photos.cedarandlight.ca' });
  expect(await screen.findByText(/The TXT record isn't there yet\./)).toBeInTheDocument();
  expect(screen.getByText('sites.frameleaf.cloud')).toBeInTheDocument();
  expect(screen.getByText('_frameleaf.photos.cedarandlight.ca')).toBeInTheDocument();
  sdkMock.photographySiteDomain.mockResolvedValue(site('active') as never);
  await fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(
    await screen.findByText('photos.cedarandlight.ca is live. Visitors there see your studio website.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('leads to Cloud Pro when the domain needs the plan', async () => {
  sdkMock.photographySiteDomain.mockResolvedValue(site('needs_plan') as never);
  render(StudioDomainStatus, { domain: 'photos.cedarandlight.ca' });
  expect(await screen.findByRole('link', { name: 'Choose Cloud Pro' })).toHaveAttribute(
    'href',
    expect.stringContaining('cloud-plan'),
  );
});
