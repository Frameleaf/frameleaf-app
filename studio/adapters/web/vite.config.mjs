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
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
// The engine's own chunking rules: they exist to keep production builds free of circular-chunk
// initialisation errors, so the adapter build must split the engine exactly the same way.
import engineConfig, { stableAssetSourcemapsPlugin } from '../../engine/vite.config.ts'
// The manifest speaks the host's protocol version, so a stale build is refused rather than downgraded.
import { STUDIO_FRAME_PROTOCOL_VERSION } from '../../../web/src/lib/frameleaf/studio/frame-protocol.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const studio = path.resolve(here, '../..')
const repository = path.resolve(studio, '..')
const engine = path.join(studio, 'engine')
const engineRequire = createRequire(path.join(engine, 'package.json'))
const outDir = path.join(repository, 'web/static/studio-engine')
const build = JSON.parse(readFileSync(path.join(studio, 'engine-build.json'), 'utf8'))

/** Engine modules the adapter replaces with host-backed equivalents (see `resolve.alias`). */
const substitutedModules = {
  '@/features/export/components/export-dialog': 'export-dialog.tsx',
  '@/features/export/components/exports-dialog': 'exports-dialog.tsx',
  '@/features/project-bundle/components/bundle-export-dialog': 'bundle-export-dialog.tsx',
}

/** Feature rows this build implements and tests (FL-92's command rows); FL-85 owns the rest. */
const claimedFeatures = JSON.parse(
  readFileSync(path.join(studio, 'freecut-feature-manifest.json'), 'utf8'),
)
  .features.map((feature) => feature.id)
  .filter((id) => id.startsWith('command.'))
  .sort()

/** `manifest.json` next to the documents: what the host loader checks before it mounts anything. */
const frameManifest = () => ({
  name: 'frameleaf-frame-manifest',
  apply: 'build',
  closeBundle() {
    const manifest = {
      protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
      engineRevision: build.upstreamCommit,
      sourceSha256: build.sourceSha256,
      features: claimedFeatures,
      editor: 'editor.html',
      commands: 'commands.html',
    }
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    // The licence texts travel with the code they cover: Freecut's MIT notice first among them.
    cpSync(path.join(studio, 'notices'), path.join(outDir, 'notices'), { recursive: true })
  },
})

/**
 * Adapter sources live outside the engine workspace, so Node resolution would never reach its
 * `node_modules`. Resolve their bare imports as if they were written inside `studio/engine/src`.
 */
const resolveFromEngine = () => ({
  name: 'frameleaf-resolve-from-engine',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || source.startsWith('.') || source.startsWith('/') || source.startsWith('\0'))
      return null
    if (source.startsWith('@/') || source.startsWith('@frameleaf/')) return null
    if (!importer.startsWith(here) || importer.startsWith(engine)) return null
    return this.resolve(source, path.join(engine, 'src/main.tsx'), { ...options, skipSelf: true })
  },
})

/**
 * Freecut's timeline persistence is reached by relative imports too (the store facade imports
 * `./timeline-persistence`), which an alias cannot see. Every import that resolves to that file is
 * given the gated shim instead; only the shim itself reaches the engine's module (FL-89).
 */
const persistenceModule = path.join(engine, 'src/features/timeline/stores/timeline-persistence.ts')
const persistenceShim = path.join(here, 'src/shims/timeline-persistence.ts')
const gateTimelinePersistence = () => ({
  name: 'frameleaf-gate-timeline-persistence',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || importer === persistenceShim || !source.includes('timeline-persistence'))
      return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return resolved?.id === persistenceModule ? persistenceShim : null
  },
})

/**
 * Freecut's own lifecycle suites run in the adapter's test run against the adapter's workspace
 * (FL-91). Their workspace double, `workspace-fs/__tests__/in-memory-handle`, is reached by relative
 * imports, so every import that resolves to it is given the adapter's version, which answers the same
 * API with `VirtualWorkspace`. Nothing in the engine is edited.
 */
const upstreamWorkspaceDouble = path.join(
  engine,
  'src/infrastructure/storage/workspace-fs/__tests__/in-memory-handle.ts',
)
const adapterWorkspaceDouble = path.join(here, 'test/upstream/in-memory-handle.ts')
const useAdapterWorkspace = () => ({
  name: 'frameleaf-upstream-tests-on-virtual-workspace',
  apply: 'serve',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !source.includes('in-memory-handle')) return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return resolved?.id === upstreamWorkspaceDouble ? adapterWorkspaceDouble : null
  },
})

/**
 * Freecut's suites for what the adapter replaces or runs on: the storage layer (workspace-fs
 * primitives, projects, trash, media, caches), project lifecycle, and project bundles. Paths are
 * relative to `studio/`, the test directory.
 */
const upstreamSuites = [
  'engine/src/infrastructure/storage/workspace-fs/**/*.test.ts',
  'engine/src/features/projects/**/*.test.{ts,tsx}',
  'engine/src/features/project-bundle/**/*.test.ts',
]

const plugins = async () => {
  const react = engineRequire('@vitejs/plugin-react')
  const tailwind = await import(engineRequire.resolve('@tailwindcss/vite'))
  return [
    resolveFromEngine(),
    gateTimelinePersistence(),
    useAdapterWorkspace(),
    (react.default ?? react)(),
    (tailwind.default ?? tailwind)(),
    frameManifest(),
    // The engine's fix for asset handles in sourcemaps, so the shipped build reproduces too.
    stableAssetSourcemapsPlugin(),
  ]
}

export default async () => ({
  root: here,
  base: '/studio-engine/',
  // Nothing from the engine's public folder ships: its landing images are not Studio, and its
  // bundled TTS model is rights-blocked (FL-86).
  publicDir: false,
  plugins: await plugins(),
  resolve: {
    alias: [
      // Freecut's own exports render in the browser and save into its workspace. In Frameleaf the
      // editor's Export, exports list and project bundle go to the host's export, Activity and
      // portable-bundle paths instead (FL-88), so these three modules are substituted, never edited.
      ...Object.entries(substitutedModules).map(([engineModule, shim]) => ({
        find: new RegExp(`^${engineModule.replaceAll('/', '\\/')}$`),
        replacement: path.join(here, 'src/shims', shim),
      })),
      { find: '@frameleaf/host', replacement: path.join(repository, 'web/src/lib/frameleaf/studio') },
      { find: '@', replacement: path.join(engine, 'src') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: engineConfig.optimizeDeps,
  define: {
    __FRAMELEAF_ENGINE_REVISION__: JSON.stringify(build.upstreamCommit),
    __FRAMELEAF_ENGINE_SOURCE_SHA256__: JSON.stringify(build.sourceSha256),
  },
  worker: engineConfig.worker,
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: engineConfig.build.chunkSizeWarningLimit,
    rollupOptions: {
      input: {
        editor: path.join(here, 'editor.html'),
        commands: path.join(here, 'commands.html'),
      },
      output: engineConfig.build.rollupOptions.output,
    },
  },
  test: {
    root: here,
    // The adapter's tests and Freecut's own suites (`upstreamSuites`) share one run.
    dir: studio,
    globals: true,
    // The interleaving models in draft-sync are CPU-bound; sharing workers with Freecut's suites can
    // push one past the default 5 s on a busy runner. A hang still fails.
    testTimeout: 30_000,
    environment: 'jsdom',
    setupFiles: [path.join(engine, 'src/test/setup.ts')],
    include: ['adapters/web/test/**/*.test.ts', ...upstreamSuites],
  },
})
