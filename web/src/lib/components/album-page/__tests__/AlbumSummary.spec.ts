import '@testing-library/jest-dom';
import { render } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { albumFactory } from '@test-data/factories/album-factory';
import AlbumSummary from '../AlbumSummary.svelte';

beforeAll(async () => {
  await init({ fallbackLocale: 'en-US' });
  register('en-US', () => import('$i18n/en.json'));
  await waitLocale('en-US');
});

it('updates the date range when the album gains or loses dated assets', async () => {
  const album = albumFactory.build({ startDate: null, endDate: null, assetCount: 1 });
  const view = render(AlbumSummary, { album });
  const details = view.getByTestId('album-details');
  expect(details).not.toHaveTextContent('2024');

  await view.rerender({ album: { ...album, startDate: '2024-06-10', endDate: '2024-06-11' } });
  expect(details).toHaveTextContent('2024');

  await view.rerender({ album });
  expect(details).not.toHaveTextContent('2024');
});
