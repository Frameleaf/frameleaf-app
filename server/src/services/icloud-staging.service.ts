import { Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, statfs, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { ICloudConnection, ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { isWithinDirectory } from 'src/utils/icloud-sync.js';

@Injectable()
export class ICloudStagingService {
  constructor(
    private repository: ICloudSyncRepository,
    private transport: ICloudTransportRepository,
    private libraries: LibraryRepository,
  ) {}

  async root(): Promise<string> {
    const configured = process.env.IMMICH_ICLOUD_STAGING_PATH;
    if (!configured) {
      throw new Error('staging_not_configured');
    }
    const root = resolve(configured);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await realpath(root)) !== root || !(await lstat(root).then((result) => result.isDirectory()))) {
      throw new Error('staging_symlink');
    }
    const permissions = await lstat(root);
    if ((permissions.mode & 0o077) !== 0 || (process.getuid && permissions.uid !== process.getuid())) {
      throw new Error('staging_permissions_invalid');
    }
    const roots = [
      StorageCore.getMediaLocation(),
      ...(await this.libraries.getAll().then((result) => result.flatMap(({ importPaths }) => importPaths))),
    ];
    for (const path of roots) {
      const canonical = await realpath(path).catch(() => resolve(path));
      if (isWithinDirectory(canonical, root) || isWithinDirectory(root, canonical)) {
        throw new Error('staging_overlaps_library');
      }
    }
    return root;
  }

  async download(connection: ICloudConnection, resource: ICloudResource): Promise<string> {
    const root = await this.root();
    const directory = join(root, resource.id);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    return this.downloadInto(connection, resource, directory);
  }

  private async downloadInto(
    connection: ICloudConnection,
    resource: ICloudResource,
    directory: string,
  ): Promise<string> {
    if ((await realpath(directory)) !== directory || !(await lstat(directory).then((result) => result.isDirectory()))) {
      throw new Error('staging_symlink');
    }
    const permissions = await lstat(directory);
    if ((permissions.mode & 0o077) !== 0 || (process.getuid && permissions.uid !== process.getuid())) {
      throw new Error('staging_permissions_invalid');
    }
    const target = join(directory, 'complete');
    if (resource.stagingPath && resource.stagingPath !== target) {
      throw new Error('staging_path_invalid');
    }
    if (
      await lstat(target)
        .then((stat) => stat.isFile() && !stat.isSymbolicLink())
        .catch(() => false)
    ) {
      return target;
    }
    const free = await statfs(directory, { bigint: true });
    const watermark = BigInt(process.env.IMMICH_ICLOUD_FREE_SPACE_BYTES ?? 1024 ** 3);
    if (free.bavail * free.bsize < BigInt(resource.expectedSize) + watermark) {
      throw new Error('staging_disk_full');
    }
    const temporary = join(directory, `${resource.leaseToken}.partial`);
    if (!(await this.repository.progress(resource, { status: 'staging', stagingPath: target }))) {
      throw new Error('lease_changed');
    }
    // Only the current resource lease may retire abandoned partials; complete is never included.
    const abandoned = await readdir(directory);
    if (abandoned.length > 32) {
      throw new Error('staging_requires_cleanup');
    }
    for (const name of abandoned) {
      if (/^[\da-f-]{36}\.partial$/.test(name) && name !== `${resource.leaseToken}.partial`) {
        await unlink(join(directory, name)).catch((error) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
      }
    }
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const controller = new AbortController();
    let checking = false;
    const heartbeat = setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      void this.repository
        .get(connection.id)
        .then(async (current) => {
          if (current?.state !== 'connected' || !(await this.repository.progress(resource, { status: 'staging' }))) {
            controller.abort();
          }
        })
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    let received = 0;
    try {
      const response = await this.repository.withSession(connection.id, connection.ownerId, async (current) => {
        if (current.state !== 'connected') {
          throw new Error('connection_paused');
        }
        const response = await this.transport.download(
          {
            session: await this.transport.decodeSession(current.id, current.encryptedSession),
            library: resource.library,
            recordId: resource.recordId,
            resourceKey: resource.resourceKey,
            expectedFingerprint: resource.fingerprint,
          },
          controller.signal,
        );
        return { value: response, encryptedSession: await this.transport.encodeSession(current.id, response.session) };
      });
      if (response.fingerprint !== resource.fingerprint || response.size !== resource.expectedSize) {
        response.stream.destroy();
        throw new Error('source_identity_changed');
      }
      const bound = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > resource.expectedSize ? new Error('source_size_mismatch') : null, chunk);
        },
      });
      await pipeline(response.stream, bound, file.createWriteStream({ autoClose: true, flush: true }), {
        signal: controller.signal,
      });
      if (received !== resource.expectedSize) {
        throw new Error('source_size_mismatch');
      }
      if (!(await this.repository.progress(resource, { status: 'staging' }))) {
        throw new Error('lease_changed');
      }
      await link(temporary, target);
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return target;
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      await file.close();
      await unlink(temporary).catch(() => {});
    }
  }

  async cleanup(resource: ICloudResource): Promise<void> {
    const root = await this.root();
    const expected = join(root, resource.id, 'complete');
    if (resource.stagingPath !== expected) {
      return;
    }
    if ((await realpath(join(root, resource.id))) !== join(root, resource.id)) {
      throw new Error('staging_symlink');
    }
    await unlink(expected).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}
