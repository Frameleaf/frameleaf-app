import { LoginResponseDto, defaults } from '@frameleaf/sdk';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { makeRandomImage } from 'src/generators.js';
import { utils } from 'src/utils.js';

/**
 * FL-139: generic runs report one measurement; admitted reference runs collect a finite calibration
 * or compare with reviewed empirical ceilings. First-thumbnail time ends at visible-element readiness,
 * not decoded pixels, first paint or LCP. Every attempt is retained in the Playwright attachments.
 */
const LIBRARY_ITEMS = 200;
// The bounded worker pipeline needs several minutes for 200 uploads on CI; preparation is not measured.
const PREPARATION_TIMEOUT = 600_000;
const PERFORMANCE_PROTOCOL = 'fl139-library32-cold-context-warm-stack-v1';
const REFERENCE_CONTEXT = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  reducedMotion: 'no-preference',
  colorScheme: 'light',
} as const;

const performanceSchedule = (mode: string) => {
  if (!['report', 'calibrate', 'validate'].includes(mode)) {
    throw new Error('Invalid performance mode');
  }
  const warmups = mode === 'report' ? 0 : 3;
  const measured = mode === 'calibrate' ? 30 : mode === 'validate' ? 3 : 1;
  return Array.from({ length: warmups + measured }, (_, index) => ({
    index,
    warmup: index < warmups,
    block: index < warmups ? null : Math.floor((index - warmups) / 10),
    pauseBeforeMs: mode === 'calibrate' && (index === 13 || index === 23) ? 60_000 : 0,
  }));
};

type Measurement = {
  libraryItems: number;
  startup: { domContentLoadedMs: number; loadMs: number };
  firstThumbnailMs: number;
  scroll: {
    frames: number;
    longFrames: number;
    medianFrameMs: number;
    worstFrameMs: number;
    diagnostics: { scrollHeight: number; clientHeight: number; start: number; bottom: number; back: number };
  };
};

const validateMeasurements = (report: Measurement) => {
  const scroll = report.scroll;
  const diagnostics = scroll?.diagnostics;
  const values = [
    report.startup?.domContentLoadedMs,
    report.startup?.loadMs,
    report.firstThumbnailMs,
    scroll?.longFrames,
    scroll?.medianFrameMs,
    scroll?.worstFrameMs,
  ];
  if (
    report.libraryItems !== LIBRARY_ITEMS ||
    values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0) ||
    report.firstThumbnailMs <= 0 ||
    !scroll ||
    !Number.isSafeInteger(scroll.frames) ||
    scroll.frames <= 0 ||
    !Number.isSafeInteger(scroll.longFrames) ||
    scroll.longFrames > scroll.frames ||
    scroll.worstFrameMs < scroll.medianFrameMs ||
    !diagnostics ||
    [diagnostics.scrollHeight, diagnostics.clientHeight, diagnostics.start, diagnostics.bottom, diagnostics.back].some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    ) ||
    diagnostics.scrollHeight <= diagnostics.clientHeight ||
    diagnostics.bottom <= diagnostics.start ||
    diagnostics.bottom < diagnostics.scrollHeight - diagnostics.clientHeight - 1 ||
    diagnostics.back > 1
  ) {
    throw new Error('Invalid performance measurement');
  }
};

const referenceLimits = (profile: Record<string, unknown>) => {
  const keys = [
    'startup.domContentLoadedMs',
    'startup.loadMs',
    'firstThumbnailMs',
    'scroll.longFrames',
    'scroll.medianFrameMs',
    'scroll.worstFrameMs',
  ];
  const limits = profile.limits as Record<string, number> | undefined;
  if (
    profile.schema !== 1 ||
    profile.protocol !== PERFORMANCE_PROTOCOL ||
    profile.approved !== true ||
    typeof profile.environmentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(profile.environmentSha256) ||
    !limits ||
    Object.keys(limits).length !== keys.length ||
    keys.some((key) => typeof limits[key] !== 'number' || !Number.isFinite(limits[key]) || limits[key] < 0)
  ) {
    throw new Error('Invalid performance profile');
  }
  return limits;
};

