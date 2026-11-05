import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { siteRequest } from '$lib/frameleaf/photography/workflow-api';
import PhotographyPublishing from './PhotographyPublishing.svelte';

vi.mock('$lib/frameleaf/photography/workflow-api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/workflow-api')>()),
  siteRequest: vi.fn(),
}));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { externalDomain: 'https://photos.cedarandlight.ca' } },
}));

const site = { enabled: false, domain: '', slug: 'cedar-and-light', title: 'Cedar & Light' };
const stored = (patch = {}) =>
  ({ revision: 's1', site: { ...site, ...patch }, url: 'https://x/studio/cedar-and-light', inquiries: [] }) as never;

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.mocked(siteRequest).mockReset();
  vi.mocked(siteRequest).mockImplementation((method = 'GET', body?: unknown) =>
    Promise.resolve(method === 'PUT' ? stored((body as { site: object }).site) : stored()),
  );
});

it('publishes the studio website with its domain, keeping the rest of the site', async () => {
  render(PhotographyPublishing);
  expect(await screen.findByText('Not published')).toBeInTheDocument();
  expect(screen.getByText('https://photos.cedarandlight.ca')).toBeInTheDocument();
  await fireEvent.input(screen.getByRole('textbox', { name: /Domain/ }), {
    target: { value: 'Photos.CedarAndLight.ca' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Publish studio website' }));
  await waitFor(() =>
    expect(siteRequest).toHaveBeenCalledWith('PUT', {
      expectedRevision: 's1',
      site: expect.objectContaining({ enabled: true, domain: 'photos.cedarandlight.ca', slug: 'cedar-and-light' }),
    }),
  );
  expect(await screen.findByText('Published')).toBeInTheDocument();
});

it('shows Cloud Pro at US$29.99 a month and leads to the plan', async () => {
  render(PhotographyPublishing);
  await fireEvent.click(await screen.findByRole('button', { name: /^Cloud Pro/ }));
  expect(screen.getByText('US$29.99 / month')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Managed publishing' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Choose Cloud Pro' })).toHaveAttribute(
    'href',
    expect.stringContaining('cloud-plan'),
  );
});
