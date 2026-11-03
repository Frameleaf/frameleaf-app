import assert from 'node:assert/strict';
import test from 'node:test';

test('compiled Photoview reader and pinned fixture load through native ESM', async () => {
  const { openPhotoviewSnapshot } = await import('../../dist/library-import/photoview.js');
  assert.equal(typeof openPhotoviewSnapshot, 'function');
  assert.throws(() => openPhotoviewSnapshot('/unused', 'unqualified'), /PHOTOVIEW_VERSION_UNQUALIFIED/);
});
