import { resolve } from 'node:path';
import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    target: 'chrome116',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content.ts'),
      name: 'FrameleafDiscovery',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
