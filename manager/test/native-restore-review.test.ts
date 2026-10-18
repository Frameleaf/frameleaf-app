import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import {
  prepareNativeRestoreReview,
  revalidateNativeRestoreReview,
} from '../src/runtime/native-restore-review.js';

async function fixture(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-native-restore-review-')),
  );
  const store = new Store(join(root, 'manager'));
  const context = {
    installation: {
      runtime: 'native',
      id: 'a'.repeat(12),
      controller: join(root, 'controller'),
      candidate: join(root, 'candidate'),
      state: join(root, 'profile'),
      manifestSha256: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      certified: false,
      databasePort: 54329,
      apiPort: 2283,
    },
    libraryId: 'd'.repeat(12),
    release: 'frameleaf-v3.0.0-1',
  };
  store.set('native-library-id', context.libraryId);
  const dump = Buffer.from('PGDMP logical recovery fixture');
  const recovery = {
    schemaVersion: 1,
    runtime: 'native',
    mediaIncluded: false,
    databaseFormat: 'frameleaf-canonical',
    libraryId: context.libraryId,
    createdAt: 1234,
    installation: {
      id: 'e'.repeat(12),
      name: 'Recovery library',
      release: context.release,
    },
    checkpoint: {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: '11111111-1111-4111-8111-111111111111',
      manifestSha256: 'f'.repeat(64),
      sourceRevision: context.installation.sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: {
        bytes: dump.length,
        sha256: createHash('sha256').update(dump).digest('hex'),
      },
    },
  };
  let calls = 0,
    destination;
  const engine = {
    restore: async (snapshot, path) => {
      calls++;
      destination = path;
      assert.equal(snapshot, '1'.repeat(64));
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'database.dump'), dump, { mode: 0o600 });
      await writeFile(join(path, 'recovery.json'), JSON.stringify(recovery), {
        mode: 0o600,
      });
    },
  };
  try {
    await run({
      root,
      store,
      context,
      recovery,
      dump,
      engine,
      calls: () => calls,
      path: () => destination,
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('native restore review decrypts once, persists lineage and revalidates exact bytes without host effects', async () => {
  await fixture(async ({ store, context, engine, calls, path, recovery }) => {
    const summary = await prepareNativeRestoreReview(
      store,
      engine,
      context,
      '1'.repeat(64),
    );
    assert.equal(summary.mediaIncluded, false);
    assert.equal(summary.libraryId, context.libraryId);
    assert.equal(summary.release, context.release);
    assert.equal(summary.requiresRuntimeChange, false); // Manifest differs across platform; source/release contract matches.
    assert.ok(!JSON.stringify(summary).includes(store.directory));
    const review = await revalidateNativeRestoreReview(
      store,
      context,
      summary.id,
    );
    assert.equal(review.state, 'prepared');
    assert.deepEqual(review.recovery, recovery);
    assert.equal(calls(), 1);
    assert.equal(
      path(),
      join(store.directory, 'native-restore-reviews', summary.id),
    );
    assert.equal(store.history().length, 0);
    await writeFile(join(path(), 'database.dump'), 'PGDMP changed', {
      mode: 0o600,
    });
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, summary.id),
      /native_restore_review_changed/,
    );
  });
});

test('foreign library and corrupt dump produce no prepared review and retain failed evidence', async () => {
  for (const mutation of ['library', 'dump'])
    await fixture(async ({ store, context, recovery, engine, path }) => {
      if (mutation === 'library') recovery.libraryId = '2'.repeat(12);
      else recovery.checkpoint.dump.sha256 = '0'.repeat(64);
      await assert.rejects(
        prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
        /native_restore_verification_failed/,
      );
      const id = basename(path());
      assert.equal(store.get(`native-restore-review:${id}`).state, 'failed');
      assert.ok((await readdir(path())).includes('database.dump'));
    });
});

test('expired, changed runtime and changed library reviews cannot authorize restoration', async () => {
  await fixture(async ({ store, context, engine }) => {
    const review = await prepareNativeRestoreReview(
      store,
      engine,
      context,
      '1'.repeat(64),
    );
    await assert.rejects(
      revalidateNativeRestoreReview(
        store,
        {
          ...context,
          installation: {
            ...context.installation,
            sourceRevision: '3'.repeat(40),
          },
        },
        review.id,
      ),
      /native_restore_review_changed/,
    );
    store.set('native-library-id', '4'.repeat(12));
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, review.id),
      /native_restore_review_changed/,
    );
    store.set('native-library-id', context.libraryId);
    const saved = store.get(`native-restore-review:${review.id}`);
    saved.expires = 0;
    store.set(`native-restore-review:${review.id}`, saved);
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, review.id),
      /native_restore_review_expired/,
    );
  });
});

test('linked files, unknown inventory and public permissions are refused before review publication', async () => {
  for (const mutation of ['symlink', 'hardlink', 'extra', 'public'])
    await fixture(async ({ store, context, engine, root, path }) => {
      const restore = engine.restore;
      engine.restore = async (...args) => {
        await restore(...args);
        const file = join(path(), 'database.dump');
        if (mutation === 'extra')
          await writeFile(join(path(), 'foreign'), 'preserve');
        else if (mutation === 'public') {
          const { chmod } = await import('node:fs/promises');
          await chmod(file, 0o644);
        } else {
          const bytes = await readFile(file);
          await rm(file);
          const other = join(root, 'other');
          await writeFile(other, bytes, { mode: 0o600 });
          if (mutation === 'symlink') await symlink(other, file);
          else await link(other, file);
        }
      };
      if (mutation === 'public' && process.platform === 'win32') return;
      await assert.rejects(
        prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
        /native_restore_verification_failed/,
      );
    });
});

test('invalid snapshot or context is rejected before decryption; interrupted decryption is durably failed', async () => {
  await fixture(async ({ store, context, engine, calls, path }) => {
    await assert.rejects(
      prepareNativeRestoreReview(store, engine, context, 'bad'),
      /native_restore_request_invalid/,
    );
    await assert.rejects(
      prepareNativeRestoreReview(
        store,
        engine,
        { ...context, libraryId: 'bad' },
        '1'.repeat(64),
      ),
      /native_restore_request_invalid/,
    );
    assert.equal(calls(), 0);
    const restore = engine.restore;
    engine.restore = async (...args) => {
      await restore(...args);
      throw Error('private detail');
    };
    await assert.rejects(
      prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
      /native_restore_verification_failed/,
    );
    const id = basename(path());
    assert.equal(store.get(`native-restore-review:${id}`).state, 'failed');
    assert.ok(
      !JSON.stringify(store.get(`native-restore-review:${id}`)).includes(
        'private detail',
      ),
    );
  });
});

test('reviews that expire during decryption or revalidation never become usable', async (t) => {
  await fixture(async ({ store, context, engine }) => {
    let clock = Date.now();
    const now = t.mock.method(Date, 'now', () => clock);
    const restore = engine.restore;
    engine.restore = async (...args) => {
      await restore(...args);
      clock += 900_001;
    };
    await assert.rejects(
      prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
      /native_restore_verification_failed/,
    );
    now.mock.restore();
  });
  await fixture(async ({ store, context, engine }) => {
    const summary = await prepareNativeRestoreReview(
      store,
      engine,
      context,
      '1'.repeat(64),
    );
    let calls = 0;
    const now = t.mock.method(Date, 'now', () =>
      calls++ === 0 ? summary.expires - 1 : summary.expires + 1,
    );
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, summary.id),
      /native_restore_review_expired/,
    );
    now.mock.restore();
  });
});
