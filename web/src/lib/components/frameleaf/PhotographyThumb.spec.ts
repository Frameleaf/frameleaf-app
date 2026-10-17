import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PhotographyThumb from './PhotographyThumb.svelte';

it('shows a quiet placeholder instead of a broken image when the photo has no thumbnail', async () => {
  render(PhotographyThumb, { src: '/thumbnails/missing', alt: 'cabin-1.jpg' });
  const image = screen.getByRole('img', { name: 'cabin-1.jpg' });
  expect(image.tagName).toBe('IMG');
  await fireEvent.error(image);
  const placeholder = screen.getByRole('img', { name: 'cabin-1.jpg' });
  expect(placeholder.tagName).toBe('SPAN');
  expect(placeholder).toHaveClass('ph-thumb-missing');
});
