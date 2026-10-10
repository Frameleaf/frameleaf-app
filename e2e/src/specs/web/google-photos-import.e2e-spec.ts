import {
  createTakeoutArchive,
  createTakeoutImport,
  getTakeoutImport,
  getTakeoutItems,
  getTakeoutPairs,
  uploadTakeoutArchiveChunk,
  type LoginResponseDto,
} from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { makeRandomImage } from 'src/generators.js';
import { asBearerAuth, utils } from 'src/utils.js';

const zip = (entries: { name: string; data: Buffer }[]) => {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x8_00, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x8_00, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    parts.push(local, data);
    directory.push(central);
    offset += local.length + data.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, index, end]);
};

test.describe('Google Photos import (FL-144)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('verifies staged bytes and resumes an archive after a page reload', async ({ context, page }) => {
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const bytes = Buffer.from('original-archive-bytes-for-resume');
    const name = 'takeout-001.zip';
    const takeout = await createTakeoutImport({ takeoutCreateDto: { name: 'Family export' } }, auth);
    const archive = await createTakeoutArchive(
      { id: takeout.id, takeoutArchiveCreateDto: { name, size: bytes.length } },
      auth,
    );
    await uploadTakeoutArchiveChunk(
      { id: takeout.id, archiveId: archive.id, offset: 0, body: new Blob([bytes.subarray(0, 8).toString()]) },
      auth,
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/user-settings?area=backup&section=takeout&workflow=import&import=${takeout.id}`);
    const dialog = page.getByRole('dialog', { name: 'Import Google Photos' });
    await expect(dialog.getByRole('heading', { name: 'Stage' })).toBeVisible();
    await expect(dialog.getByText(name)).toBeVisible();
    await page.reload();
    await expect(dialog.getByText(name)).toBeVisible();

    const chooser = dialog.locator('input[type="file"]');
    const wrongBytes = Buffer.from(bytes);
    wrongBytes[0] = 'x'.codePointAt(0)!;
    await chooser.setInputFiles({ name, mimeType: 'application/zip', buffer: wrongBytes });
    await expect(dialog.getByRole('alert')).toHaveText(
      'The selected archive differs from the one being uploaded. Select the original archive to resume.',
    );
    const incompleteImport = await getTakeoutImport({ id: takeout.id }, auth);
    expect(incompleteImport.sources[0].received).toBe(8);

    await chooser.setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
    await expect(dialog.getByRole('status').filter({ hasText: 'Archives uploaded' })).toContainText(
      'Archives uploaded',
    );
    await expect
      .poll(async () => {
        const currentImport = await getTakeoutImport({ id: takeout.id }, auth);
        return currentImport.sources[0].received;
      })
      .toBe(bytes.length);
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('reviews conflicting sidecars and downloads the reconciled report', async ({ context, page }) => {
    test.setTimeout(60_000);
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const mediaPath = 'Takeout/Google Photos/Trip/IMG_1.png';
    const sidecar = (description: string) =>
      Buffer.from(JSON.stringify({ title: 'IMG_1.png', description, photoTakenTime: { timestamp: '1700000000' } }));
    const bytes = zip([
      { name: mediaPath, data: makeRandomImage() },
      { name: `${mediaPath}.json`, data: sidecar('First description') },
      { name: `${mediaPath}.supplemental-metadata.json`, data: sidecar('Chosen description') },
    ]);
    const takeout = await createTakeoutImport({ takeoutCreateDto: { name: 'Sidecar review' } }, auth);
    const archive = await createTakeoutArchive(
      { id: takeout.id, takeoutArchiveCreateDto: { name: 'takeout.zip', size: bytes.length } },
      auth,
    );
    await uploadTakeoutArchiveChunk(
      { id: takeout.id, archiveId: archive.id, offset: 0, body: new Blob([bytes]) },
      { ...auth, headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' } },
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/user-settings?area=backup&section=takeout&workflow=import&import=${takeout.id}`);
    const dialog = page.getByRole('dialog', { name: 'Import Google Photos' });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect
      .poll(
        async () => {
          const currentImport = await getTakeoutImport({ id: takeout.id }, auth);
          return currentImport.state;
        },
        { timeout: 30_000 },
      )
      .toBe('review');
    await expect(dialog.getByRole('group', { name: 'Import details' })).toBeVisible();
    await expect(
      dialog.getByText('Several metadata sidecars disagree. Choose one, or import without one.'),
    ).toBeVisible();

    const takeoutItems = await getTakeoutItems({ id: takeout.id }, auth);
    const item = takeoutItems.items[0];
    expect(item.candidates).toHaveLength(2);
    const chosen = item.candidates.find((candidate) => candidate.metadata.description === 'Chosen description');
    expect(chosen).toBeDefined();
    await dialog.getByLabel('Metadata sidecar').selectOption(chosen!.id);
    await dialog.getByRole('button', { name: 'Use this choice' }).click();
    await expect
      .poll(async () => {
        const currentItems = await getTakeoutItems({ id: takeout.id }, auth);
        return currentItems.items[0].state;
      })
      .toBe('ready');

    await page.reload();
    await expect(dialog.getByText('Chosen description', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Report' }).click();
    const jsonEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download report (JSON)' }).click();
    const jsonDownload = await jsonEvent;
    expect(jsonDownload.suggestedFilename()).toMatch(/^google-photos-import-\d{4}-\d{2}-\d{2}-report\.json$/);
    const report = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
    expect(report.import.id).toBe(takeout.id);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ path: 'Trip/IMG_1.png', state: 'ready', sidecarId: chosen!.id });
    expect(report.items[0].metadata.description).toBe('Chosen description');

    const csvEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download report (CSV)' }).click();
    const csvDownload = await csvEvent;
    expect(csvDownload.suggestedFilename()).toMatch(/-report\.csv$/);
    expect(await readFile(await csvDownload.path(), 'utf8')).toContain('Trip/IMG_1.png,takeout.zip,image,ready,');
  });

  test('reviews Live Photo pairs from split archives and keeps each decision after reload', async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const takeout = await createTakeoutImport({ takeoutCreateDto: { name: 'Live Photo review' } }, auth);
    const stills = zip(
      ['Trip', 'Other'].map((folder) => ({
        name: `Takeout/Google Photos/${folder}/IMG_1.png`,
        data: makeRandomImage(),
      })),
    );
    const clips = zip(
      ['Trip', 'Other'].map((folder) => ({
        name: `Takeout/Google Photos/${folder}/IMG_1.MP4`,
        data: Buffer.from(`motion in ${folder}`),
      })),
    );
    for (const [name, bytes] of [
      ['photos.zip', stills],
      ['videos.zip', clips],
    ] as const) {
      const archive = await createTakeoutArchive(
        { id: takeout.id, takeoutArchiveCreateDto: { name, size: bytes.length } },
        auth,
      );
      await uploadTakeoutArchiveChunk(
        { id: takeout.id, archiveId: archive.id, offset: 0, body: new Blob([bytes]) },
        { ...auth, headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' } },
      );
    }

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/user-settings?area=backup&section=takeout&workflow=import&import=${takeout.id}`);
    const dialog = page.getByRole('dialog', { name: 'Import Google Photos' });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect
      .poll(
        async () => {
          const currentImport = await getTakeoutImport({ id: takeout.id }, auth);
          return currentImport.state;
        },
        { timeout: 30_000 },
      )
      .toBe('review');

    const { items } = await getTakeoutItems({ id: takeout.id }, auth);
    expect(items).toHaveLength(4);
    const byPath = new Map(items.map((item) => [item.path, item]));
    for (const folder of ['Trip', 'Other']) {
      expect(byPath.get(`${folder}/IMG_1.png`)?.source).toBe('photos.zip');
      expect(byPath.get(`${folder}/IMG_1.MP4`)?.source).toBe('videos.zip');
    }
    const { pairs, total } = await getTakeoutPairs({ id: takeout.id }, auth);
    expect(total).toBe(2);
    for (const pair of pairs) {
      const folder = pair.photoPath.split('/', 1)[0];
      expect(pair.photoItemId).toBe(byPath.get(`${folder}/IMG_1.png`)?.id);
      expect(pair.videoItemId).toBe(byPath.get(`${folder}/IMG_1.MP4`)?.id);
      expect(pair.state).toBe('suggested');
    }

    const tabs = dialog.getByRole('group', { name: 'Import details' });
    await tabs.getByRole('button', { name: 'Live Photos' }).click();
    const trip = dialog.locator('li').filter({ hasText: 'Trip/IMG_1.png' });
    const other = dialog.locator('li').filter({ hasText: 'Other/IMG_1.png' });
    await expect(trip.getByText('Trip/IMG_1.MP4')).toBeVisible();
    await expect(other.getByText('Other/IMG_1.MP4')).toBeVisible();
    await trip.getByRole('button', { name: 'These belong together' }).click();
    await other.getByRole('button', { name: 'Keep separate' }).click();
    await expect
      .poll(async () => {
        const currentPairs = await getTakeoutPairs({ id: takeout.id }, auth);
        return Object.fromEntries(currentPairs.pairs.map((pair) => [pair.photoPath, pair.state]));
      })
      .toEqual({ 'Other/IMG_1.png': 'skipped', 'Trip/IMG_1.png': 'approved' });

    await page.reload();
    await tabs.getByRole('button', { name: 'Live Photos' }).click();
    await expect(trip.getByText('Linked together')).toBeVisible();
    await expect(other.getByText('Kept separate')).toBeVisible();
  });
});
