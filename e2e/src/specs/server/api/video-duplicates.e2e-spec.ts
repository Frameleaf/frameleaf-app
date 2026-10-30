import { getAssetDuplicates, LoginResponseDto, QueueCommand, QueueName, updateConfig } from '@frameleaf/sdk';
import { readFileSync } from 'node:fs';
import { asBearerAuth, utils } from 'src/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';

const clip = (name: string) => ({
  filename: name,
  bytes: readFileSync(new URL(`../../../fixtures/frameleaf-media/${name}`, import.meta.url)),
});

const byId = (a: string, b: string) => a.localeCompare(b);

/**
 * FL-651 with real videos (fixtures/frameleaf-media/SOURCE.md): two 24 s clips open and close on
 * the same 4 s title card with different footage between, and a re-encoded 20 s trim of the first.
 * The stack has no CLIP model, so all three get the same seeded embedding: the preview calls every
 * pair a look-alike and only the timelines of the seek-bar filmstrips can keep them apart.
 */
describe('video look-alikes', () => {
  let admin: LoginResponseDto;
  let first: string;
  let second: string;
  let trimmed: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [first, second, trimmed] = await Promise.all(
      ['title-screen-a.mp4', 'title-screen-b.mp4', 'title-screen-a-trimmed.mp4'].map(async (name) => {
        const { id } = await utils.createAsset(admin.accessToken, { assetData: clip(name) });
        return id;
      }),
    );
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

    const config = await utils.getSystemConfig(admin.accessToken);
    config.machineLearning.enabled = true;
    await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });

    const db = await utils.connectDatabase();
    const { rows } = await db.query<{ dimension: number }>(
      `SELECT atttypmod AS dimension FROM pg_attribute WHERE attrelid = 'smart_search'::regclass AND attname = 'embedding'`,
    );
    const embedding = `[${[1, ...Array.from({ length: rows[0].dimension - 1 }, () => 0)].join(',')}]`;
    await db.query(`INSERT INTO smart_search ("assetId", embedding) SELECT unnest($1::uuid[]), $2::vector`, [
      [first, second, trimmed],
      embedding,
    ]);

    // fingerprints first; each finished fingerprint queues that video's duplicate check
    await utils.queueCommand(admin.accessToken, QueueName.VideoDuplicateDetection, {
      command: QueueCommand.Start,
      force: true,
    });
    await utils.waitForQueueFinish(admin.accessToken, 'videoDuplicateDetection');
    await utils.waitForQueueFinish(admin.accessToken, 'duplicateDetection');
  });

  it('keeps apart two videos that only share a title screen, and groups a trim with its source', async () => {
    const groups = await getAssetDuplicates({ headers: asBearerAuth(admin.accessToken) });
    expect(groups.map(({ assets }) => assets.map(({ id }) => id).toSorted(byId))).toEqual([
      [first, trimmed].toSorted(byId),
    ]);
  });
});
