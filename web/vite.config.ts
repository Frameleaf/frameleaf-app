import adapter from '@sveltejs/adapter-static';
import { enhancedImages } from '@sveltejs/enhanced-img';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import dotenv from 'dotenv';
import { visualizer } from 'rollup-plugin-visualizer';
import type { compile } from 'svelte/compiler';
import { defineConfig, type Plugin, type ProxyOptions, type UserConfig } from 'vite';
import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildIconPacks } from './scripts/icon-packs.mjs';
import { analyse, AREAS, BUNDLES, bundlesFor, languageCodes, readLanguage } from './scripts/message-areas.mjs';

dotenv.config({ quiet: true });

const retainSvelteCss = (): Plugin => {
  type SvelteCss = NonNullable<ReturnType<typeof compile>['css']> & { meta?: { vite?: Record<string, unknown> } };
  const environments = new WeakMap<object, Map<string, SvelteCss>>();
  return {
    name: 'frameleaf-svelte-css-cache',
    enforce: 'post',
    configResolved(config) {
      const compiler = config.plugins.find((candidate) => candidate.name === 'vite-plugin-svelte:compile');
      const hook = compiler?.transform;
      const handler = typeof hook === 'function' ? hook : hook?.handler;
      if (!compiler || !handler) {
        return;
      }
      const transform: NonNullable<Plugin['transform']> = async function (code, id, options) {
        const result = await handler.call(this, code, id, options);
        const filename = id.split('?', 1)[0];
        if (filename.endsWith('.svelte') && !id.includes('type=style') && result && typeof result === 'object') {
          let styles = environments.get(this.environment);
          if (!styles) {
            environments.set(this.environment, (styles = new Map()));
          }
          const css = result.meta?.svelte?.css as SvelteCss | undefined;
          if (css) {
            styles.set(filename, css);
          } else {
            styles.delete(filename);
          }
        }
        return result;
      };
      compiler.transform = typeof hook === 'function' ? transform : { ...hook, handler: transform };
    },
    load(id) {
      const match = /^(.*\.svelte)\?svelte&type=style(?:&|$)/.exec(id);
      const cached = match && environments.get(this.environment)?.get(match[1]);
      if (!cached) {
        return;
      }
      // Module resets can retire metadata before the virtual stylesheet is requested.
      const { hasGlobal, ...css } = cached;
      return {
        ...css,
        moduleType: 'css',
        meta:
          hasGlobal === false
            ? { ...css.meta, vite: { ...css.meta?.vite, cssScopeTo: [match[1], 'default'] } }
            : css.meta,
      };
    },
  };
};

/**
 * FL-139: regenerates the full MDI icon-path lookup as a static JSON asset, fetched lazily by
 * $lib/frameleaf/icon-catalogue.ts - never bundled as JS. A bare `import('@mdi/js')` sitting next
 * to this app's many static `import { mdiFoo } from '@mdi/js'` icon imports forced Rollup to keep
 * every one of @mdi/js's 7,448 exports in the same chunk those static imports load from (the
 * dynamic importer reads the whole namespace by computed key, so Rollup can't tree-shake the
 * module for anyone reaching it) - which is how the whole icon set (~790 KB gzipped) ended up
 * eager on every route. A static JSON asset isn't part of any JS module graph, so it can't be
 * pulled into that shared chunk. This only ever runs in Node (build/dev), never in client code.
 */
const mdiIconPaths = (): Plugin => ({
  name: 'frameleaf-mdi-icon-paths',
  async buildStart() {
    const mdi = await import('@mdi/js');
    const paths = Object.fromEntries(Object.entries(mdi).filter(([name]) => name !== 'default'));
    await writeFile(path.resolve(import.meta.dirname, 'static/mdi-icon-paths.json'), JSON.stringify(paths));
    // The extra icon packs are static assets for the same reason, one per pack so a page that
    // draws a single Tabler icon never downloads Material Symbols.
    const directory = path.resolve(import.meta.dirname, 'static/icon-packs');
    await mkdir(directory, { recursive: true });
    for (const { prefix, icons } of buildIconPacks()) {
      await writeFile(path.join(directory, `${prefix}.json`), JSON.stringify(icons));
    }
  },
});

/**
 * FL-1797: the translated messages as one small module per language and part of the app, instead
 * of one file per language holding every message. `i18n/<language>.json` stays the only place a
 * message is written; scripts/message-areas.mjs decides which bundle each key belongs to.
 *
 *  - `virtual:frameleaf-messages` lists the languages and a lazy loader for each of their bundles;
 *  - `virtual:frameleaf-messages/<language>/<bundle>` is one bundle.
 *
 * Only a build splits by area. The development server and unit tests put every message in `core`,
 * so adding a key never needs a restart there.
 */
