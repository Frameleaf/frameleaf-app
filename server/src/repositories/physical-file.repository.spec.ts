import { ConflictException } from '@nestjs/common';
import { PHYSICAL_FILE_HANDOFF_REFUSAL, PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { ScriptedQuery, forkGuardAnswer, scriptedKysely } from 'test/scripted-kysely.js';

const path = '/data/library/owner/2024/photo.jpg';

/** Answers the reference counts of `deleteUnreferencedPath`: `retained` for the FL-44 retained-output query. */
const referenceAnswer =
  (options: { phase?: string; handoff?: boolean; retained?: number }) => (query: ScriptedQuery) => {
    const guard = forkGuardAnswer(options)(query);
    if (guard) {
      return guard;
    }
    if (query.sql.includes('immich_fork.asset_physical_file mapping')) {
      return { rows: [{ count: String(options.retained ?? 0) }] };
    }
    if (query.sql.includes('count(')) {
      return { rows: [{ count: '0' }] };
    }
  };

describe(PhysicalFileRepository.name, () => {
  describe('deleteUnreferencedPath (FL-44)', () => {
    it('keeps a file only a live fork mapping, fork physical file or retained output still names', async () => {
      const { db, queries } = scriptedKysely(referenceAnswer({ retained: 1 }));
      const unlink = vi.fn(() => Promise.resolve());

      await expect(new PhysicalFileRepository(db).deleteUnreferencedPath(path, unlink)).resolves.toEqual({
        deleted: false,
        references: 1,
      });
      expect(unlink).not.toHaveBeenCalled();

      const retained = queries.find(({ sql }) => sql.includes('immich_fork.asset_physical_file mapping'))!;
      // a mapping counts only while its asset exists; the fork physical file only while a live mapping uses it
      expect(retained.sql).toContain('JOIN public.asset asset ON asset.id = mapping."assetId"');
      expect(retained.sql).toContain('physical."canonicalPath"');
      expect(retained.sql).toContain('public.studio_export_version');
      expect(retained.sql).toContain('public.preservation_package');
      expect(retained.sql).toContain('package."removedAt" IS NULL');
      expect(retained.sql).toContain('public.asset_restoration');
      expect(retained.parameters.every((parameter) => parameter === path)).toBe(true);
    });

    it('deletes a file nothing references', async () => {
      const { db } = scriptedKysely(referenceAnswer({ retained: 0 }));
      const unlink = vi.fn(() => Promise.resolve());

      await expect(new PhysicalFileRepository(db).deleteUnreferencedPath(path, unlink)).resolves.toEqual({
        deleted: true,
        references: 0,
      });
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a handoff is being prepared', { phase: 'ready', handoff: true }],
      ['the database was handed over', { phase: 'inactive' }],
    ])('refuses to delete while %s', async (_state, options) => {
      const { db, queries } = scriptedKysely(referenceAnswer(options));
      const unlink = vi.fn(() => Promise.resolve());

      await expect(new PhysicalFileRepository(db).deleteUnreferencedPath(path, unlink)).rejects.toThrow(
        new ConflictException(PHYSICAL_FILE_HANDOFF_REFUSAL),
      );
      expect(unlink).not.toHaveBeenCalled();
      expect(queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
    });
  });

  describe('handoff write guard (FL-44)', () => {
    it('refuses to link a deduplicated original while a handoff runs', async () => {
      const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'ready', handoff: true }));

      await expect(
        new PhysicalFileRepository(db).linkAssetToOriginalPhysicalFile('asset-id', { id: 'physical-id', path }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queries.some(({ sql }) => sql.startsWith('update "asset"'))).toBe(false);
    });

    it('refuses to record a physical file while a handoff runs', async () => {
      const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'inactive' }));

      await expect(
        new PhysicalFileRepository(db).upsertPhysicalFile({
          canonicalAssetId: null,
          checksum: Buffer.from('checksum'),
          path,
          sizeInBytes: 1,
          type: 'original' as never,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queries.some(({ sql }) => sql.startsWith('insert into "physical_file"'))).toBe(false);
    });

    it('takes the guard before the path lock and the write', async () => {
      const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'active' }));

      await new PhysicalFileRepository(db).linkGeneratedFile('asset-id', 'thumbnail' as never, 'physical-id', path);

      const statements = queries.map(({ sql }) => sql);
      const guard = statements.findIndex((sql) => sql.includes('FOR SHARE'));
      const lock = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
      const write = statements.findIndex((sql) => sql.startsWith('update "asset_file"'));
      expect(guard).toBeGreaterThan(0);
      expect(lock).toBeGreaterThan(guard);
      expect(write).toBeGreaterThan(lock);
    });
  });
});
