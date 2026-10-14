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
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  },
});

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
    alias: {
      'xmlhttprequest-ssl': './node_modules/engine.io-client/lib/xmlhttprequest.js',
      // eslint-disable-next-line unicorn/prefer-module
      '@test-data': path.resolve(import.meta.dirname, './src/test-data'),
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
      alias: {
        $lib: 'src/lib',
        '$lib/*': 'src/lib/*',
        $tests: 'src/../tests',
        '$tests/*': 'src/../tests/*',
        '@test-data': 'src/test-data',
        $i18n: '../i18n',
        // Third-party acknowledgements and the licence texts that ship with the product (FL-86).
        $licenses: '../licenses',
        $studioNotices: '../studio/notices',
        'chromecast-caf-sender': './node_modules/@types/chromecast-caf-sender/index.d.ts',
      },
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
    entries: ['src/**/*.{svelte,ts,html}'],
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
