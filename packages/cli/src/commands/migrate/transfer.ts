import { AssetMediaStatus } from '@frameleaf/sdk';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerClient } from 'src/commands/migrate/client';
import type { Controller } from 'src/commands/migrate/controller';
import type { Ledger } from 'src/commands/migrate/ledger';
import type { AssetRecord, MigrateOptions } from 'src/commands/migrate/types';
import { Queue } from 'src/queue';
import { hashFile } from 'src/utils';

const BATCH = 1000;

/**
 * Phase 3: for every asset not already on B, stream the original from A to a temp file,
 * compute its SHA-256 digest, upload to Frameleaf, and verify B's canonical
 * checksum against those bytes. Runs a fresh bounded
 * Queue per batch so task objects never accumulate. B's confirmed checksum is
 * persisted for the audit.
 */
export async function transfer(
  from: ServerClient,
  to: ServerClient,
  ledger: Ledger,
  options: MigrateOptions,
  controller: Controller,
  tmpDir: string,
) {
  controller.setPhase('transfer');
  const total = ledger.counts().assetsTotal;

  const transferOne = async (asset: AssetRecord) => {
    await controller.gate();
    if (controller.stopped) {
      return;
    }
    const tmp = join(tmpDir, `${asset.aId}.part`);
    try {
      const res = await from.downloadOriginal(asset.aId);
      if (!res.body) {
        throw new Error('empty response body from download');
      }
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
      const { size } = await stat(tmp);
      const hashes = await hashFile(tmp);
      const sha256 = Buffer.from(hashes.sha256, 'hex').toString('base64');
      const uploaded = await to.uploadAsset({
        filepath: tmp,
        size,
        filename: asset.filename,
        checksum: sha256,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        isFavorite: asset.isFavorite,
        visibility: asset.visibility,
      });
      const { checksum } = await to.getAssetInfo(uploaded.id);
      if (checksum !== sha256) {
        throw new Error(`destination checksum differs from uploaded bytes for ${asset.aId}`);
      }
      const via = uploaded.status === AssetMediaStatus.Duplicate ? 'duplicate' : 'upload';
      ledger.setAssetUploaded(asset.aId, uploaded.id, via, checksum);
    } finally {
      await rm(tmp, { force: true });
    }
  };

  for (;;) {
    await controller.gate();
    if (controller.stopped) {
      return;
    }
    const batch = ledger.nextUploadBatch(BATCH);
    if (batch.length === 0) {
      break;
    }
    const queue = new Queue<AssetRecord, void>(transferOne, { concurrency: options.concurrency, retry: 3 });
    for (const asset of batch) {
      void queue.push(asset);
    }
    await queue.drained();
    for (const task of queue.tasks) {
      if (task.status === 'failed') {
        ledger.setAssetError(task.data.aId, String(task.error));
      }
    }
    const counts = ledger.counts();
    controller.log(`uploaded ${counts.assetsUploaded}/${total} (${counts.assetsFailed} failed)`);
  }
}
