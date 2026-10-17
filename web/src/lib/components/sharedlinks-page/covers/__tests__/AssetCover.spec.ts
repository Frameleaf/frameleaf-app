import { fireEvent, render } from '@testing-library/svelte';
import AssetCover from '$lib/components/sharedlinks-page/covers/AssetCover.svelte';

describe('AssetCover component', () => {
  it('renders correctly', () => {
    const component = render(AssetCover, {
      alt: '123',
      preload: true,
      src: 'wee',
      class: 'asdf',
    });
    const img = component.getByTestId('album-image') as HTMLImageElement;
    expect(img.alt).toBe('123');
    expect(img.getAttribute('src')).toBe('wee');
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.className).toBe('size-full rounded-xl object-cover aspect-square asdf');
  });
});

it('tries a changed cover URL after the previous image failed', async () => {
  const component = render(AssetCover, { src: '/first', alt: 'Album' });
  await fireEvent.error(component.getByTestId('album-image'));
  expect(component.queryByTestId('album-image')).toBeNull();
  await component.rerender({ src: '/second', alt: 'New album' });
  expect(component.getByTestId('album-image')).toHaveAttribute('src', '/second');
  expect(component.getByTestId('album-image')).toHaveAttribute('alt', 'New album');
  await fireEvent.error(component.getByTestId('album-image'));
  expect(component.queryByTestId('album-image')).toBeNull();
  await component.rerender({ src: '/first', alt: 'Album' });
  expect(component.getByTestId('album-image')).toHaveAttribute('src', '/first');
});
