import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-922: Your preferences › Shared links against a mocked server. The page starts on Never when nobody set a
 * default, and choosing a length waits for the Save bar.
 */
test.describe('Shared link defaults (FL-922)', () => {
  test('chooses how long new links last', async ({ context, page }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await page.goto('/user-settings?area=preferences&section=shared-link-defaults');

    await expect(page.getByRole('heading', { name: 'Shared links' })).toBeVisible();
    const select = page.getByRole('combobox', { name: 'New links expire after' });
    await expect(select).toHaveValue('none');
    await expect(page.getByText('New links stay open until you delete them.')).toBeVisible();

    await select.selectOption('7');
    await expect(page.getByText('Each new link closes 7 days after you make it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });
});
