import {
  createTakeoutArchive,
  createTakeoutImport,
  getTakeoutImport,
  getTakeoutItems,
  getTakeoutPairs,
  uploadTakeoutArchiveChunk,
  type LoginResponseDto,
} from '@frameleaf/sdk';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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

const waitForState = (auth: { headers: Record<string, string> }, id: string, state: string, timeout = 30_000) =>
  expect
    .poll(
      async () => {
        const result = await getTakeoutImport({ id }, auth);
        return result.state;
      },
      { timeout },
    )
    .toBe(state);

const sidecar = (description: string) =>
  Buffer.from(JSON.stringify({ title: 'IMG_1.png', description, photoTakenTime: { timestamp: '1700000000' } }));

test.describe('Google Photos import (FL-144)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  const openImport = async (context: BrowserContext, page: Page, id: string) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/user-settings?area=backup&section=takeout&workflow=import&import=${id}`);
    return page.getByRole('dialog', { name: 'Import from Google Photos' });
  };

  test('verifies staged bytes, resumes an archive after a page reload, then checks by itself', async ({
    context,
    page,
  }) => {
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

    const dialog = await openImport(context, page, takeout.id);
    await expect(dialog.getByText('The upload stopped at 0 of 1 files')).toBeVisible();
    await expect(dialog.getByText('Keep this page open until the upload finishes')).toBeVisible();
    await page.reload();
    await expect(dialog.getByText('The upload stopped at 0 of 1 files')).toBeVisible();

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
    await expect
      .poll(async () => {
        const result = await getTakeoutImport({ id: takeout.id }, auth);
        return result.sources[0].received;
      })
      .toBe(bytes.length);
    // The check starts by itself once every file is in; nothing to press.
    await expect
      .poll(async () => {
        const result = await getTakeoutImport({ id: takeout.id }, auth);
        return result.phase;
      })
      .not.toBe('sources');
  });

  test('picks the most likely details, and lets the owner choose instead', async ({ context, page }) => {
    test.setTimeout(90_000);
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const mediaPath = 'Takeout/Google Photos/Trip/IMG_1.png';
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

    // Every archive is on the server, so opening the import starts the check.
    const dialog = await openImport(context, page, takeout.id);
    await waitForState(auth, takeout.id, 'review');

    const { items } = await getTakeoutItems({ id: takeout.id }, auth);
    const item = items[0];
    expect(item.candidates).toHaveLength(2);
    expect(item.sidecarId).not.toBeNull();
    const chosen = item.candidates.find((candidate) => candidate.metadata.description === 'Chosen description')!;

    await dialog.getByRole('switch', { name: /Let me choose for 1 photo/ }).click();
    await dialog.getByRole('button', { name: 'Import 1 photo' }).click();
    await waitForState(auth, takeout.id, 'completed', 60_000);

    await dialog.getByRole('radio', { name: /Chosen description/ }).check();
    await dialog.getByRole('button', { name: 'Add 1 photo' }).click();
    await expect
      .poll(
        async () => {
          const result = await getTakeoutItems({ id: takeout.id }, auth);
          return result.items[0];
        },
        {
          timeout: 60_000,
        },
      )
      .toMatchObject({ state: 'imported', sidecarId: chosen.id });
    await expect(dialog.getByText('1 photo added')).toBeVisible({ timeout: 30_000 });

    const csvEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download report' }).click();
    const csvDownload = await csvEvent;
    expect(csvDownload.suggestedFilename()).toMatch(/^google-photos-import-\d{4}-\d{2}-\d{2}-report\.csv$/);
    expect(await readFile(await csvDownload.path(), 'utf8')).toContain('Trip/IMG_1.png,takeout.zip,image,imported,');
  });

  test('links Live Photos from split archives without asking', async ({ context, page }) => {
    test.setTimeout(60_000);
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const takeout = await createTakeoutImport({ takeoutCreateDto: { name: 'Live Photos' } }, auth);
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

    const dialog = await openImport(context, page, takeout.id);
    await waitForState(auth, takeout.id, 'review');

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
      expect(pair.state).toBe('approved');
    }
    const live = dialog.locator('dl div').filter({ hasText: 'Live Photos' });
    await expect(live.locator('dd')).toContainText('2');
  });
});
