// Synthetic fixtures only. Build the server first and select the pinned native binding.
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SharpProcessPool } from '../../../dist/queue/sharp-pool.js';
import { defaultDevelopRecipe } from '../../../dist/utils/develop-recipe.js';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const source = fileURLToPath(new URL('./apple-gain-map-colors.heic', import.meta.url));
const original = await readFile(source);
const checksum = createHash('sha256').update(original).digest();
const pool = new SharpProcessPool({ workers: 1, pending: 0 });
// Keep the standalone generator alive while closing otherwise-unreferenced idle workers.
const keepAlive = setInterval(() => {}, 1000);
try {
  const master = join(output, 'develop-master.jpg');
  await pool.run('generateHdrRenditions', [
    source,
    [{ path: master }],
    { recipe: { ...defaultDevelopRecipe(), exposure: 1 }, seed: 1, masks: {}, fills: {} },
  ]);
  const masterChecksum = createHash('sha256')
    .update(await readFile(master))
    .digest();
  for (const [format, name] of [
    ['hdr-jpeg', 'develop-hdr.jpg'],
    ['hdr-heic', 'develop-hdr.heic'],
  ]) {
    await pool.run('exportPhotoStill', [master, join(output, name), format, masterChecksum]);
  }
  if (
    !createHash('sha256')
      .update(await readFile(source))
      .digest()
      .equals(checksum)
  ) {
    throw new Error('Fixture generation changed its source');
  }
} finally {
  await pool.close();
  clearInterval(keepAlive);
}