const MESSAGES = 'virtual:frameleaf-messages';
const frameleafMessages = (): Plugin => {
  const directory = path.resolve(import.meta.dirname, '../i18n');
  let split = false;
  let areaOf: Record<string, string> | undefined;
  // Each language file is read once per change of the file, not once per module that needs it.
  const read = new Map<string, { mtime: number; messages: Record<string, string> }>();
  const language = (code: string) => {
    const mtime = statSync(path.join(directory, `${code}.json`)).mtimeMs;
    let cached = read.get(code);
    if (cached?.mtime !== mtime) {
      cached = { mtime, messages: readLanguage(directory, code) };
      read.set(code, cached);
    }
    return cached.messages;
  };
  const built = new Map<string, ReturnType<typeof bundlesFor>>();
  const bundles = (code: string) => {
    const en = language('en');
    if (split) {
      areaOf ??= analyse({ src: path.resolve(import.meta.dirname, 'src'), keys: Object.keys(en) }).areaOf;
    }
    const own = code === 'en' ? en : language(code);
    const key = `${code}|${read.get('en')?.mtime}|${read.get(code)?.mtime}`;
    let result = built.get(key);
    if (!result) {
      result = bundlesFor({ code, own, en, areaOf });
      built.set(key, result);
    }
    return result;
  };
  return {
    name: 'frameleaf-messages',
    configResolved(config) {
      split = config.command === 'build';
    },
    buildStart() {
      // `vite build --watch`: each rebuild places the keys again, from the source as it is now.
      areaOf = undefined;
      built.clear();
    },
    resolveId(id) {
      if (id === MESSAGES || id.startsWith(`${MESSAGES}/`)) {
        return `\0${id}`;
      }
    },
    load(id) {
      if (!id.startsWith(`\0${MESSAGES}`)) {
        return;
      }
      const [code, bundle] = id.slice(MESSAGES.length + 2).split('/');
      this.addWatchFile(path.join(directory, 'en.json'));
      if (code) {
        this.addWatchFile(path.join(directory, `${code}.json`));
        // JSON.parse of one string is the quickest way for a browser to read a large table.
        return `export default JSON.parse(${JSON.stringify(JSON.stringify(bundles(code).bundles[bundle] ?? {}))});`;
      }
      const merged: string[] = [];
      const loaders: string[] = [];
      for (const language of languageCodes(directory)) {
        const built = bundles(language);
        if (built.merged) {
          merged.push(language);
        }
        const present = BUNDLES.filter((name) => built.bundles[name]);
        loaders.push(
          `${JSON.stringify(language)}: {${present
            .map(
              (name) => `${JSON.stringify(name)}: () => import(${JSON.stringify(`${MESSAGES}/${language}/${name}`)})`,
            )
            .join(', ')}}`,
        );
      }
      return [
        `export const areaRoutes = ${JSON.stringify(AREAS)};`,
        `export const merged = ${JSON.stringify(merged)};`,
        `export const loaders = {${loaders.join(',\n')}};`,
      ].join('\n');
    },
  };
};

const upstream = {
  target: process.env.FRAMELEAF_SERVER_URL || process.env.IMMICH_SERVER_URL || 'http://frameleaf-server:2283/',
  secure: true,
  changeOrigin: true,
  logLevel: 'info',
  ws: true,
};

const proxy: Record<string, string | ProxyOptions> = {
  '/api': upstream,
  '/.well-known/frameleaf': upstream,
  '/.well-known/immich': upstream,
  '/custom.css': upstream,
};

export default defineConfig({
  build: {
    target: 'es2022',
  },
  resolve: {
    // SvelteKit 3 deprecated its own `alias` option (and dropped the built-in `$lib`), so the
    // import aliases live here; tsconfig.json `paths` mirrors them for type checking.
    alias: {
      'xmlhttprequest-ssl': './node_modules/engine.io-client/lib/xmlhttprequest.js',
      $lib: path.resolve(import.meta.dirname, 'src/lib'),
      $tests: path.resolve(import.meta.dirname, 'tests'),
      '@test-data': path.resolve(import.meta.dirname, 'src/test-data'),
      $i18n: path.resolve(import.meta.dirname, '../i18n'),
      // Third-party acknowledgements and the licence texts that ship with the product (FL-86).
      $licenses: path.resolve(import.meta.dirname, '../licenses'),
      $studioNotices: path.resolve(import.meta.dirname, '../studio/notices'),
      'chromecast-caf-sender': path.resolve(
        import.meta.dirname,
        'node_modules/@types/chromecast-caf-sender/index.d.ts',
      ),
      // '@frameleaf/ui': path.resolve(import.meta.dirname, '../../ui/packages/ui'),
    },
  },
  server: {
    // connect to a remote backend during web-only development
    proxy,
    allowedHosts: true,
  },
  preview: {
    proxy,
  },
  plugins: [
    retainSvelteCss(),
    mdiIconPaths(),
    frameleafMessages(),
    enhancedImages(),
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),
      version: {
        name: process.env.FRAMELEAF_BUILD || process.env.IMMICH_BUILD || process.env.npm_package_version || 'local',
      },
      paths: {
        relative: false,
      },
      adapter: adapter({
        fallback: 'index.html',
        precompress: true,
      }),
      onwarn: (warning, handler) => {
        if (warning.code === 'state_referenced_locally') {
          return;
        }
        handler(warning);
      },
    }),
    process.env.BUILD_STATS === 'true'
      ? visualizer({
          emitFile: true,
          filename: 'stats.html',
        })
      : undefined,
    svelteTesting(),
  ],
  optimizeDeps: {
    entries: [
      'src/**/*.{svelte,ts,html}',
      '!src/**/*.{test,spec}.{js,ts}',
      '!src/**/__{test,tests,mocks}__/**',
      '!src/test-data/**',
    ],
  },
  test: {
    name: 'web:unit',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    globals: true,
    environment: 'happy-dom',
    execArgv: ['--no-experimental-webstorage'],
    setupFiles: ['./src/test-data/setup.ts'],
    sequence: {
      hooks: 'list',
    },
    env: {
      TZ: 'UTC',
    },
  },
} as UserConfig);
