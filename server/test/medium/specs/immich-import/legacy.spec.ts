import { readFile } from 'node:fs/promises';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { PostgresImportFixture } from 'test/medium/specs/immich-import/postgres-transport.fixture.js';

// Real PostgreSQL on both sides: the source is each replayed 2.x catalog, read only through the production views.
describe('offline import of older Immich releases', () => {
  let fixture: PostgresImportFixture | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  }, 30_000);

  const importAndActivate = async (f: PostgresImportFixture) => {
    const importer: ImmichImportService = f.importer();
    const fingerprint = await importer.source.preflight();
    await importer.run();
    await importer.verify(async () => {
      // Dispatcher acknowledgement stand-in, as in the transport suite.
      await f.destination.db.query('UPDATE public.frameleaf_immich_import_work SET dispatched_at=now()');
    });
    await expect(assertImmichImportActivated(f.destination.db)).resolves.toBeUndefined();
    expect(await importer.source.preflight()).toBe(fingerprint);
  };

  // One pin per distinct replayed content shape.
  it.each(['2.0.0', '2.2.3', '2.3.1', '2.4.1', '2.5.6', '2.6.3', '2.7.5'])(
    'imports %s with every later upstream data migration applied',
    async (version) => {
      const f = (fixture = new PostgresImportFixture(version));
      await f.initialize();
      await importAndActivate(f);
      const db = f.destination.db;
      const query = (sql: string, parameters?: unknown[]) => db.query(sql, parameters);

      const users = await query('SELECT id,password,"oauthId" FROM public."user" ORDER BY email');
      expect(users).toEqual([
        { id: f.owner, password: f.passwordHash, oauthId: null },
        { id: f.reader, password: null, oauthId: null },
      ]);
      await expect(new CryptoRepository().compareBcrypt(f.password, String(users[0].password))).resolves.toBe(true);

      expect(
        await query(
          `SELECT id,type,visibility,duration,"checksumAlgorithm",width,height,"isEdited","originalPath"
          FROM public.asset ORDER BY type,id`,
          [],
        ),
      ).toEqual(
        expect.arrayContaining([
          // The wrongly hidden Live Photo still is visible; width/height follow the rotated EXIF frame.
          expect.objectContaining({
            id: f.asset,
            visibility: 'timeline',
            checksumAlgorithm: 'sha1',
            width: version < '2.5' ? 3000 : null,
            height: version < '2.5' ? 4000 : null,
            isEdited: false,
            originalPath: f.targetPath,
          }),
          expect.objectContaining({ id: f.video, visibility: 'hidden', duration: 62_345 }),
        ]),
      );
      expect(await query('SELECT rating,description FROM public.asset_exif WHERE "assetId"=$1', [f.asset])).toEqual([
        // 2.6 nulls existing zero ratings once; later zeros are the release's own data.
        { rating: version < '2.6' ? null : 0, description: 'Beach day' },
      ]);

      const files = await query('SELECT "assetId",type,path FROM public.asset_file ORDER BY type');
      expect(files).toEqual([
        ...(version < '2.6'
          ? [{ assetId: f.video, type: 'encoded_video', path: f.file('encoded.mp4', 'target') }]
          : []),
        ...(version < '2.4' ? [{ assetId: f.asset, type: 'sidecar', path: f.file('original.jpg.xmp', 'target') }] : []),
      ]);

      expect(await query('SELECT description FROM public.album WHERE id=$1', [f.album])).toEqual([
        { description: null },
      ]);
      expect(await query('SELECT "userId",role::text FROM public.album_user ORDER BY role::text')).toEqual([
        { userId: f.reader, role: 'editor' },
        { userId: f.owner, role: 'owner' },
      ]);
      expect(await query('SELECT "albumId","assetId" FROM public.album_asset')).toEqual([
        { albumId: f.album, assetId: f.asset },
      ]);
      expect(await query('SELECT "assetId","tagId" FROM public.tag_asset')).toEqual([
        { assetId: f.asset, tagId: f.tag },
      ]);
      // Album links share the album; 2.6.2 deleted their duplicate per-asset rows once.
      expect(await query('SELECT "assetId" FROM public.shared_link_asset')).toEqual(
        version < '2.6.2' ? [] : [{ assetId: f.asset }],
      );
      expect(await query('SELECT "assetId" FROM public.memory_asset')).toEqual([{ assetId: f.asset }]);
      // The cross-owner face is dropped and the person that featured it loses its cover face.
      expect(await query('SELECT id FROM public.asset_face')).toEqual([{ id: f.face }]);
      expect(await query('SELECT name,"faceAssetId" FROM public.person ORDER BY name')).toEqual([
        { name: 'Alex', faceAssetId: f.face },
        { name: 'Cross', faceAssetId: null },
      ]);
      expect(await readFile(f.sourcePath)).toEqual(f.original);
    },
    180_000,
  );

  // 3.0.0 predates the 3.0.3 Live Photo fix as well as the 3.2 fixes.
  it('applies the 3.0.3 and 3.2 data fixes to a 3.0.0 source', async () => {
    const f = (fixture = new PostgresImportFixture('3.0.0'));
    await f.initialize();
    const orphan = '2c8f6a0e-0a52-4b3a-9e3a-6f4f1f1c2d01';
    await f.mutateSource(async (db) => {
      await db.query(`UPDATE public."user" SET password='' WHERE id=$1`, [f.reader]);
      await db.query(`UPDATE public.album SET description='' WHERE id=$1`, [f.album]);
      await db.query(`UPDATE public.asset SET visibility='hidden',"livePhotoVideoId"=id WHERE id=$1`, [f.asset]);
      // An album whose owner row is gone: 3.2 deletes it with its members and links.
      await db.query(`INSERT INTO public.album(id,"albumName") VALUES ($1,'Ownerless')`, [orphan]);
      await db.query(`INSERT INTO public.album_user("albumId","userId",role) VALUES ($1,$2,'editor')`, [
        orphan,
        f.reader,
      ]);
      await db.query(`INSERT INTO public.album_asset("albumId","assetId") VALUES ($1,$2)`, [orphan, f.asset]);
      // A memory of the reader that holds the owner's asset: 3.2 removes the link.
      await db.query(
        `INSERT INTO public.memory(id,"ownerId",type,data,"memoryAt") VALUES ($1,$2,'on_this_day','{"year":2025}','2026-06-01')`,
        [orphan, f.reader],
      );
      await db.query(`INSERT INTO public.memory_asset("memoriesId","assetId") VALUES ($1,$2)`, [orphan, f.asset]);
    });
    await importAndActivate(f);
    const db = f.destination.db;
    expect(await db.query('SELECT password FROM public."user" WHERE id=$1', [f.reader])).toEqual([{ password: null }]);
    expect(await db.query('SELECT id,description FROM public.album')).toEqual([{ id: f.album, description: null }]);
    expect(await db.query('SELECT "albumId" FROM public.album_asset')).toEqual([{ albumId: f.album }]);
    expect(await db.query('SELECT visibility FROM public.asset WHERE id=$1', [f.asset])).toEqual([
      { visibility: 'timeline' },
    ]);
    expect(await db.query('SELECT * FROM public.memory_asset')).toEqual([]);
  }, 180_000);
});
