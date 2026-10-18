// FL-408: the bundled Studio worker's renderer: the prepared Studio engine's own headless render
// core in a private Chromium. Each render gets a fresh browser and a loopback harness that serves
// only that claim's verified files; the page may reach nothing but that harness.
import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  execFileClosed as execFileAsync,
  listedNames,
  probeExportMatrix,
  probeMedia,
} from './bundled-worker-formats.mjs';
import { loadAdmissionFonts, registerClaimFonts, requireGraphFonts } from './bundled-worker-fonts.mjs';
import { BundledRefusal, avDrift } from './bundled-worker-recipe.mjs';

const defaultEngine = fileURLToPath(new URL('../engine/', import.meta.url));

/** ffprobe's stream list for a file. */
export async function probeStreams(file, ffprobe = 'ffprobe', signal) {
  return (await probeMedia(file, ffprobe, { signal })).streams;
}

/**
 * The engine copies an untouched source's audio packets whole, so a source whose audio runs past
 * its last video frame (AAC priming and padding, common in camera files) yields an export whose
 * audio is longer than its picture. Cut the audio at the video's end, copying both streams, so the
 * server's alignment check (one audio plus one video frame) holds. Nothing is re-encoded.
 */
export async function alignAudioToVideo(file, fps, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', signal } = {}) {
  const drift = avDrift(await probeStreams(file, ffprobe, signal), fps);
  if (!drift || drift.excess <= 0 || drift.audioSeconds <= drift.videoSeconds) return false;
  const trimmed = `${file}.aligned.mp4`;
  await execFileAsync(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0',
      '-c',
      'copy',
      '-t',
      drift.videoSeconds.toFixed(6),
      '-movflags',
      '+faststart',
      '-y',
      trimmed,
    ],
    { signal, timeout: 10 * 60_000 },
  );
  await rename(trimmed, file);
  return true;
}

/** A short 16-bit PCM tone, so the conformance render has an audible source. */
export function toneWav({ sampleRate = 48_000, seconds = 1, frequency = 440 } = {}) {
  const samples = Math.round(sampleRate * seconds);
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 4, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 4, 40);
  for (let index = 0; index < samples; index++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 8000);
    wav.writeInt16LE(value, 44 + index * 4);
    wav.writeInt16LE(value, 46 + index * 4);
  }
  return wav;
}

/** Is this WebGPU adapter a software or fallback device? No adapter counts as software. */
export const isSoftwareAdapter = (adapter) =>
  !adapter ||
  adapter.isFallbackAdapter !== false ||
  /swiftshader|llvmpipe|lavapipe|software|microsoft basic/i.test(
    `${adapter.vendor ?? ''} ${adapter.architecture ?? ''} ${adapter.device ?? ''} ${adapter.description ?? ''}`,
  );

