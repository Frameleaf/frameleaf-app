import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { loadBrand } from '$lib/frameleaf/photography/api';
import { siteRequest } from '$lib/frameleaf/photography/workflow-api';
import PhotographyWebsite from './PhotographyWebsite.svelte';

vi.mock('$lib/frameleaf/photography/api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/api')>()),
  loadBrand: vi.fn(),
}));
vi.mock('$lib/frameleaf/photography/workflow-api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/workflow-api')>()),
  siteRequest: vi.fn(),
  workflowRequest: vi.fn(),
}));

const site = {
  enabled: false,
  template: 'editorial',
  colours: 'brand',
  coverFocal: 50,
  cover: null,
  sections: [{ id: 'cover', on: true }],
  title: 'Cedar & Light',
  about: '',
  contact: '',
  collections: [],
  packages: [],
  testimonials: [],
  faq: [],
  trustedBy: [],
  slug: 'cedar-and-light',
  domain: '',
  seoTitle: '',
  seoDescription: '',
};

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.mocked(siteRequest).mockResolvedValue({
    revision: 's1',
    site,
    url: 'https://x/studio/cedar',
    inquiries: [],
  } as never);
  vi.mocked(loadBrand).mockResolvedValue({ revision: 'b1', brand: { name: 'Cedar & Light' } } as never);
});

it('puts Publish, the save state and Save website in the page header when there is one', async () => {
  const header = document.createElement('div');
  document.body.append(header);
  render(PhotographyWebsite, { shoots: [], headerActions: header });
  expect(await within(header).findByRole('switch', { name: 'Publish studio website' })).toBeInTheDocument();
  expect(within(header).getByRole('button', { name: 'Save website' })).toBeInTheDocument();
  header.remove();
});

it('keeps them on the page without a header', async () => {
  render(PhotographyWebsite, { shoots: [] });
  expect(await screen.findByRole('switch', { name: 'Publish studio website' })).toBeInTheDocument();
});
