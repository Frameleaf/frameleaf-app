/**
 * Build and test configuration for the Frameleaf web adapter (FL-88).
 *
 * The adapter is compiled against the prepared engine workspace (`studio/engine`, produced by
 * `node studio/tools/engine.mjs prepare`), never against the vendor snapshot, and it installs
 * nothing: every bare import resolves from `studio/engine/node_modules`, the lockfile-pinned
 * dependencies of the engine it wraps. Output goes to `web/static/studio-engine`, which the web
 * build serves at `/studio-engine/`; that directory is generated and ignored.
 *
 * Run it through the engine's own toolchain:
 *
 *   node studio/tools/adapter.mjs build     # or: test
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const studio = path.resolve(here, '../..')
const repository = path.resolve(studio, '..')
const engine = path.join(studio, 'engine')
const engineRequire = createRequire(path.join(engine, 'package.json'))
const outDir = path.join(repository, 'web/static/studio-engine')

/**
 * Adapter sources live outside the engine workspace, so Node resolution would never reach its
 * `node_modules`. Resolve their bare imports as if they were written inside `studio/engine/src`.
 */
const resolveFromEngine = () => ({
  name: 'frameleaf-resolve-from-engine',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null
    if (source.startsWith('@/') || source.startsWith('@frameleaf/')) return null
    if (!importer.startsWith(here) || importer.startsWith(engine)) return null
    return this.resolve(source, path.join(engine, 'src/main.tsx'), { ...options, skipSelf: true })
  },
})

const plugins = async () => {
  const react = engineRequire('@vitejs/plugin-react')
  const tailwind = await import(engineRequire.resolve('@tailwindcss/vite'))
  return [resolveFromEngine(), (react.default ?? react)(), (tailwind.default ?? tailwind)()]
}

export default async () => ({
  root: here,
  base: '/studio-engine/',
  // Nothing from the engine's public folder ships: its landing images are not Studio, and its
  // bundled TTS model is rights-blocked (FL-86).
  publicDir: false,
  plugins: await plugins(),
  resolve: {
    alias: {
      '@frameleaf/host': path.join(repository, 'web/src/lib/frameleaf/studio'),
      '@': path.join(engine, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    // The engine reads this to decide whether its landing page and PWA bits exist; Studio has none.
    'import.meta.env.VITE_FRAMELEAF_STUDIO': JSON.stringify('1'),
  },
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        editor: path.join(here, 'editor.html'),
        commands: path.join(here, 'commands.html'),
      },
    },
  },
  test: {
    root: here,
    globals: true,
    environment: 'jsdom',
    setupFiles: [path.join(engine, 'src/test/setup.ts')],
    include: ['test/**/*.test.ts'],
  },
})
