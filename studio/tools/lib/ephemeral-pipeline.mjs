import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This owns only its new random child directory, never the supplied cache parent.
export async function withEphemeralPipeline(create, use, parent = os.tmpdir()) {
  const cache = mkdtempSync(path.join(parent, 'frameleaf-whisper-'));
  let pipeline;
  try {
    pipeline = await create(cache);
    assert.equal(typeof pipeline.dispose, 'function', 'A genuine disposable inference pipeline is required');
    return await use(pipeline);
  } finally {
    try { if (pipeline && typeof pipeline.dispose === 'function') await pipeline.dispose(); }
    finally { rmSync(cache, { recursive: true, force: true }); }
  }
}
