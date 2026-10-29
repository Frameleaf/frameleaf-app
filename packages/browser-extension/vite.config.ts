import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import manifest from './manifest.chromium.json' with { type: 'json' };

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'frameleaf-extension-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: JSON.stringify(manifest, null, 2),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/Inter.txt',
          source: readFileSync(
            resolve(
              import.meta.dirname,
              '../../web/src/lib/assets/fonts/Inter/LICENSE',
            ),
          ),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/AGPL.txt',
          source: readFileSync(resolve(import.meta.dirname, '../../LICENSE')),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/srcset.txt',
          source: readFileSync(
            resolve(import.meta.dirname, 'node_modules/srcset/license'),
          ),
        });
        for (const size of [16, 48, 128])
          this.emitFile({
            type: 'asset',
            fileName: `icons/icon${size}.png`,
            source: readFileSync(
              resolve(
                import.meta.dirname,
                `../../web/static/favicon-${size}.png`,
              ),
            ),
          });
      },
    },
  ],
  build: {
    target: 'chrome116',
    sourcemap: false,
    rolldownOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        capture: resolve(import.meta.dirname, 'capture.html'),
        options: resolve(import.meta.dirname, 'options.html'),
        background: resolve(import.meta.dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  test: { include: ['src/**/*.spec.ts'], maxWorkers: 1 },
});
