import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import OcrButton from '$lib/components/asset-viewer/OcrButton.svelte';
import { ocrManager } from '$lib/stores/ocr.svelte';
import en from '../../../../../i18n/en.json';

beforeAll(() => addMessages('dev', en));
beforeEach(() => ocrManager.clear());
afterEach(() => ocrManager.clear());

it('marks the overlay button active only while it displays OCR regions', async () => {
  render(TestWrapper, { component: OcrButton, componentProps: {} });
  const button = screen.getByRole('button', { name: en.text_recognition });
  expect(button).not.toHaveClass('bg-primary');
  await userEvent.click(button);
  expect(ocrManager.showOverlay).toBe(true);
  expect(button).toHaveClass('bg-primary');
  await userEvent.click(button);
  expect(ocrManager.showOverlay).toBe(false);
  expect(button).not.toHaveClass('bg-primary');
});
