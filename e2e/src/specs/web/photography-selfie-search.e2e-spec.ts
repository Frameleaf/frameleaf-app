import { expect, test } from '@playwright/test';

// A synthetic gallery and image keep this browser contract independent of face inference and guest media.
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('a guest uploads after camera denial and keeps the matching gallery through the viewer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'photography-gallery:selfie-gallery',
      JSON.stringify({
        session: 'synthetic-gallery-session',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
      },
    });
  });
  const gallery = {
    revision: 'synthetic',
    title: 'Portrait collection',
    selfieSearch: true,
    mode: 'select-before-editing',
    checkoutAvailable: false,
    chapters: [],
    photos: ['first', 'second'].map((id, index) => ({
      id,
      number: index + 1,
      chapterId: null,
      status: 'selected',
      previewUrl: '/protected',
      thumbnailUrl: '/protected',
      canDownload: false,
      approvalRevisionId: null,
      blockedReason: 'order',
    })),
    recipient: { id: 'guest', name: 'Morgan', canDownload: false },
    choices: [] as string[],
    notes: [],
    rounds: [],
    orders: [],
    publication: { id: 'published', status: 'ready', completed: 2, total: 2, error: null },
    presentation: {
      template: 'portrait',
      coverCaptureId: null,
      coverTreatment: 'quiet',
      coverFocal: 50,
      font: 'editorial',
      palette: 'studio',
      spacing: 'comfortable',
      introduction: '',
      showChapters: false,
      showNumbers: true,
    },
    pricing: {
      currency: 'CAD',
      includedCount: 0,
      additionalPrice: 0,
      collectionPrice: null,
      bundles: [],
      terms: '',
      selectionDeadline: null,
    },
    brand: {
      name: 'Portrait Studio',
      tagline: '',
      email: '',
      phone: '',
      color: '#577059',
      background: '#f5f3ed',
      textColor: '#263329',
      font: 'editorial',
      logoUrl: null,
    },
  };
  // Keep every request in this browser fixture synthetic, including application bootstrap.
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/server/config') {
      await route.fulfill({
        json: { maintenanceMode: false, isInitialized: true, loginPageMessage: '', mapTileUrl: '' },
      });
    } else if (path.startsWith('/api/server/')) {
      await route.fulfill({ json: {} });
    } else {
      await route.fulfill({ status: 401, json: { message: 'Unauthenticated' } });
    }
  });
  let searches = 0;
  await page.route('**/api/photography/galleries/selfie-gallery**', async (route) => {
    const request = route.request();
    expect(request.headers()['x-photography-session']).toBe('synthetic-gallery-session');
    expect(request.headers().authorization).toBeUndefined();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/selfie-search')) {
      searches++;
      expect(request.headers()['content-type']).toContain('multipart/form-data');
      await route.fulfill({ json: { captureIds: ['first'] } });
    } else if (path.endsWith('/choices')) {
      gallery.choices = request.postDataJSON().captureIds;
      await route.fulfill({ json: gallery });
    } else if (path.includes('/photos/')) {
      await route.fulfill({ contentType: 'image/jpeg', body: tinyPng });
    } else {
      await route.fulfill({ json: gallery });
    }
  });
  await page.goto('/photography/gallery/selfie-gallery');
  await page.getByRole('button', { name: 'Find my photos', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Find my photos' });
  await sheet.getByRole('button', { name: 'Take a selfie' }).click();
  await expect(sheet.getByText('The camera is unavailable. You can upload a selfie instead.')).toBeVisible();
  await sheet
    .getByLabel('Upload a selfie')
    .setInputFiles({ name: 'selfie.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(sheet.getByRole('button', { name: 'Find my photos', exact: true })).toBeDisabled();
  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Find my photos', exact: true }).click();
  await expect(page.getByText('1 photo of you', { exact: true })).toBeVisible();
  await expect(sheet).toBeHidden();
  expect(searches).toBe(1);
  await expect(page.getByRole('button', { name: 'View photo 2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View photo 1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Photo 1', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.getByText('1 photo of you', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add photo 1 to favourites', exact: true }).click();
  await expect.poll(() => gallery.choices).toEqual(['first']);
  await page.getByRole('button', { name: 'Show all photos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View photo 2', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