const validateProfileAdmission = (profile: Record<string, unknown>) => {
  referenceLimits(profile);
  const baseline = profile.baselineApplication as Record<string, unknown> | undefined;
  const samples = profile.sampleSha256;
  if (
    !baseline ||
    !/^[a-f0-9]{40}$/.test(String(baseline.sourceCommit)) ||
    ['imageSha256', 'webManifestSha256'].some((key) => !/^[a-f0-9]{64}$/.test(String(baseline[key]))) ||
    typeof baseline.webIdentity !== 'string' ||
    !baseline.webIdentity.trim() ||
    !Array.isArray(samples) ||
    samples.length !== 30 ||
    new Set(samples).size !== 30 ||
    samples.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
    typeof profile.measuredAt !== 'string' ||
    !Number.isFinite(Date.parse(profile.measuredAt)) ||
    new Date(profile.measuredAt).toISOString() !== profile.measuredAt ||
    !/^[a-f0-9]{64}$/.test(String(profile.datasetSha256)) ||
    !/^[a-f0-9]{64}$/.test(String(profile.rootApprovalReceiptSha256))
  ) {
    throw new Error('Invalid baseline evidence');
  }
};

const compareMeasurements = (report: Measurement, profile: Record<string, unknown>) => {
  validateMeasurements(report);
  const limits = referenceLimits(profile);
  const values = {
    'startup.domContentLoadedMs': report.startup.domContentLoadedMs,
    'startup.loadMs': report.startup.loadMs,
    firstThumbnailMs: report.firstThumbnailMs,
    'scroll.longFrames': report.scroll.longFrames,
    'scroll.medianFrameMs': report.scroll.medianFrameMs,
    'scroll.worstFrameMs': report.scroll.worstFrameMs,
  };
  return Object.entries(values)
    .filter(([key, value]) => value > limits[key])
    .map(([key]) => key);
};

const validateReferenceIdentity = (identity: Record<string, unknown>, observed: Record<string, unknown>) => {
  const keys = [
    'model',
    'cpu',
    'memoryBytes',
    'osVersion',
    'osBuild',
    'nodeVersion',
    'playwrightVersion',
    'browserVersion',
    'power',
    'lowPowerMode',
    'viewportWidth',
    'viewportHeight',
    'deviceScaleFactor',
    'locale',
    'timezone',
    'colorScheme',
    'reducedMotion',
    'cachePolicy',
    'generatorSha256',
    'fixturesSha256',
    'runtimeConfigSha256',
    'browserExecutableSha256',
    'dockerVersion',
    'dockerCpus',
    'dockerMemoryBytes',
  ];
  const environment = identity.environment as Record<string, unknown> | undefined;
  const application = identity.application as Record<string, unknown> | undefined;
  const numericKeys = [
    'memoryBytes',
    'lowPowerMode',
    'viewportWidth',
    'viewportHeight',
    'deviceScaleFactor',
    'dockerCpus',
    'dockerMemoryBytes',
  ];
  if (
    identity.protocol !== PERFORMANCE_PROTOCOL ||
    identity.admitted !== true ||
    !environment ||
    !application ||
    Object.keys(environment).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(environment, key) || !['string', 'number'].includes(typeof environment[key])) ||
    numericKeys.some(
      (key) =>
        typeof environment[key] !== 'number' || !Number.isFinite(environment[key]) || Number(environment[key]) < 0,
    ) ||
    keys
      .filter((key) => !numericKeys.includes(key))
      .some((key) => typeof environment[key] !== 'string' || !environment[key].trim()) ||
    keys.filter((key) => key.endsWith('Sha256')).some((key) => !/^[a-f0-9]{64}$/.test(String(environment[key]))) ||
    ['imageSha256', 'webManifestSha256'].some((key) => !/^[a-f0-9]{64}$/.test(String(application[key]))) ||
    !/^[a-f0-9]{40}$/.test(String(application.sourceCommit)) ||
    typeof application.webIdentity !== 'string' ||
    !application.webIdentity ||
    identity.environmentSha256 !==
      createHash('sha256')
        .update(JSON.stringify(Object.entries(environment).toSorted(([a], [b]) => a.localeCompare(b))))
        .digest('hex')
  ) {
    throw new Error('Invalid reference identity');
  }
  if (keys.some((key) => environment[key] !== observed[key])) {
    throw new Error('Reference environment mismatch');
  }
  const contextIdentity = {
    viewportWidth: REFERENCE_CONTEXT.viewport.width,
    viewportHeight: REFERENCE_CONTEXT.viewport.height,
    deviceScaleFactor: REFERENCE_CONTEXT.deviceScaleFactor,
    locale: REFERENCE_CONTEXT.locale,
    timezone: REFERENCE_CONTEXT.timezoneId,
    reducedMotion: REFERENCE_CONTEXT.reducedMotion,
    colorScheme: REFERENCE_CONTEXT.colorScheme,
    cachePolicy: 'cold-context-warm-stack',
  };
  if (Object.entries(contextIdentity).some(([key, value]) => environment[key] !== value)) {
    throw new Error('Reference context mismatch');
  }
};

