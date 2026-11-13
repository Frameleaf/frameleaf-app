import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ConnectUploadStartDto } from 'src/dtos/connect-media.dto.js';
import { LibraryScope } from 'src/enum.js';
import { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { connectRequestHash, ConnectMediaRepository } from 'src/repositories/connect-media.repository.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ScriptedQuery, scriptedKysely } from 'test/scripted-kysely.js';

const ownerId = randomUUID(),
  grantId = randomUUID(),
  albumId = randomUUID(),
  uploadId = randomUUID(),
  assetId = randomUUID();
const policy = {
  version: 1 as const,
  readAlbumIds: [albumId],
  writableAlbumIds: [albumId],
  writeWorkspaces: ['design' as const],
  allLibraryRead: false,
};
const auth: AuthDto = {
  user: { ...authStub.user1.user, id: ownerId },
  oauthApp: {
    grantId,
    clientId: randomUUID(),
    clientName: 'test',
    scopes: ['boards:upload', 'albums:write', 'library:read'],
    resource: 'https://library.example/api/connect',
    accessPolicy: policy,
    policyRevision: 0,
  },
};
const grant = {
  id: grantId,
  userId: ownerId,
  ...auth.oauthApp,
  accessExpiresAt: new Date(Date.now() + 3600_000),
  revokedAt: null,
};
const dto = ConnectUploadStartDto.schema.parse({
  requestId: 'design-123',
  albumId,
  workspace: 'design',
  filename: 'page.png',
  size: 10,
  sha256: 'a'.repeat(64),
  contentType: 'image/png',
  fileCreatedAt: '2026-11-13T00:00:00Z',
  fileModifiedAt: '2026-11-13T00:00:00Z',
});
const row = {
  id: uploadId,
  ownerId,
  offset: 10,
  expectedSize: 10,
  state: 'verified',
  expectedChecksum: Buffer.from(dto.sha256, 'hex'),
  verifiedChecksum: Buffer.from(dto.sha256, 'hex'),
  expiresAt: new Date(Date.now() + 86400_000),
  metadata: {
    publication: 'connect',
    connect: { grantId, actor: `oauth:${grantId}`, requestId: dto.requestId, albumId, workspace: 'design' },
    filename: dto.filename,
    fileCreatedAt: dto.fileCreatedAt,
    fileModifiedAt: dto.fileModifiedAt,
  },
  resultAssetId: null,
  resultStatus: null,
} as unknown as AssetUploadResource;
const published = { ...row, state: 'published' as const, resultAssetId: assetId, resultStatus: 'created' as const };
const admitted = ({ sql }: ScriptedQuery) => {
  if (sql.includes('from "user"')) return { rows: [{ ...auth.user, deletedAt: null, uploadsPaused: false }] };
  if (sql.includes('from "oauth_grant"')) return { rows: [grant] };
  if (sql.includes('from "album_user"')) return { rows: [{ albumId }] };
  if (sql.includes('from "album_asset"')) return { rows: [{ assetId }] };
  if (sql.includes('from "album"')) return { rows: [{ id: albumId }] };
  if (sql.includes('from "asset"') && (!sql.includes('for update') || sql.includes('connect_grant')))
    return { rows: [{ id: assetId }] };
  return { rows: [] };
};

describe('Connect media transactional authorization and receipts', () => {
  it('hashes canonical payloads identically without accepting changed metadata', () => {
    expect(connectRequestHash({ b: 2, a: 1 })).toEqual(connectRequestHash({ a: 1, b: 2 }));
    expect(connectRequestHash(dto)).not.toEqual(connectRequestHash({ ...dto, filename: 'other.png' }));
  });

  it.each([
    ['revoked grant', { ...grant, revokedAt: new Date() }],
    ['expired grant', { ...grant, accessExpiresAt: new Date(0) }],
    ['removed upload scope', { ...grant, scopes: ['library:read'] }],
    ['removed destination', { ...grant, accessPolicy: { ...policy, writableAlbumIds: [] } }],
    ['removed workspace', { ...grant, accessPolicy: { ...policy, writeWorkspaces: [] } }],
  ])('refuses %s even with a previously valid AuthDto', async (_name, currentGrant) => {
    const { db } = scriptedKysely((q) =>
      q.sql.includes('from "oauth_grant"') ? { rows: [currentGrant] } : admitted(q),
    );
    const publish = vi.fn();
    try {
      await expect(
        db
          .transaction()
          .execute((tx) =>
            new ConnectMediaRepository(db).commit(
              tx,
              auth,
              row,
              { requestId: dto.requestId, sha256: dto.sha256 },
              publish,
            ),
          ),
      ).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it.each([
    [
      'another grant',
      { ...row, metadata: { ...row.metadata, connect: { ...row.metadata.connect!, grantId: randomUUID() } } },
    ],
    [
      'another actor',
      { ...row, metadata: { ...row.metadata, connect: { ...row.metadata.connect!, actor: 'oauth:other' } } },
    ],
    ['incomplete bytes', { ...row, offset: 9 }],
    ['wrong digest', { ...row, verifiedChecksum: Buffer.alloc(32) }],
    ['cancelled upload', { ...row, state: 'cancelled' }],
  ])('blocks %s before publication', async (_name, resource) => {
    const { db } = scriptedKysely(admitted);
    const publish = vi.fn();
    try {
      await expect(
        db
          .transaction()
          .execute((tx) =>
            new ConnectMediaRepository(db).commit(
              tx,
              auth,
              resource as AssetUploadResource,
              { requestId: dto.requestId, sha256: dto.sha256 },
              publish,
            ),
          ),
      ).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it('refuses a missing owner or foreign, trashed, locked, or wrong-workspace album', async () => {
    for (const deniedTable of ['user', 'album']) {
      const { db, queries } = scriptedKysely((q) =>
        q.sql.includes(`from "${deniedTable}"`) ? { rows: [] } : admitted(q),
      );
      try {
        await expect(new ConnectMediaRepository(db).start(auth, dto, 100)).rejects.toThrow();
        expect(queries.some((q) => q.sql.startsWith('insert into'))).toBe(false);
        const target = queries.find((q) => q.sql.includes('from "album"'));
        if (target) {
          expect(target.sql).toContain('"libraryScope" =');
          expect(target.sql).toContain('"isLocked"');
          expect(target.sql).toContain("connect_owner.role = 'owner'");
        }
      } finally {
        await db.destroy();
      }
    }
  });

  it.each(['hidden', 'trashed', 'out-of-grant', 'photo-to-boards'])(
    'returns a generic conflict for an unauthorized %s duplicate',
    async () => {
      const { db } = scriptedKysely((q) =>
        q.sql.includes('from "asset"')
          ? { rows: q.sql.includes('for update') ? [{ id: assetId, libraryScope: LibraryScope.Personal }] : [] }
          : admitted(q),
      );
      const publish = vi.fn();
      try {
        await expect(
          db
            .transaction()
            .execute((tx) =>
              new ConnectMediaRepository(db).commit(
                tx,
                auth,
                row,
                { requestId: dto.requestId, sha256: dto.sha256 },
                publish,
              ),
            ),
        ).rejects.toThrow('Connect operation unavailable');
        expect(publish).not.toHaveBeenCalled();
      } finally {
        await db.destroy();
      }
    },
  );

  it('publishes membership and provenance before its durable receipt and never changes original/scope/trash', async () => {
    const { db, queries } = scriptedKysely(admitted);
    const withProvenance = {
      ...row,
      metadata: {
        ...row.metadata,
        connect: {
          ...row.metadata.connect!,
          provenance: {
            provider: 'canva' as const,
            externalId: 'd1',
            title: 'Design',
            exportedAt: dto.fileCreatedAt,
            entryLabel: 'Page 1',
            entryOrdinal: 1,
          },
        },
      },
    };
    try {
      const result = await db
        .transaction()
        .execute((tx) =>
          new ConnectMediaRepository(db).commit(
            tx,
            auth,
            withProvenance,
            { requestId: dto.requestId, sha256: dto.sha256 },
            async () => published,
          ),
        );
      expect(result).toEqual({ assetId, status: 'created', sha256: dto.sha256 });
      const insert = (table: string) => queries.findIndex((q) => q.sql.startsWith(`insert into "${table}"`));
      expect(insert('album_asset')).toBeGreaterThan(-1);
      expect(insert('connect_provenance')).toBeGreaterThan(insert('album_asset'));
      expect(insert('connect_receipt')).toBeGreaterThan(insert('connect_provenance'));
      expect(
        queries.filter((q) => q.sql.startsWith('update "asset"') || q.sql.startsWith('delete from "asset"')),
      ).toHaveLength(0);
      expect(queries.find((q) => q.sql.includes('from "oauth_grant"'))?.sql).toContain('for update');
      expect(queries.find((q) => q.sql.includes('from "user"'))?.sql).toContain('for update');
      expect(queries.at(-1)?.sql).toBe('commit');
    } finally {
      await db.destroy();
    }
  });

  it('rolls back when provenance cannot be recorded', async () => {
    const { db, queries } = scriptedKysely((q) => {
      if (q.sql.startsWith('insert into "connect_provenance"')) throw new Error('storage unavailable');
      return admitted(q);
    });
    try {
      await expect(
        db
          .transaction()
          .execute((tx) =>
            new ConnectMediaRepository(db).commit(
              tx,
              auth,
              { ...row, metadata: { ...row.metadata, connect: { ...row.metadata.connect!, provenance: {} as never } } },
              { requestId: dto.requestId, sha256: dto.sha256 },
              async () => published,
            ),
          ),
      ).rejects.toThrow('storage unavailable');
      expect(queries.at(-1)?.sql).toBe('rollback');
      expect(queries.some((q) => q.sql.startsWith('insert into "connect_receipt"'))).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it('replays a commit only while the result is still authorized', async () => {
    for (const visible of [true, false]) {
      const { db } = scriptedKysely((q) =>
        q.sql.includes('from "connect_receipt"')
          ? { rows: [{ requestHash: connectRequestHash({ uploadId, sha256: dto.sha256 }) }] }
          : q.sql.includes('from "asset"')
            ? { rows: visible ? [{ id: assetId }] : [] }
            : admitted(q),
      );
      const publish = vi.fn();
      try {
        const result = db
          .transaction()
          .execute((tx) =>
            new ConnectMediaRepository(db).commit(
              tx,
              auth,
              published,
              { requestId: dto.requestId, sha256: dto.sha256 },
              publish,
            ),
          );
        if (visible) await expect(result).resolves.toEqual({ assetId, status: 'created', sha256: dto.sha256 });
        else await expect(result).rejects.toThrow('Connect operation unavailable');
        expect(publish).not.toHaveBeenCalled();
      } finally {
        await db.destroy();
      }
    }
  });

  it('refuses request key reuse with another canonical payload', async () => {
    const { db, queries } = scriptedKysely((q) =>
      q.sql.includes('from "connect_receipt"')
        ? { rows: [{ requestHash: connectRequestHash({ ...dto, size: 12 }) }] }
        : admitted(q),
    );
    try {
      await expect(new ConnectMediaRepository(db).start(auth, dto, 100)).rejects.toThrow('Request ID payload changed');
      expect(queries.some((q) => q.sql.startsWith('insert into'))).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it('returns the same upload after a lost start response without creating another resource', async () => {
    const { db, queries } = scriptedKysely((q) =>
      q.sql.includes('from "connect_receipt"')
        ? { rows: [{ requestHash: connectRequestHash(dto), resultId: uploadId }] }
        : q.sql.includes('from "asset_upload_resource"')
          ? { rows: [row] }
          : admitted(q),
    );
    try {
      expect((await new ConnectMediaRepository(db).start(auth, dto, 100)).id).toBe(uploadId);
      expect(queries.some((q) => q.sql.startsWith('insert into'))).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it('rejects the live quota and effective server limit before staging', async () => {
    for (const maxSize of [9, 100]) {
      const { db, queries } = scriptedKysely((q) =>
        q.sql.includes('from "user"')
          ? { rows: [{ ...auth.user, quotaSizeInBytes: 5, quotaUsageInBytes: 0 }] }
          : admitted(q),
      );
      try {
        await expect(new ConnectMediaRepository(db).start(auth, dto, maxSize)).rejects.toThrow(
          maxSize === 9 ? 'effective size limit' : 'Quota',
        );
        expect(queries.some((q) => q.sql.startsWith('insert into'))).toBe(false);
      } finally {
        await db.destroy();
      }
    }
  });

  it('stores only a ticket hash and refuses malformed/expired tickets', async () => {
    const { db, queries } = scriptedKysely();
    try {
      const repo = new ConnectMediaRepository(db);
      const ticket = await repo.createTicket(auth, assetId, 'preview');
      const token = ticket.url.split('/').at(-1)!;
      expect(token).toMatch(/^[\w-]{43}$/);
      expect(new Date(ticket.expiresAt).getTime() - Date.now()).toBeGreaterThan(890_000);
      expect(queries[0].parameters).not.toContain(token);
      expect(queries[0].parameters.some((value) => Buffer.isBuffer(value) && value.length === 32)).toBe(true);
      await expect(repo.ticket('bad')).rejects.toThrow('Rendition unavailable');
      await expect(repo.ticket(token)).rejects.toThrow('Rendition unavailable');
      expect(queries.at(-1)?.sql).toContain('"expiresAt" >');
    } finally {
      await db.destroy();
    }
  });
});
