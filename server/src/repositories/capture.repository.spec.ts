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
