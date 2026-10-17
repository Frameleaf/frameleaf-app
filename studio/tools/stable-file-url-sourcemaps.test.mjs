import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableFileUrlSourcemapsPlugin } from './stable-file-url-sourcemaps.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { build } = await import(require.resolve('vite'));
const { TraceMap, decodedMappings } = require('@jridgewell/trace-mapping');

test('real file URL maps retain every mapping and name while resolving transient handles to emitted URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-file-url-map-'));
  try {
    await writeFile(path.join(root, 'resource.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(path.join(root, 'entry.ts'), 'import url from "./resource.wasm?url";\nconsole.log(url);\n');
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const before = new Map();
      const bundle = await build({
        root, configFile: false, base: '/fixture/', logLevel: 'silent',
        plugins: [stableFileUrlSourcemapsPlugin(), {
          name: 'capture-original-maps',
          generateBundle(_options, output) {
            for (const file of Object.values(output)) {
              if (file.type === 'asset' && file.fileName.endsWith('.map')) before.set(file.fileName, JSON.parse(String(file.source)));
            }
          },
        }],
        build: {
          outDir: 'dist', assetsInlineLimit: 0, sourcemap: true,
          rollupOptions: { input: path.join(root, 'entry.ts'), output: {
            manualChunks: (id) => id.endsWith('?url') ? 'asset-source' : undefined,
          } },
        },
      });
      const outputs = bundle.output;
      const asset = outputs.find((file) => file.type === 'asset' && file.fileName.endsWith('.wasm'));
      const mapFile = outputs.find((file) => file.fileName.endsWith('.js.map') &&
        JSON.parse(String(file.source)).sources.some((source) => source.endsWith('resource.wasm?url')));
      const map = JSON.parse(await readFile(path.join(root, 'dist', mapFile.fileName), 'utf8'));
      const original = before.get(mapFile.fileName);
      const index = map.sources.findIndex((source) => source.endsWith('resource.wasm?url'));
      assert.ok(index >= 0);
      assert.match(original.sourcesContent[index], /import\.meta\.ROLLDOWN_FILE_URL_/);
      assert.equal(map.sourcesContent[index], `export default ${JSON.stringify(`/fixture/${asset.fileName}`)}`);
      assert.deepEqual({ ...map, sourcesContent: null }, { ...original, sourcesContent: null });
      const segments = decodedMappings(new TraceMap(map)).flat().filter((segment) => segment[1] === index);
      assert.ok(segments.length > 0);
      // The virtual module maps the export and URL expression, still at columns 0 and 15.
      for (const segment of segments) {
        assert.equal(segment[2], 0);
        assert.ok(segment[3] === 0 || segment[3] === 15);
      }
      for (let index = 0; index < map.sources.length; index++) {
        if (!map.sources[index].endsWith('?url')) assert.equal(map.sourcesContent[index], original.sourcesContent[index]);
      }
      assert.ok(outputs.some((file) => file.type === 'chunk' && file.code.includes(`/fixture/${asset.fileName}`)));
      const files = await readdir(path.join(root, 'dist/assets'));
      runs.push(await Promise.all(files.sort().map(async (file) => [file, createHash('sha256').update(await readFile(path.join(root, 'dist/assets', file))).digest('hex')])));
    }
    assert.deepEqual(runs[1], runs[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
