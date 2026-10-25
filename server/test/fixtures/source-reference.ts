import { sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { ChecksumAlgorithm } from 'src/enum.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';

/** Seed an approved reference binding; product registration stays disabled. */
export const bindSourceReference = async (db: Kysely<DB>, asset: { id: string; ownerId: string }) => {
  const session = await new SessionRepository(db).create({ userId: asset.ownerId, token: randomBytes(32) });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: asset.ownerId,
    installationId: randomUUID(),
    publicKey: randomBytes(32).toString('base64'),
    name: 'Reference fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const sources = new PhotoSourceRepository(db);
  const authority = { ownerId: asset.ownerId, sessionId: session.id };
  const source = await sources.create(authority, {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder',
    mode: 'copy',
    name: 'Reference fixture',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await sources.run(authority, source.id, { id: randomUUID(), maxBytes: 100, maxItems: 2 });
  const resource = await sources.plan(authority, source.id, run.id, {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 5,
  });
  const library = await new LibraryRepository(db).create({
    ownerId: asset.ownerId,
    name: 'Reference fixture',
    readOnly: true,
    importPaths: [],
    exclusionPatterns: [],
  });
  const originalPath = `frameleaf-source://${source.id}/${resource.resourceKey}`;
  await db
    .updateTable('asset')
    .set({
      originalPath,
      isExternal: true,
      libraryId: library.id,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(originalPath).digest(),
    })
    .where('id', '=', asset.id)
    .execute();
  await db
    .updateTable('photo_source_resource')
    .set({ assetId: asset.id, state: 'verified', verifiedAt: new Date() })
    .where('id', '=', resource.id)
    .execute();
  await sql`UPDATE photo_source SET mode='reference' WHERE id=${source.id}::uuid`.execute(db);
  await db
    .insertInto('source_original')
    .values({
      assetId: asset.id,
      resourceId: resource.id,
      scopeFingerprint: source.scopeFingerprint,
      authorizationEpoch: device.authorizationEpoch,
    })
    .execute();
  return { resource, sourceReference: { resourceId: resource.id, version: resource.version, sha256: 'd'.repeat(64) } };
};