export async function createEngineRenderer({
  engineDir = defaultEngine,
  chromiumPath = process.env.FRAMELEAF_STUDIO_CHROMIUM,
  browserGuard = process.env.FRAMELEAF_STUDIO_BROWSER_GUARD,
  admissionFontDir = path.resolve(engineDir, '../runtime'),
  ffprobe = 'ffprobe',
  ffmpeg = 'ffmpeg',
  log = () => {},
  signal,
} = {}) {
  signal?.throwIfAborted();
  const native = Boolean(process.env.FRAMELEAF_STUDIO_NODE || browserGuard);
  if (
    native &&
    (!path.isAbsolute(chromiumPath ?? '') || (process.platform !== 'win32' && !path.isAbsolute(browserGuard ?? '')))
  ) {
    throw new Error('Native Studio requires its private browser and process guardian');
  }
  const require = createRequire(path.join(engineDir, 'package.json'));
  const { chromium } = require('playwright');
  const { createHarnessServer } = await import(pathToFileURL(path.join(engineDir, 'headless/server.mjs')).href);
  const { chromeLaunchArgs } = await import(pathToFileURL(path.join(engineDir, 'headless/lib/cli.mjs')).href);
  const { renderJob } = await import(pathToFileURL(path.join(engineDir, 'headless/lib/render-core.mjs')).href);
  const launchArgs = chromeLaunchArgs();
  if (native && launchArgs.some((arg) => /^--(?:no-sandbox|disable-[^=]*sandbox)(?:=|$)/.test(arg))) {
    throw new Error('Native Studio requires Chromium sandboxing');
  }
  const distDir = path.join(engineDir, 'dist');
  if (!existsSync(path.join(distDir, 'headless.html'))) throw new Error('The Studio engine harness is not built');
  const executablePath =
    browserGuard || chromiumPath || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

  /** Open a browser on a harness that serves exactly `files` (media id -> path). */
  const open = async (files, signal) => {
    signal?.throwIfAborted();
    const server = await createHarnessServer({
      distDir,
      resolveMedia: (id) => files.get(id) ?? null,
    });
    let browser, closing;
    const closeBrowser = () => (browser ? (closing ??= browser.close().catch(() => {})) : Promise.resolve());
    const abort = () => void closeBrowser();
    try {
      signal?.throwIfAborted();
      browser = await chromium.launch({
        headless: true,
        args: launchArgs,
        ...(executablePath && { executablePath }),
        ...(native && { chromiumSandbox: true }),
        ...(browserGuard && {
          env: {
            ...process.env,
            FRAMELEAF_STUDIO_CHROMIUM: chromiumPath,
            FRAMELEAF_STUDIO_OWNER_PID: String(process.pid),
          },
        }),
      });
      signal?.addEventListener('abort', abort, { once: true });
      // Stop during launch must join browser cleanup before creating pages or using scratch files.
      signal?.throwIfAborted();
      const page = await browser.newPage({ acceptDownloads: true });
      const origin = new URL(server.harnessUrl).origin;
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await page.goto(server.harnessUrl, {
        waitUntil: 'load',
        timeout: 60_000,
      });
      await page.waitForFunction(() => Boolean(window.freecut?.ready), {
        timeout: 30_000,
      });
      const adapter = await page.evaluate(async () => {
        const found = await navigator.gpu?.requestAdapter();
        return found
          ? {
              ...found.info,
              isFallbackAdapter: found.info?.isFallbackAdapter ?? null,
            }
          : null;
      });
      return {
        page,
        server,
        adapter,
        close: async () => {
          signal?.removeEventListener('abort', abort);
          await closeBrowser();
          await server.close();
        },
      };
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      await closeBrowser();
      await server.close();
      throw signal?.aborted ? signal.reason : error;
    }
  };

  /**
   * Render a tiny video+audio+title timeline and check the encoded file, so admission reports only
   * outputs this container actually produced, and whether its renderer is software.
   */
  const conformance = async (signal) => {
    signal?.throwIfAborted();
    const folder = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-conformance-'));
    const tone = path.join(folder, 'tone.wav');
    let session;
    try {
      const fonts = native ? await loadAdmissionFonts(admissionFontDir, signal) : [];
      await writeFile(tone, toneWav());
      session = await open(new Map([['tone', tone]]), signal);
      await registerClaimFonts(session.page, fonts);
      signal?.throwIfAborted();
      const fps = 30;
      const project = {
        metadata: { width: 320, height: 180, fps, backgroundColor: '#000000' },
        timeline: {
          tracks: [
            {
              id: 'v',
              name: 'V1',
              kind: 'video',
              order: 0,
              visible: true,
              muted: false,
              locked: false,
              items: [],
            },
            {
              id: 'a',
              name: 'A1',
              kind: 'audio',
              order: 1,
              visible: true,
              muted: false,
              locked: false,
              items: [],
            },
          ],
          items: [
            {
              id: 't',
              trackId: 'v',
              type: 'text',
              from: 0,
              durationInFrames: fps,
              text: 'Frameleaf',
              fontSize: 40,
              color: '#ffffff',
            },
            {
              id: 's',
              trackId: 'a',
              type: 'audio',
              mediaId: 'tone',
              from: 0,
              durationInFrames: fps,
              sourceStart: 0,
              sourceEnd: fps,
              sourceDuration: fps,
              sourceFps: fps,
              speed: 1,
              volume: -1,
            },
          ],
          transitions: [],
        },
      };
      const output = path.join(folder, 'conformance.mp4');
      const summary = await renderJob(
        session.page,
        {
          project,
          media: [{ mediaId: 'tone', url: session.server.mediaUrl('tone') }],
          // Encode both streams (the tone's gain change also prevents audio packet copy): copying a source
          // would prove nothing about the encoders.
          settings: {
            mode: 'video',
            codec: 'avc',
            container: 'mp4',
            audioCodec: 'aac',
            quality: 'low',
            resolution: { width: 320, height: 180 },
            fps,
            videoBitrate: 500_000,
            audioBitrate: 128_000,
            smartCopy: false,
          },
          hasRange: true,
          inPoint: 0,
          outPoint: fps,
          missing: [],
          outPath: output,
          strict: true,
        },
        { onWarn: () => {}, downloadTimeoutMs: 120_000 },
      );
      const streams = await probeStreams(summary.outputPath, ffprobe, signal);
      const video = streams.find((stream) => stream.codec_type === 'video');
      const audio = streams.find((stream) => stream.codec_type === 'audio');
      const proven =
        summary.effectiveSettings?.codec === 'avc' && video?.codec_name === 'h264' && audio?.codec_name === 'aac';
      const softwareRenderer = isSoftwareAdapter(session.adapter);
      log(
        `Conformance: ${proven ? 'H.264/AAC MP4 written' : `no verified output (engine ${summary.effectiveSettings?.codec ?? 'none'}, streams ${streams.map((stream) => stream.codec_name).join('+') || 'none'})`}; ` +
          `renderer ${softwareRenderer ? 'software (CPU)' : `GPU ${session.adapter?.vendor ?? ''} ${session.adapter?.architecture ?? ''}`.trim()}`,
      );
      // FL-105: every other format is written from this same render, read back, and only then offered.
      const matrix = proven
        ? await probeExportMatrix({
            master: summary.outputPath,
            ffmpeg,
            ffprobe,
            log,
            signal,
          })
        : null;
      return {
        reportedAt: new Date(),
        softwareRenderer,
        codecs: matrix?.codecs ?? [],
        formats: matrix?.formats ?? [],
        writers: matrix?.writers ?? {},
      };
    } catch (error) {
      throw signal?.aborted ? signal.reason : error;
    } finally {
      await session?.close();
      await rm(folder, { recursive: true, force: true });
    }
  };

  let softwareRenderer = true;
  let writers = {};
  const encoders = [
    ...listedNames(
      (
        await execFileAsync(ffmpeg, ['-hide_banner', '-encoders'], {
          signal,
          timeout: 60_000,
        })
      ).stdout,
    ),
  ];
  return {
    get softwareRenderer() {
      return softwareRenderer;
    },
    /** Format id -> encoder, for the formats the last admission check wrote and read back. */
    get writers() {
      return writers;
    },
    encoders,
    async conformance({ signal } = {}) {
      const result = await conformance(signal);
      softwareRenderer = result.softwareRenderer;
      writers = result.writers;
      return result;
    },
    probe: (file, options) => probeMedia(file, ffprobe, options),
    async render({ fonts = [], project, files, settings, bounds, outputPath, signal, onProgress }) {
      signal?.throwIfAborted();
      requireGraphFonts(project, fonts);
      const session = await open(files, signal);
      try {
        await registerClaimFonts(session.page, fonts);
        signal?.throwIfAborted();
        await session.page.exposeBinding('__freecutProgress', (_source, progress) => {
          const value = Number(progress?.progress);
          if (Number.isFinite(value)) onProgress?.(Math.max(0, Math.min(1, value / 100)));
        });
        const summary = await renderJob(
          session.page,
          {
            project,
            media: [...files.keys()].map((mediaId) => ({
              mediaId,
              url: session.server.mediaUrl(mediaId),
            })),
            settings,
            hasRange: true,
            inPoint: bounds.inPoint,
            outPoint: bounds.outPoint,
            missing: [],
            outPath: outputPath,
            strict: true,
          },
          {
            onWarn: () => {},
            softwareGpu: isSoftwareAdapter(session.adapter),
            downloadTimeoutMs: 6 * 60 * 60_000,
          },
        );
        if (summary.ok === false)
          throw new BundledRefusal('render_refused', 'The Studio engine refused to render this project.');
        if (summary.effectiveSettings?.codec !== 'avc' || summary.effectiveSettings?.container !== 'mp4') {
          throw new BundledRefusal(
            'codec_fallback',
            'The engine could not encode H.264 here and fell back to another codec.',
          );
        }
        const warnings = summary.warnings ?? [];
        if (warnings.length > 0) {
          const codes = [...new Set(warnings.map((warning) => warning.code ?? 'UNKNOWN'))].join(', ');
          throw new BundledRefusal(
            'render_warning',
            `The engine could not render this project exactly (${codes}); nothing was exported.`,
          );
        }
        if (summary.outputPath !== outputPath)
          throw new BundledRefusal('render_refused', 'The engine wrote an unexpected file.');
        if (
          await alignAudioToVideo(outputPath, settings.fps, {
            ffmpeg,
            ffprobe,
            signal,
          })
        ) {
          log('Cut copied source audio at the end of the picture');
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.code === 'HARDWARE_GPU_REQUIRED') {
          throw new BundledRefusal(
            'effects_need_gpu',
            'This project uses effects, and the bundled Studio worker has no GPU. Give the machine-learning container a GPU, or remove the effects.',
          );
        }
        if (error?.code === 'MISSING_MEDIA')
          throw new BundledRefusal('missing_media', 'A clip reads media this export was not granted.');
        throw error;
      } finally {
        await session.close();
      }
    },
  };
}
