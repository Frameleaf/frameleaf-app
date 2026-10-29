import type { Page } from '@playwright/test';

/**
 * FL-655: the fixtures are Frameleaf servers too old to sign in from the browser (they answer the
 * ping but have no extension sign-in), so the extension offers "Use a key instead": the paste-key
 * path these specs exercise.
 */
export async function connectWithKey(page: Page, address: string, key: string) {
  await page.getByLabel('Server address').fill(address);
  await page
    .getByRole('switch', { name: /Allow a local server without HTTPS/ })
    .check();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Use a key instead' }).click();
  await page.getByLabel('Key from Frameleaf', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}
