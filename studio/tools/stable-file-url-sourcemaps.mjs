import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE_URL = /import\.meta\.ROLLDOWN_FILE_URL_([\w$]+)/g;

export function stableFileUrlSourcemapsPlugin() {
  const urls = new Map();
  const maps = new Set();
  let base = '/';
  return {
    name: 'frameleaf-stable-file-url-sourcemaps',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { base = config.base; },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.map')) continue;
        const text = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source);
        for (const [, handle] of text.matchAll(FILE_URL)) {
          urls.set(handle, JSON.stringify(`${base}${this.getFileName(handle)}`));
          maps.add(file.fileName);
        }
      }
    },
    // Rolldown writes its own map buffer; update the written source text, preserving all mappings.
    writeBundle(options) {
      for (const fileName of maps) {
        const file = path.join(options.dir, fileName);
        const map = JSON.parse(readFileSync(file, 'utf8'));
        map.sourcesContent = map.sourcesContent?.map((source) => source === null ? source :
          source.replace(FILE_URL, (_match, handle) => urls.get(handle)));
        writeFileSync(file, JSON.stringify(map));
      }
      maps.clear();
      urls.clear();
    },
  };
}