type PreparedThumbnail = {
  assetId: string;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
  sha256: string;
};

const validatePreparedThumbnails = (thumbnails: PreparedThumbnail[], assetIds: string[]) => {
  if (
    thumbnails.length !== LIBRARY_ITEMS ||
    assetIds.length !== LIBRARY_ITEMS ||
    thumbnails.some(
      (thumbnail, index) =>
        thumbnail.assetId !== assetIds[index] ||
        !Number.isSafeInteger(thumbnail.width) ||
        thumbnail.width <= 0 ||
        !Number.isSafeInteger(thumbnail.height) ||
        thumbnail.height <= 0 ||
        !Number.isSafeInteger(thumbnail.bytes) ||
        thumbnail.bytes <= 0 ||
        thumbnail.bytes > 1024 * 1024 ||
        !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(thumbnail.contentType) ||
        !/^[a-f0-9]{64}$/.test(thumbnail.sha256),
    )
  ) {
    throw new Error('Invalid prepared thumbnails');
  }
};

test.describe('performance report (FL-139)', () => {
  let admin: LoginResponseDto;
  let identity: Record<string, unknown> | undefined;
  let profile: Record<string, unknown> | undefined;
  let datasetSha256: string | undefined;
  let profileSha256: string | undefined;
  const mode = process.env.FL139_PERFORMANCE_MODE ?? 'report';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(PREPARATION_TIMEOUT);
    performanceSchedule(mode);
    if (mode !== 'report') {
      const path = process.env.FL139_PERFORMANCE_IDENTITY;
      if (!path) {
        throw new Error('Missing admitted reference identity');
      }
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 128 * 1024) {
        throw new Error('Invalid reference identity file');
      }
      identity = JSON.parse(readFileSync(path, 'utf8'));
      const observedPath = process.env.FL139_PERFORMANCE_OBSERVED;
      if (!observedPath || observedPath === path) {
        throw new Error('Missing current reference observations');
      }
      const observedFile = lstatSync(observedPath);
      if (!observedFile.isFile() || observedFile.isSymbolicLink() || observedFile.size > 128 * 1024) {
        throw new Error('Invalid reference observation file');
      }
      const receipt = JSON.parse(readFileSync(observedPath, 'utf8'));
      if (!Number.isFinite(receipt.observedAt) || Math.abs(Date.now() - receipt.observedAt) > 30_000) {
        throw new Error('Stale reference observations');
      }
      if (!identity || !receipt.environment) {
        throw new Error('Invalid reference identity');
      }
      validateReferenceIdentity(identity, {
        ...receipt.environment,
        nodeVersion: process.version,
        browserVersion: browser.version(),
      });
      if (mode === 'validate') {
        const profilePath = process.env.FL139_PERFORMANCE_PROFILE;
        if (!profilePath) {
          throw new Error('Missing reviewed reference profile');
        }
        const profileFile = lstatSync(profilePath);
        if (!profileFile.isFile() || profileFile.isSymbolicLink() || profileFile.size > 128 * 1024) {
          throw new Error('Invalid performance profile');
        }
        const profileBytes = readFileSync(profilePath);
        profile = JSON.parse(profileBytes.toString('utf8'));
        profileSha256 = createHash('sha256').update(profileBytes).digest('hex');
        if (!profile) {
          throw new Error('Invalid performance profile');
        }
        validateProfileAdmission(profile);
        if (profile.environmentSha256 !== identity.environmentSha256) {
          throw new Error('Reference environment mismatch');
        }
      }
    }
    const deadline = Date.now() + PREPARATION_TIMEOUT;
    const signal = AbortSignal.timeout(PREPARATION_TIMEOUT);
    const remainingPreparation = () => {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Preparation deadline');
      }
      return remaining;
    };
    const progressPath = test.info().outputPath('performance-dataset-progress.ndjson');
    const previousSignal = defaults.signal;
    defaults.signal = previousSignal ? AbortSignal.any([previousSignal, signal]) : signal;
    const assets: { assetId: string; sourceSha256: string }[] = [];
    const thumbnails: PreparedThumbnail[] = [];
    const fileDate = '2026-10-01T00:00:00.000Z';
    let complete = false;
    let progressCreated = false;
    try {
      writeFileSync(
        progressPath,
        JSON.stringify({
          kind: 'dataset',
          protocol: PERFORMANCE_PROTOCOL,
          width: 32,
          height: 32,
          fileDate,
          environmentSha256: identity?.environmentSha256,
        }) + '\n',
        { flag: 'wx' },
      );
      progressCreated = true;
      utils.initSdk();
      remainingPreparation();
      await utils.resetDatabase(undefined, signal);
      remainingPreparation();
      admin = await utils.adminSetup();
      remainingPreparation();
      for (let index = 0; index < LIBRARY_ITEMS; index++) {
        const timeout = remainingPreparation();
        const assetData = makeRandomImage(32, 32);
        const asset = await utils.createAsset(
          admin.accessToken,
          {
            assetData: { bytes: assetData, filename: 'example.png' },
            fileCreatedAt: fileDate,
            fileModifiedAt: fileDate,
          },
          { timeout, signal },
        );
        const receipt = { assetId: asset.id, sourceSha256: createHash('sha256').update(assetData).digest('hex') };
        assets.push(receipt);
        appendFileSync(progressPath, JSON.stringify({ kind: 'asset', ...receipt }) + '\n');
      }
      if (new Set(assets.map((asset) => asset.sourceSha256)).size !== LIBRARY_ITEMS) {
        throw new Error('Dataset has duplicate source bytes');
      }
      if (new Set(assets.map((asset) => asset.assetId)).size !== LIBRARY_ITEMS) {
        throw new Error('Dataset has duplicate asset identities');
      }
      remainingPreparation();
      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction', deadline - Date.now());
      await utils.waitForQueueFinish(admin.accessToken, 'storageTemplateMigration', deadline - Date.now());
      await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration', deadline - Date.now());
      if (mode !== 'report') {
        const context = await browser.newContext({
          baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:2285',
          ...REFERENCE_CONTEXT,
        });
        try {
          await utils.setAuthCookies(context, admin.accessToken);
          const page = await context.newPage();
          await page.goto('/photos');
          for (const { assetId } of assets) {
            thumbnails.push(
              await page.evaluate(
                async ({ assetId, deadline }) => {
                  const remaining = deadline - Date.now();
                  if (remaining <= 0) {
                    throw new Error('Thumbnail evidence deadline');
                  }
                  const signal = AbortSignal.timeout(remaining);
                  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/thumbnail?size=thumbnail`, {
                    credentials: 'include',
                    signal,
                  });
                  if (!response.ok || !response.body) {
                    throw new Error('Thumbnail evidence HTTP failure');
                  }
                  const reader = response.body.getReader();
                  const chunks: Uint8Array[] = [];
                  let bytes = 0;
                  try {
                    while (true) {
                      signal.throwIfAborted();
                      const chunk = await reader.read();
                      if (chunk.done) {
                        break;
                      }
                      bytes += chunk.value.byteLength;
                      if (bytes > 1024 * 1024) {
                        throw new Error('Thumbnail evidence size');
                      }
                      chunks.push(chunk.value);
                    }
                  } catch (error) {
                    await reader.cancel();
                    throw error;
                  } finally {
                    reader.releaseLock();
                  }
                  if (!bytes) {
                    throw new Error('Thumbnail evidence size');
                  }
                  const data = new Uint8Array(bytes);
                  let offset = 0;
                  for (const chunk of chunks) {
                    data.set(chunk, offset);
                    offset += chunk.byteLength;
                  }
                  const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? '';
                  const bitmap = await createImageBitmap(new Blob([data], { type: contentType }));
                  try {
                    const digest = await crypto.subtle.digest('SHA-256', data);
                    return {
                      assetId,
                      width: bitmap.width,
                      height: bitmap.height,
                      bytes,
                      contentType,
                      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
                    };
                  } finally {
                    bitmap.close();
                  }
                },
                { assetId, deadline },
              ),
            );
            appendFileSync(progressPath, JSON.stringify({ kind: 'thumbnail', ...thumbnails.at(-1) }) + '\n');
          }
          validatePreparedThumbnails(
            thumbnails,
            assets.map((asset) => asset.assetId),
          );
        } finally {
          await context.close();
        }
      }
      datasetSha256 = createHash('sha256')
        .update(JSON.stringify(assets.map((asset) => asset.sourceSha256)))
        .digest('hex');
      if (mode === 'validate' && profile?.datasetSha256 !== datasetSha256) {
        throw new Error('Reference dataset mismatch');
      }
      complete = true;
    } finally {
      defaults.signal = previousSignal;
      if (progressCreated) {
        appendFileSync(progressPath, JSON.stringify({ kind: 'status', complete, datasetSha256 }) + '\n');
      }
      await test.info().attach('performance-dataset.json', {
        body: JSON.stringify({ complete, width: 32, height: 32, fileDate, datasetSha256, assets, thumbnails }),
        contentType: 'application/json',
      });
    }
  });

  test('records startup, first thumbnail and scrolling on the library', async ({ browser, baseURL }) => {
    const schedule = performanceSchedule(mode);
    test.setTimeout(mode === 'calibrate' ? 4_200_000 : mode === 'validate' ? 960_000 : 120_000);
    const reports: Record<string, unknown>[] = [];
    const failures: { index: number; phase: string; errorType: string }[] = [];
    try {
      for (const sample of schedule) {
        if (sample.pauseBeforeMs) {
          await new Promise((resolve) => setTimeout(resolve, sample.pauseBeforeMs));
        }
        let context: BrowserContext | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let expired = false;
        let iterationFailure: { error: unknown } | undefined;
        try {
          await Promise.race([
            (async () => {
              context = await browser.newContext({
                baseURL,
                ...REFERENCE_CONTEXT,
              });
              if (expired) {
                const lateContext = context;
                context = undefined;
                await lateContext.close();
                throw new Error('Performance iteration deadline');
              }
              const page = await context.newPage();
              await utils.setAuthCookies(context, admin.accessToken);

              const started = Date.now();
              await page.goto('/photos');
              await page.locator('[data-asset-id] img').first().waitFor({ state: 'visible' });
              const firstThumbnailMs = Date.now() - started;

              const navigation = await page.evaluate(() => {
                const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
                return entry
                  ? {
                      domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd),
                      loadMs: Math.round(entry.loadEventEnd),
                    }
                  : { domContentLoadedMs: NaN, loadMs: NaN };
              });

              // frames during a scroll to the end of the timeline and back
              const scroll = await page.evaluate(async () => {
                const frames: number[] = [];
                let last = performance.now();
                let running = true;
                const tick = (now: number) => {
                  frames.push(now - last);
                  last = now;
                  if (running) {
                    requestAnimationFrame(tick);
                  }
                };
                requestAnimationFrame(tick);
                const scroller =
                  [...document.querySelectorAll<HTMLElement>('*')].find(
                    (element) =>
                      element.scrollHeight > element.clientHeight + 200 &&
                      getComputedStyle(element).overflowY !== 'visible',
                  ) ?? document.scrollingElement!;
                const diagnostics = {
                  scrollHeight: scroller.scrollHeight,
                  clientHeight: scroller.clientHeight,
                  start: scroller.scrollTop,
                  bottom: scroller.scrollTop,
                  back: scroller.scrollTop,
                };
                for (const target of [scroller.scrollHeight, 0]) {
                  const from = scroller.scrollTop;
                  for (let step = 1; step <= 30; step++) {
                    scroller.scrollTop = from + ((target - from) * step) / 30;
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                  }
                  if (target !== 0) {
                    diagnostics.bottom = scroller.scrollTop;
                  }
                }
                diagnostics.back = scroller.scrollTop;
                running = false;
                const sorted = frames.slice(1).toSorted((a, b) => a - b);
                return {
                  frames: sorted.length,
                  longFrames: sorted.filter((frame) => frame > 50).length,
                  medianFrameMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
                  worstFrameMs: Math.round(sorted.at(-1) ?? 0),
                  diagnostics,
                };
              });

              const report = {
                recordedAt: new Date().toISOString(),
                protocol: PERFORMANCE_PROTOCOL,
                measurementOnly: mode === 'report',
                identity,
                datasetSha256,
                profileSha256,
                rootApprovalReceiptSha256: profile?.rootApprovalReceiptSha256,
                sampleIndex: sample.index,
                warmup: sample.warmup,
                block: sample.block,
                valid: false,
                failedFields: [] as string[],
                libraryItems: LIBRARY_ITEMS,
                startup: navigation,
                firstThumbnailMs,
                scroll,
              };
              reports.push(report);
              try {
                validateMeasurements(report);
                if (mode === 'validate' && !sample.warmup) {
                  if (!profile) {
                    throw new Error('Missing reviewed reference profile');
                  }
                  report.failedFields = compareMeasurements(report, profile);
                  if (report.failedFields.length > 0) {
                    throw new Error('Reference ceiling exceeded: ' + report.failedFields.join(', '));
                  }
                }
                expect(firstThumbnailMs).toBeGreaterThan(0);
                expect(scroll.frames).toBeGreaterThan(0);
                report.valid = true;
              } finally {
                await test.info().attach(`performance-sample-${String(sample.index).padStart(2, '0')}.json`, {
                  body: JSON.stringify(report, null, 2),
                  contentType: 'application/json',
                });
                test.info().annotations.push({ type: 'performance', description: JSON.stringify(report) });
              }
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                expired = true;
                reject(new Error('Performance iteration deadline'));
              }, 120_000);
            }),
          ]);
        } catch (error) {
          failures.push({
            index: sample.index,
            phase: 'measurement',
            errorType: error instanceof Error ? error.name : 'unknown',
          });
          iterationFailure = { error };
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          try {
            await context?.close();
          } catch (error) {
            failures.push({
              index: sample.index,
              phase: 'context-cleanup',
              errorType: error instanceof Error ? error.name : 'unknown',
            });
            iterationFailure = { error };
          }
        }
        if (iterationFailure) {
          throw iterationFailure.error;
        }
      }
    } finally {
      await test.info().attach('performance-report.json', {
        body: JSON.stringify(
          {
            ...reports.at(-1),
            mode,
            profileSha256,
            rootApprovalReceiptSha256: profile?.rootApprovalReceiptSha256,
            baselineApplication: profile?.baselineApplication,
            protocol: PERFORMANCE_PROTOCOL,
            complete:
              reports.length === schedule.length && reports.every((report) => report.valid) && failures.length === 0,
            samples: reports,
            failures,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    }
  });
});

test('reference comparator control', () => {
  const report: Measurement = {
    libraryItems: 200,
    startup: { domContentLoadedMs: 12, loadMs: 20 },
    firstThumbnailMs: 21,
    scroll: {
      frames: 59,
      longFrames: 0,
      medianFrameMs: 17,
      worstFrameMs: 20,
      diagnostics: { scrollHeight: 600, clientHeight: 100, start: 0, bottom: 500, back: 0 },
    },
  };
  const limits = {
    'startup.domContentLoadedMs': 12,
    'startup.loadMs': 20,
    firstThumbnailMs: 21,
    'scroll.longFrames': 0,
    'scroll.medianFrameMs': 17,
    'scroll.worstFrameMs': 20,
  };
  const controlProfile = {
    schema: 1,
    protocol: PERFORMANCE_PROTOCOL,
    approved: true,
    environmentSha256: 'a'.repeat(64),
    limits,
  };
  expect(compareMeasurements(report, controlProfile)).toEqual([]);
  for (const field of Object.keys(limits)) {
    const candidate = structuredClone(report);
    const values = candidate as unknown as Record<string, unknown>;
    const keys = field.split('.');
    const target = (keys.length === 1 ? values : values[keys[0]]) as Record<string, number>;
    target[keys.at(-1)!]++;
    expect(compareMeasurements(candidate, controlProfile)).toEqual([field]);
  }
  expect(() => compareMeasurements(report, { ...controlProfile, approved: false })).toThrow(
    'Invalid performance profile',
  );
  expect(() => compareMeasurements(report, { ...controlProfile, limits: {} })).toThrow('Invalid performance profile');
});
