import { vi } from 'vitest';
import { CaptureCommitDto } from 'src/dtos/capture.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { CaptureRepository } from 'src/repositories/capture.repository.js';
import { captureRequestHash } from 'src/utils/capture.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const auth = { ...authStub.user1, apiKey: { id: 'capture-key', permissions: [Permission.CaptureCreate] } };
const dto = CaptureCommitDto.schema.parse({
  captureId: '10000000-0000-4000-8000-000000000001',
  albumId: '10000000-0000-4000-8000-000000000002',
  uploadResourceId: '10000000-0000-4000-8000-000000000001',
  sha256: 'a'.repeat(64),
  source: { pageUrl: 'https://example.org', title: 'Reference', capturedAt: '2026-10-28T12:00:00Z' },
});
const receipt = {
  ownerId: auth.user.id,
  captureId: dto.captureId,
  actorId: 'key:capture-key',
  requestHash: captureRequestHash(dto),
  kind: 'asset',
  itemId: 'captured-asset',
  status: 'created',
};
const admitted = (sql: string) => {
  if (sql.includes('from "api_key"')) return { rows: [{ id: auth.apiKey.id }] };
  if (sql.includes('from "user"')) return { rows: [{ id: auth.user.id, uploadsPaused: false }] };
  if (sql.includes('from "album_user"')) return { rows: [{ role: 'editor' }] };
  return { rows: [] };
};

describe('atomic capture receipt admission', () => {
  it('records cancellation on the same immutable ledger before a future publisher can proceed', async () => {
    const cancelled = { ...receipt, status: 'cancelled', itemId: dto.captureId };
    let saved = false;
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('from "capture_receipt"')) return { rows: saved ? [cancelled] : [] };
      if (sql.startsWith('insert into "capture_receipt"')) {
        saved = true;
        return { rows: [cancelled] };
      }
      return admitted(sql);
    });
    try {
      const repo = new CaptureRepository(db);
      expect(await repo.cancel(auth, dto)).toEqual(cancelled);
      expect(await repo.cancel(auth, dto)).toEqual(cancelled);
      expect(queries.filter(({ sql }) => sql.startsWith('insert into "capture_receipt"'))).toHaveLength(1);
      expect(queries.find(({ sql }) => sql.includes('from "user"'))?.sql).toContain('for update');
      const publish = vi.fn();
      await expect(db.transaction().execute((tx) => repo.commitFile(tx, auth, dto, publish))).rejects.toThrow(
        'cancelled',
      );
      await expect(repo.getCompleted(auth, dto)).rejects.toThrow('cancelled');
      expect(publish).not.toHaveBeenCalled();
      expect(queries.some(({ sql }) => sql.startsWith('delete from "asset"'))).toBe(false);
    } finally {
      await db.destroy();
    }
  });
  it('preserves an already completed receipt and enforces its original actor and request on cancellation', async () => {
    for (const existing of [
      receipt,
      { ...receipt, actorId: 'key:other' },
      { ...receipt, requestHash: Buffer.alloc(32) },
    ]) {
      const { db, queries } = scriptedKysely(({ sql }) =>
        sql.includes('from "capture_receipt"') ? { rows: [existing] } : admitted(sql),
      );
      try {
        const result = new CaptureRepository(db).cancel(auth, dto);
        if (existing === receipt) expect(await result).toEqual(receipt);
        else await expect(result).rejects.toThrow();
        expect(queries.some(({ sql }) => sql.startsWith('insert into "capture_receipt"'))).toBe(false);
      } finally {
        await db.destroy();
      }
    }
  });
  it('cannot cancel a staged capture owned by another key or a changed checksum', async () => {
    for (const resource of [
      {
        metadata: { publication: 'capture', captureId: dto.captureId, captureActor: 'key:other' },
        expectedChecksum: Buffer.from('a'.repeat(64), 'hex'),
      },
      {
        metadata: { publication: 'capture', captureId: dto.captureId, captureActor: 'key:capture-key' },
        expectedChecksum: Buffer.alloc(32),
      },
    ]) {
      const { db, queries } = scriptedKysely(({ sql }) =>
        sql.includes('from "asset_upload_resource"') ? { rows: [resource] } : admitted(sql),
      );
      try {
        await expect(new CaptureRepository(db).cancel(auth, dto)).rejects.toThrow('Capture unavailable');
        expect(queries.some(({ sql }) => sql.startsWith('insert into "capture_receipt"'))).toBe(false);
      } finally {
        await db.destroy();
      }
    }
  });
  it('blocks byte admission for a cancelled UUID without changing old completed receipts', async () => {
    for (const status of ['cancelled', 'created']) {
      const { db } = scriptedKysely(() => ({ rows: [{ status, actorId: 'key:capture-key' }] }));
      try {
        const check = new CaptureRepository(db).assertNotCancelled(auth, dto.captureId);
        if (status === 'cancelled') await expect(check).rejects.toThrow('cancelled');
        else await expect(check).resolves.toBeUndefined();
      } finally {
        await db.destroy();
      }
    }
  });
  it('replays the same payload without publishing another asset', async () => {
    const { db } = scriptedKysely(({ sql }) =>
      sql.includes('from "capture_receipt"') ? { rows: [receipt] } : admitted(sql),
    );
    const publish = vi.fn();
    try {
      expect(
        await db.transaction().execute((tx) => new CaptureRepository(db).commitFile(tx, auth, dto, publish)),
      ).toEqual(receipt);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it.each([
    [{ ...receipt, requestHash: Buffer.alloc(32) }, 'Capture payload changed'],
    [{ ...receipt, actorId: 'key:another-key' }, 'Capture unavailable'],
  ])('rejects changed payloads or another actor before publication', async (existing, message) => {
    const { db } = scriptedKysely(({ sql }) =>
      sql.includes('from "capture_receipt"') ? { rows: [existing] } : admitted(sql),
    );
    const publish = vi.fn();
    try {
      await expect(
        db.transaction().execute((tx) => new CaptureRepository(db).commitFile(tx, auth, dto, publish)),
      ).rejects.toThrow(message);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it('does not use a cached auth object after key revocation', async () => {
    const { db, queries } = scriptedKysely(({ sql }) =>
      sql.includes('from "api_key"') ? { rows: [] } : admitted(sql),
    );
    const publish = vi.fn();
    try {
      await expect(
        db.transaction().execute((tx) => new CaptureRepository(db).commitFile(tx, auth, dto, publish)),
      ).rejects.toThrow('Capture unavailable');
      expect(publish).not.toHaveBeenCalled();
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });

  it('rolls back publication when provenance fails, without inserting a saved receipt', async () => {
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.startsWith('insert into "asset_source"')) throw new Error('source write failed');
      if (sql.includes('from "asset"'))
        return { rows: [{ id: 'captured-asset', ownerId: auth.user.id, libraryScope: LibraryScope.Design }] };
      return admitted(sql);
    });
    const publish = vi.fn().mockResolvedValue({ id: 'captured-asset', status: 'created' });
    try {
      await expect(
        db.transaction().execute((tx) => new CaptureRepository(db).commitFile(tx, auth, dto, publish)),
      ).rejects.toThrow('source write failed');
      expect(queries.some(({ sql }) => sql.startsWith('insert into "capture_receipt"'))).toBe(false);
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });
});
