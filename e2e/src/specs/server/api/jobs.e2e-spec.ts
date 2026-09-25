import {
  AssetJobName,
  LoginResponseDto,
  QueueCommand,
  QueueName,
  getAssetInfo,
  getQueue,
  runAssetJobs,
  updateConfig,
} from '@immich/sdk';
import { cpSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, testAssetDir, utils } from 'src/utils.js';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('/jobs', () => {
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
  });

  describe('PUT /jobs', () => {
    afterEach(async () => {
      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.FaceDetection, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.SmartSearch, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.DuplicateDetection, {
        command: QueueCommand.Resume,
        force: false,
      });

      const config = await utils.getSystemConfig(admin.accessToken);
      config.machineLearning.duplicateDetection.enabled = false;
      config.machineLearning.enabled = false;
      config.metadata.faces.import = false;
      config.machineLearning.clip.enabled = false;
      await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
    });

    it('should queue metadata extraction for missing assets', async () => {
      const path = `${testAssetDir}/formats/raw/Nikon/D700/philadelphia.nef`;

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Pause,
        force: false,
      });

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.make).toBeNull();
      }

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Empty,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.make).toBe('NIKON CORPORATION');
      }
    });

    it('should not re-extract metadata for existing assets', async () => {
      const path = `${testAssetDir}/temp/metadata/asset.jpg`;

      cpSync(`${testAssetDir}/formats/raw/Nikon/D700/philadelphia.nef`, path);

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.model).toBe('NIKON D700');
      }

      cpSync(`${testAssetDir}/formats/raw/Nikon/D80/glarus.nef`, path);

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.model).toBe('NIKON D700');
      }

      rmSync(path);
    });

    it('should queue thumbnail extraction for assets missing thumbs', async () => {
      const path = `${testAssetDir}/albums/nature/tanners_ridge.jpg`;

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Pause,
        force: false,
      });

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetBefore = await utils.getAssetInfo(admin.accessToken, id);
      expect(assetBefore.thumbhash).toBeNull();

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Empty,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetAfter = await utils.getAssetInfo(admin.accessToken, id);
      expect(assetAfter.thumbhash).not.toBeNull();
    });

    it('should not reload existing thumbnail when running thumb job for missing assets', async () => {
      const path = `${testAssetDir}/temp/thumbs/asset1.jpg`;

      cpSync(`${testAssetDir}/albums/nature/tanners_ridge.jpg`, path);

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetBefore = await utils.getAssetInfo(admin.accessToken, id);

      cpSync(`${testAssetDir}/albums/nature/notocactus_minimus.jpg`, path);

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Resume,
        force: false,
      });

      // This runs the missing thumbnail job
      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetAfter = await utils.getAssetInfo(admin.accessToken, id);

      // Asset 1 thumbnail should be untouched since its thumb should not have been reloaded, even though the file was changed
      expect(assetAfter.thumbhash).toEqual(assetBefore.thumbhash);

      rmSync(path);
    });
  });

  describe('POST /queues/:name/jobs/retry-failed (FL-71)', () => {
    let failed = 0;
    let assetId = '';

    beforeAll(async () => {
      // A thumbnail job that fails deterministically: an image whose original is removed from disk
      // after upload, then asked for new thumbnails. (An unreadable upload is not a failure: the
      // thumbnail handler skips an unsupported format.)
      const asset = await utils.createAsset(admin.accessToken);
      assetId = asset.id;
      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
      await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
      const { originalPath } = await getAssetInfo({ id: asset.id }, { headers: asBearerAuth(admin.accessToken) });
      await utils.deleteFile(originalPath);
      await runAssetJobs(
        { assetJobsDto: { assetIds: [asset.id], name: AssetJobName.RegenerateThumbnail } },
        { headers: asBearerAuth(admin.accessToken) },
      );
      await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
      const queue = await getQueue(
        { name: QueueName.ThumbnailGeneration },
        { headers: asBearerAuth(admin.accessToken) },
      );
      failed = queue.statistics.failed;
    });

    it('lists the failed job with the account that owns its asset and the server as its worker', async () => {
      expect(failed).toBeGreaterThan(0);
      const { status, body } = await request(app)
        .get(`/queues/${QueueName.ThumbnailGeneration}/jobs`)
        .query({ status: ['failed'] })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      // Failed jobs live in Redis and outlive the database reset between specs, so look at this spec's own job.
      const job = body.find((job: { data: { id?: string } }) => job.data.id === assetId);
      expect(job).toBeDefined();
      expect(job.account).toEqual({ id: admin.userId, name: expect.any(String) });
      expect(job.worker).toEqual({ kind: 'server', name: null });
    });

    it('is for administrators only', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.user1);
      const { status } = await request(app)
        .post(`/queues/${QueueName.ThumbnailGeneration}/jobs/retry-failed`)
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(status).toBe(403);
    });

    it('puts every failed job back in the queue and reports how many', async () => {
      expect(failed).toBeGreaterThan(0);
      const { status, body } = await request(app)
        .post(`/queues/${QueueName.ThumbnailGeneration}/jobs/retry-failed`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({ count: failed });
    });
  });
});
