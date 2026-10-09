#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import net from 'node:net'
import { inventory, admitAdaptedSource } from '../../engine.mjs'
import { COMPOSITION_SOURCES } from '../../geometry-composition-reference.mjs'
import { createHarness } from '../../lib/cross-browser-harness.mjs'
import {
  PINS,
  BOUNDS,
  CASES,
  WAV_SHA256,
  assertCaptureArgs,
  assertPins,
  assertProxy,
  bounded,
  captureArgs,
  captureWav,
  cleanupAll,
  ownedProcesses,
  recordingBytes,
  reportBytes,
  sha,
} from './controls.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const inputRoot = process.env.FL103_SOURCE_ROOT
const output = process.env.FL103_EVIDENCE
const executable =
  '/Users/adamtaylor/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
const git = (...args) => execFileSync('git', args, { cwd: inputRoot, encoding: 'utf8' }).trim()

async function safeInputs() {
  assert.equal(
    inputRoot,
    '/Users/adamtaylor/.codex/worktrees/fl105-durable-sidecar/immich',
    'only the reviewed read-only prepared input root is permitted',
  )
  for (const dir of [inputRoot, output]) {
    assert(dir && path.isAbsolute(dir), 'absolute source/evidence roots required')
    assert.equal(await realpath(dir), dir, 'no symlink roots')
    assert((await lstat(dir)).isDirectory())
  }
  assert(
    !output.startsWith(inputRoot + '/') && !inputRoot.startsWith(output + '/'),
    'evidence must be outside input root',
  )
  assert.equal((await lstat(output)).mode & 0o077, 0, 'private evidence directory required')
  git('merge-base', '--is-ancestor', PINS.baseline, 'HEAD')
  git('diff', '--exit-code', PINS.baseline, '--', 'studio')
  assert.equal(
    git('status', '--porcelain', '--untracked-files=no'),
    '',
    'dirty tracked source root',
  )
}
export async function bindings() {
  await safeInputs()
  const build = await json(inputRoot + '/studio/engine-build.json')
  assert.equal(sha(captureWav()), WAV_SHA256, 'synthetic WAV pin')
  const source = await inventory(
    inputRoot + '/studio/engine',
    '',
    new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']),
  )
  await admitAdaptedSource(source, PINS.source)
  assert.equal(build.sourceSha256, PINS.source)
  for (const receipt of ['frameleaf-source.json', 'frameleaf-build.json'])
    assert.equal(
      (await json(inputRoot + '/studio/engine/' + receipt)).sourceSha256,
      PINS.source,
      `receipt source ${receipt}`,
    )
  assert.equal(
    sha(await readFile(inputRoot + '/studio/engine-package-lock.json')),
    build.lockfileSha256,
    'canonical lockfile digest',
  )
  for (const patch of build.patches)
    assert.equal(
      sha(await readFile(`${inputRoot}/studio/${patch.path}`)),
      patch.sha256,
      `patch ${patch.path}`,
    )
  for (const [file, digest] of Object.entries(COMPOSITION_SOURCES))
    assert.equal(
      sha(await readFile(`${inputRoot}/studio/engine/${file}`)),
      digest,
      `protected ${file}`,
    )
  const browsers = await json(
    inputRoot + '/studio/engine/node_modules/playwright-core/browsers.json',
  )
  const browserPin = browsers.browsers.find((x) => x.name === 'chromium-headless-shell')
  const observed = {
    source: build.sourceSha256,
    baseline: PINS.baseline,
    playwright: (await json(inputRoot + '/studio/engine/node_modules/playwright/package.json'))
      .version,
    revision: browserPin.revision,
    browser: browserPin.browserVersion,
    executable: sha(await readFile(executable)),
  }
  assertPins(observed)
  assert.equal(
    (await json(inputRoot + '/studio/engine/package.json')).devDependencies.playwright,
    PINS.playwright,
  )
  assert.equal(process.versions.node, build.node, 'pinned Node required')
  const rootFiles = [
    'studio/engine-build.json',
    'studio/engine-package-lock.json',
    'studio/freecut-provenance.json',
    'studio/rights-approval.json',
    'studio/engine/frameleaf-source.json',
    'studio/engine/frameleaf-build.json',
  ]
  const files = await Promise.all(
    rootFiles.map(async (file) => ({
      path: file,
      sha256: sha(await readFile(inputRoot + '/' + file)),
    })),
  )
  const adapter = await inventory(inputRoot + '/studio/adapters/web/src')
  const tools = await inventory(inputRoot + '/studio/tools')
  const packet = await inventory(here)
  const dependencies = {}
  for (const name of [
    'vite-plus',
    '@voidzero-dev/vite-plus-core',
    '@voidzero-dev/vite-plus-darwin-arm64',
    '@rolldown/binding-darwin-arm64',
    '@vitejs/plugin-react',
    'playwright',
    'playwright-core',
  ]) {
    const directory = inputRoot + '/studio/engine/node_modules/' + name
    dependencies[name] = await inventory(directory)
  }
  const browserResources = await inventory(path.dirname(executable))
  return {
    inputRoot,
    inputHead: git('rev-parse', 'HEAD'),
    toolchain: {
      node: process.versions.node,
      executable: await realpath(process.execPath),
      sha256: sha(await readFile(process.execPath)),
    },
    source: observed,
    sourceInputs: source,
    files,
    adapter,
    tools,
    packet,
    dependencies,
    browserResources,
    wav: { sha256: sha(captureWav()), bytes: captureWav().length },
    protected: COMPOSITION_SOURCES,
  }
}
async function viteConfig(cacheDir, port) {
  const require = createRequire(inputRoot + '/studio/engine/package.json')
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))
  return {
    configFile: false,
    root: here,
    publicDir: false,
    cacheDir,
    plugins: [react()],
    resolve: {
      alias: [
        { find: /^@\//, replacement: inputRoot + '/studio/engine/src/' },
        { find: '@fl103-adapter', replacement: inputRoot + '/studio/adapters/web/src' },
      ],
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      fs: {
        strict: true,
        allow: [here, inputRoot + '/studio/engine', inputRoot + '/studio/adapters/web/src'],
      },
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    build: { outDir: output + '/source-bundle', emptyOutDir: false },
  }
}
async function reservePort() {
  const reservation = net.createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((e) => (e ? reject(e) : resolve())))
  return port
}
async function assertPortClosed(port) {
  await bounded(
    () =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port })
        socket.once('connect', () => {
          socket.destroy()
          reject(Error(`port remains open: ${port}`))
        })
        socket.once('error', (e) => (e.code === 'ECONNREFUSED' ? resolve() : reject(e)))
      }),
    1000,
    'port closure',
  )
}
async function attempt(manifestFile, expected) {
  assert.equal(
    process.env.FL103_INTERNAL_ATTEMPT,
    expected,
    'use the reviewed supervisor, never direct attempt',
  )
  const frozen = await readFile(manifestFile)
  assert.equal(sha(frozen), expected, 'manifest hash')
  const manifest = JSON.parse(frozen)
  assert.deepEqual(
    await bindings(),
    manifest,
    'source/browser/fixture/adapter/tool binding changed',
  )
  const report = {
    status: 'refused',
    scope:
      'controlled Chromium synthetic capture and local memory handoff; no host/worker/backend qualification',
    startedAt: new Date().toISOString(),
    manifestSha256: expected,
    cases: [],
    cleanup: null,
  }
  let server, proxy, browserServer, browser, context, page, origin
  const require = createRequire(inputRoot + '/studio/engine/package.json')
  const { createServer } = await import(
    pathToFileURL(require.resolve('@voidzero-dev/vite-plus-core'))
  )
  const { chromium } = require('playwright')
  const wavPath = output + '/capture.wav'
  const ports = []
  const errors = []
  try {
    await writeFile(wavPath, captureWav(), { flag: 'wx', mode: 0o600 })
    assert.equal(sha(await readFile(wavPath)), manifest.wav.sha256)
    const args = captureArgs(wavPath)
    assertCaptureArgs(args, wavPath)
    const port = await reservePort()
    ports.push(port)
    origin = `http://127.0.0.1:${port}`
    server = await createServer(await viteConfig(output + '/vite-cache', port))
    await bounded(() => server.listen(), BOUNDS.operation, 'owned Vite listen')
    proxy = createHarness({ upstream: origin, inspectConnect: true })
    const proxyOrigin = await proxy.listen()
    ports.push(Number(new URL(proxyOrigin).port))
    browserServer = await chromium.launchServer({
      headless: true,
      executablePath: executable,
      args,
      proxy: { server: proxyOrigin },
      timeout: BOUNDS.operation,
    })
    report.browserPid = browserServer.process().pid
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: BOUNDS.operation })
    assert.equal(browser.version(), PINS.browser, 'actual browser version')
    report.browser = {
      version: browser.version(),
      revision: PINS.revision,
      executableSha256: PINS.executable,
    }
    for (const name of CASES) {
      await bounded(
        async () => {
          context = await browser.newContext({ serviceWorkers: 'block' })
          context.setDefaultTimeout(BOUNDS.operation)
          page = await context.newPage()
          if (name === 'denial') {
            const cdp = await context.newCDPSession(page)
            try {
              const { targetInfo } = await cdp.send('Target.getTargetInfo')
              assert(
                targetInfo.browserContextId,
                'native isolated browser context identity required',
              )
              await cdp.send('Browser.setPermission', {
                permission: { name: 'audioCapture' },
                setting: 'denied',
                origin,
                browserContextId: targetInfo.browserContextId,
              })
            } finally {
              await cdp.detach()
            }
          } else await context.grantPermissions(['microphone'], { origin })
          page.on('pageerror', (error) => errors.push(String(error)))
          await page.goto(origin + '/', { waitUntil: 'load' })
          const userAgent = await page.evaluate(() => navigator.userAgent)
          assert(userAgent.includes(PINS.browser), 'actual browser UA')
          await page.waitForFunction(() => window.fl103?.ready)
          await page.click('#activate')
          const result = await page.evaluate((name) => window.fl103.run(name), name)
          for (const key of ['audio', 'retiredAudio'])
            if (result.measurement[key]) {
              const audio = result.measurement[key]
              const file = `${name}-${key}.encoded`
              await writeFile(output + '/' + file, recordingBytes(audio), {
                flag: 'wx',
                mode: 0o600,
              })
              delete audio.encodedBase64
              audio.artifact = file
            }
          assert(
            result.events
              .filter((x) =>
                ['start', 'pause', 'resume', 'dataavailable', 'stop', 'error'].includes(x.event),
              )
              .every((x) => x.trusted),
            'native MediaRecorder events must be trusted',
          )
          report.cases.push(result)
          const resources = await bounded(
            () => page.evaluate(() => window.fl103.cleanup()),
            BOUNDS.operation,
            'case native cleanup',
          )
          result.cleanup = resources
          await context.close()
          context = null
          page = null
        },
        BOUNDS.case,
        name,
      )
    }
    assert.deepEqual(errors, [], 'browser page errors')
    assert.deepEqual(
      report.cases.map((x) => x.name),
      CASES,
    )
    assertProxy(proxy.observations, origin)
    report.proxy = proxy.observations
    assert.deepEqual(await bindings(), manifest, 'input mutation during browser run')
    report.status = 'measured'
  } catch (error) {
    report.error = String(error)
  } finally {
    report.cleanup = await cleanupAll(
      [
        [
          'fixture',
          async () => {
            if (page) await page.evaluate(() => window.fl103?.cleanup())
          },
        ],
        [
          'context',
          async () => {
            if (context) await context.close()
          },
        ],
        [
          'browser',
          async () => {
            if (browser) await browser.close()
          },
        ],
        [
          'browser-server',
          async () => {
            if (browserServer) await browserServer.close()
          },
        ],
        [
          'final-network-witness',
          () => {
            if (proxy) {
              assertProxy(proxy.observations, origin)
              report.proxy = proxy.observations
            }
          },
        ],
        [
          'proxy',
          async () => {
            if (proxy) await proxy.close()
          },
        ],
        [
          'vite',
          async () => {
            if (server) await server.close()
          },
        ],
        ...ports.map((port) => [`port-${port}`, () => assertPortClosed(port)]),
      ],
      Math.floor(BOUNDS.cleanup / 9),
    )
    if (report.cleanup.failures.length) report.status = 'refused'
    report.finishedAt = new Date().toISOString()
    await writeFile(output + '/attempt.json', reportBytes(report), { flag: 'wx', mode: 0o600 })
  }
  assert.equal(report.status, 'measured', report.error ?? 'cleanup refusal')
}
function census(group, known) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const fields = line.trim().split(/\s+/)
      return {
        pid: Number(fields[0]),
        parent: Number(fields[1]),
        group: Number(fields[2]),
        started: fields.slice(3).join(' '),
      }
    })
  return ownedProcesses(rows, group, known)
}
async function supervise(manifestFile, expected) {
  await safeInputs()
  assert.match(expected, /^[a-f0-9]{64}$/)
  assert.equal(sha(await readFile(manifestFile)), expected)
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--attempt', manifestFile, expected],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FL103_INTERNAL_ATTEMPT: expected },
    },
  )
  const log = []
  const known = new Map()
  let bytes = 0,
    timedOut = false,
    signal = false
  let censusError
  const stop = (sig) => {
    try {
      process.kill(-child.pid, sig)
    } catch {}
    try {
      for (const row of census(child.pid, known))
        if (row.group !== child.pid) {
          try {
            process.kill(row.pid, sig)
          } catch {}
        }
    } catch (error) {
      censusError = String(error)
    }
  }
  const interrupted = () => {
    signal = true
    stop('SIGTERM')
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  const observer = setInterval(() => {
    try {
      census(child.pid, known)
    } catch (error) {
      censusError = String(error)
      stop('SIGTERM')
    }
  }, 250)
  const collect = (chunk) => {
    bytes += chunk.length
    if (bytes <= BOUNDS.report) log.push(chunk)
    else {
      signal = true
      stop('SIGTERM')
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const terminal = once(child, 'exit')
  const timer = setTimeout(() => {
    timedOut = true
    stop('SIGTERM')
  }, BOUNDS.overall)
  const killTimer = setTimeout(() => stop('SIGKILL'), BOUNDS.overall + BOUNDS.cleanup)
  let code, exitSignal
  try {
    ;[code, exitSignal] = await terminal
  } finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    clearInterval(observer)
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
  let survivors = census(child.pid, known)
  const beforeTermination = survivors
  if (survivors.length) {
    stop('SIGTERM')
    await bounded(
      async () => {
        while (census(child.pid, known).length)
          await new Promise((resolve) => setTimeout(resolve, 100))
      },
      BOUNDS.cleanup,
      'owned group termination',
    ).catch(() => {})
    survivors = census(child.pid, known)
    if (survivors.length) {
      stop('SIGKILL')
      await bounded(
        async () => {
          while (census(child.pid, known).length)
            await new Promise((resolve) => setTimeout(resolve, 100))
        },
        1000,
        'post-kill owned census',
      ).catch(() => {})
      survivors = census(child.pid, known)
    }
  }
  await writeFile(output + '/runtime.log', Buffer.concat(log), { flag: 'wx', mode: 0o600 })
  let result
  try {
    result = await json(output + '/attempt.json')
  } catch {
    result = { status: 'missing' }
  }
  const summary = {
    code,
    exitSignal,
    timedOut,
    logOverflow: bytes > BOUNDS.report,
    interrupted: signal,
    group: child.pid,
    beforeTermination,
    survivors,
    censusError,
    observed: [...known].map(([pid, started]) => ({ pid, started })),
    status:
      code === 0 &&
      !timedOut &&
      !signal &&
      !censusError &&
      beforeTermination.length === 0 &&
      result.status === 'measured'
        ? 'measured'
        : 'refused',
    detachedDescendants:
      '250ms process ancestry census plus whole owned group; descendants that detach before observation cannot be exhaustively certified',
    finishedAt: new Date().toISOString(),
  }
  await writeFile(output + '/supervisor.json', reportBytes(summary), { flag: 'wx', mode: 0o600 })
  assert.equal(summary.status, 'measured', 'supervised packet refused; preserve raw report/log')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, file, digest] = process.argv.slice(2)
  if (mode === '--freeze' && file && !digest) {
    await writeFile(file, reportBytes(await bindings()), { flag: 'wx', mode: 0o600 })
  } else if (mode === '--source-build' && !file) {
    await safeInputs()
    const require = createRequire(inputRoot + '/studio/engine/package.json')
    const { build } = await import(pathToFileURL(require.resolve('@voidzero-dev/vite-plus-core')))
    await build(await viteConfig(output + '/vite-build-cache', 0))
  } else if (mode === '--execute-reviewed' && file && digest) await supervise(file, digest)
  else if (mode === '--attempt' && file && digest) await attempt(file, digest)
  else
    throw Error(
      'Usage: --freeze MANIFEST | --source-build | --execute-reviewed MANIFEST SHA256; runtime requires separate root authorization',
    )
}
