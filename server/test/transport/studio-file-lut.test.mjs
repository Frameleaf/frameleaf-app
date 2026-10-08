// Opt-in real HTTP/PostgreSQL/native-GPU fixture. Never part of unit discovery.
// The caller supplies an owned migrated PG and media directory; this test owns its API process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createPortProbe } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { open, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(root + '/studio/engine/package.json');
const sharp = require('sharp');
const postgres = createRequire(root + '/server/package.json')('postgres');
const { prepareOneClaim } = await import(pathToFileURL(root + '/studio/tools/render-worker-claim.mjs'));
const { executeStillClaim } = await import(pathToFileURL(root + '/studio/tools/render-worker-still-executor.mjs'));
const { canonicalJson } = createRequire(root + '/server/package.json')('./dist/utils/studio-project.js');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const run = promisify(execFile);

test(
  'authenticated file LUT export survives real claim, native encode, publication, restart and privacy fences',
  {
    skip: process.env.FL105_DURABLE_LUT !== 'owned-local-runtime',
    timeout: 420_000,
  },
  async function durableFileLutJourney(t) {
    const base = process.env.FL105_API_URL;
    const pgUrl = new URL(process.env.FL105_PG_URL);
    const url = new URL(base);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:' && url.port);
    assert.ok(['127.0.0.1', 'localhost'].includes(pgUrl.hostname) && pgUrl.port);
    assert.ok(path.isAbsolute(process.env.FL105_MEDIA_ROOT));
    const evidence = process.env.FL105_EVIDENCE_DIR;
    assert.ok(path.isAbsolute(evidence));
    const gpu = JSON.parse(await readFile(process.env.FL105_GPU_REPORT));
    const metal = JSON.parse(await readFile(process.env.FL105_METAL_REPORT));
    const measurement = JSON.parse(await readFile(process.env.FL105_ENCODE_REPORT));
    const build = JSON.parse(await readFile(root + '/studio/engine/frameleaf-build.json'));
    const config = JSON.parse(await readFile(root + '/studio/engine-build.json'));
    assert.equal(process.versions.node, config.node);
    assert.equal(gpu.sourceSha256, config.sourceSha256);
    assert.equal(build.sourceSha256, config.sourceSha256);
    assert.equal(measurement.buildReceipt.artifactSha256, build.artifactSha256);
    assert.equal(measurement.localMeasurementPassed, true);
    assert.equal(gpu.adapter.isFallbackAdapter, false);
    assert.equal(metal.devices.length, 1);
    assert.ok(BigInt(metal.devices[0].recommendedMaxWorkingSetSize) >= 2147483648n);
    assert.ok(Date.now() - Date.parse(gpu.finishedAt) < 3600000);
    // The encode report must actually qualify AVC MP4. No renderer substitute or inferred VRAM.
    assert.ok(measurement.buildReceipt.sourceSha256 === config.sourceSha256);
    const encoded = measurement.cases.find((value) => value.name === 'whole');
    const encodedVideo = encoded.probe.streams.find((value) => value.codec_type === 'video');
    assert.equal(encodedVideo.codec_name, 'h264');
    assert.ok(encoded.probe.format.format_name.split(',').includes('mp4'));
    assert.equal(encodedVideo.width, 1280);
    assert.equal(encodedVideo.height, 720);
    assert.equal(encodedVideo.nb_read_frames, '48');
    let app;
    let launches = 0;
    const stop = async () => {
      if (!app) return;
      const child = app;
      app = undefined;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Error('owned API did not stop')), 15000);
          timer.unref();
        }),
      ]);
    };
    let cleanupWorker = async () => {};
    t.after(async () => {
      try {
        await cleanupWorker();
      } finally {
        await stop();
      }
    });
    const start = async () => {
      // Refuse an occupied port before any privileged fixture request can reach another app.
      const portProbe = createPortProbe();
      await new Promise((resolve, reject) =>
        portProbe.once('error', reject).listen(Number(url.port), url.hostname, resolve),
      );
      await new Promise((resolve) => portProbe.close(resolve));
      const log = await open(path.join(evidence, `api-${++launches}.log`), 'wx');
      app = spawn(process.execPath, ['dist/main.js'], {
        cwd: root + '/server',
        stdio: ['ignore', log.fd, log.fd],
        env: {
          ...process.env,
          FRAMELEAF_ENV: 'testing',
          FRAMELEAF_WORKERS_INCLUDE: 'api,microservices',
          FRAMELEAF_PORT: url.port,
          FRAMELEAF_HOST: url.hostname,
          DB_URL: pgUrl.href,
          FRAMELEAF_MEDIA_LOCATION: process.env.FL105_MEDIA_ROOT,
          FRAMELEAF_BUILD_DATA: process.env.FL105_BUILD_DATA,
          FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS: 'true',
          FRAMELEAF_MACHINE_LEARNING_ENABLED: 'false',
          FRAMELEAF_LOG_LEVEL: 'warn',
        },
      });
      await log.close();
      const readyUntil = Date.now() + 60_000;
      while (Date.now() < readyUntil) {
        assert.equal(app.exitCode, null, 'owned API exited before readiness');
        try {
          const response = await fetch(base + '/api/server/ping', { signal: AbortSignal.timeout(500) });
          if (response.ok) {
            await response.body?.cancel();
            return;
          }
          await response.body?.cancel();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.fail('owned API did not become ready');
    };
    await start();
    const password = process.env.FL105_FIXTURE_PASSWORD;
    assert.ok(password, 'explicit isolated fixture password required');
    const queuedOperations = [];
    const api = async (path, method = 'GET', token, body, status = 200) => {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: {
          ...(token && { authorization: 'Bearer ' + token }),
          ...(body && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (response.status !== status) {
        await response.body?.cancel();
        throw Error(`${method} ${path.replace(/[a-f0-9-]{36}/g, '<id>')} expected${status} got${response.status}`);
      }
      const answer = status === 204 ? null : await response.json();
      if (method === 'POST' && path.endsWith('/exports') && answer?.version?.renderOperationId)
        queuedOperations.push(answer.version.renderOperationId);
      return answer;
    };
    const sign = await fetch(base + '/api/auth/admin-sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'fl105-local-admin@example.test',
        password,
        name: 'FL105 fixture admin',
        setupCode: process.env.FRAMELEAF_SETUP_CODE,
      }),
    });
    assert.ok([201, 400].includes(sign.status));
    await sign.body?.cancel();
    const admin = await api(
      '/auth/login',
      'POST',
      undefined,
      { email: 'fl105-local-admin@example.test', password },
      201,
    );
    const suffix = randomUUID();
    await api(
      '/admin/users',
      'POST',
      admin.accessToken,
      {
        email: `fl105-owner-${suffix}@example.test`,
        password,
        name: 'FL105 controlled owner',
        shouldChangePassword: false,
      },
      201,
    );
    const owner = await api(
      '/auth/login',
      'POST',
      undefined,
      { email: `fl105-owner-${suffix}@example.test`, password },
      201,
    );
    await api('/auth/pin-code', 'POST', owner.accessToken, { pinCode: '123456' }, 204);
    await api('/auth/session/unlock', 'POST', owner.accessToken, { pinCode: '123456' }, 204);
    const project = await api(
      '/studio/projects',
      'POST',
      owner.accessToken,
      { name: 'Durable file LUT ' + suffix, clientId: 'durable-lut' },
      201,
    );
    const lutId = randomUUID();
    const lut = Buffer.from(
      (
        'LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -1 1\n' +
        Array.from({ length: 8 }, (_, i) => `${i & 4 ? 1 : -1} ${i & 2 ? 1 : -1} ${i & 1 ? 1 : -1}`).join('\n') +
        '\n'
      ).replaceAll('\n', '\r'),
    );
    const form = new FormData();
    form.set('id', lutId);
    form.set('file', new Blob([lut], { type: 'text/plain' }), 'signed-grade.cube');
    const imported = await fetch(base + `/api/studio/projects/${project.id}/imports`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + owner.accessToken },
      body: form,
    });
    assert.equal(imported.status, 201);
    const declared = await imported.json();
    assert.equal(declared.checksum, sha(lut));
    const media = [];
    for (const color of ['#0000ff', '#00ff00']) {
      const bytes = await sharp({ create: { width: 1280, height: 720, channels: 3, background: color } })
        .png()
        .toBuffer();
      const form = new FormData();
      form.set('assetData', new Blob([bytes], { type: 'image/png' }), suffix + color.slice(1) + '.png');
      form.set('fileCreatedAt', '2026-09-01T12:00:00Z');
      form.set('fileModifiedAt', '2026-09-01T12:00:00Z');
      const r = await fetch(base + '/api/assets', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + owner.accessToken },
        body: form,
      });
      assert.equal(r.status, 201);
      media.push((await r.json()).id);
    }
    const graph = {
      schemaVersion: 15,
      id: 'durable-main',
      name: 'Controlled durable cut',
      description: '',
      createdAt: 0,
      updatedAt: 0,
      duration: 2,
      metadata: { width: 1280, height: 720, fps: 24 },
      timeline: {
        tracks: [
          {
            id: 'v1',
            name: 'V1',
            kind: 'video',
            height: 80,
            locked: false,
            visible: true,
            muted: false,
            solo: false,
            order: 0,
          },
        ],
        items: media.map((mediaId, i) => ({
          id: `clip-${i}`,
          type: 'image',
          mediaId,
          trackId: 'v1',
          from: i * 24,
          durationInFrames: 24,
          transform: { x: 0, y: 0, width: 1280, height: 720, rotation: 0, opacity: 1 },
          effects: [
            {
              id: `fx-${i}`,
              enabled: true,
              effect: {
                type: 'gpu-effect',
                gpuEffectType: i === 0 ? 'gpu-lut' : 'gpu-brightness',
                params:
                  i === 0
                    ? { lutId, lutSource: 'import', lutSize: '0', lutData: '', lutName: '', intensity: 1 }
                    : { amount: 0.15 },
              },
            },
          ],
        })),
        transitions: [
          {
            id: 'dissolve',
            type: 'crossfade',
            presentation: 'dissolve',
            timing: 'linear',
            trackId: 'v1',
            leftClipId: 'clip-0',
            rightClipId: 'clip-1',
            durationInFrames: 12,
          },
        ],
        keyframes: [
          {
            itemId: 'clip-0',
            properties: [
              {
                property: 'effect:gpu-lut:fx-0:intensity',
                keyframes: [
                  { id: 'i0', frame: 0, value: 0, easing: 'linear' },
                  { id: 'i1', frame: 6, value: 1, easing: 'linear' },
                ],
              },
            ],
          },
        ],
      },
    };
    await api(
      `/studio/projects/${project.id}/revisions`,
      'POST',
      owner.accessToken,
      {
        clientId: 'durable-lut',
        requestKey: 'save-1',
        expectedRevision: 0,
        envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: config.sourceSha256, graph },
      },
      201,
    );
    const enrolled = await api(
      '/admin/render-workers',
      'POST',
      admin.accessToken,
      {
        name: 'FL105 actual measured worker ' + suffix,
        destination: 'local',
        kinds: ['studio_export'],
        engineDigest: config.sourceSha256,
        conformanceMaxAgeMs: 3600000,
        gpuMemoryBytes: metal.devices[0].recommendedMaxWorkingSetSize,
        maxConcurrentOperations: 1,
        maxWallClockMs: '60000',
        maxOutputBytes: '33554432',
      },
      201,
    );
    const admitted = await api(
      '/render-workers/admission',
      'POST',
      undefined,
      {
        workerId: enrolled.worker.id,
        enrolmentSecret: enrolled.enrolmentSecret,
        engineDigest: config.sourceSha256,
        conformanceReportedAt: gpu.finishedAt,
        softwareRenderer: false,
        gpuMemoryBytes: metal.devices[0].recommendedMaxWorkingSetSize,
        codecs: ['webcodecs-avc'],
        formats: ['mp4'],
        colorPrecision: { maxBitDepth: 8, hdr10: false, dolbyVision: false },
      },
      201,
    );

    cleanupWorker = async () => {
      if (!app) return;
      for (const id of queuedOperations) {
        const response = await fetch(base + `/api/media-operations/${id}/cancel`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + owner.accessToken },
        });
        assert.ok([200, 400, 404, 409].includes(response.status));
        await response.body?.cancel();
      }
      await api('/admin/render-workers/' + enrolled.worker.id, 'DELETE', admin.accessToken, undefined, 204);
    };
    const options = {
      destination: 'local',
      format: 'mp4-h264',
      color: 'preserve',
      resolution: '720p',
      quality: 'high',
      audio: 'preserve',
      expectedRevision: 1,
    };
    const queue = (key) =>
      api(`/studio/projects/${project.id}/exports`, 'POST', owner.accessToken, { ...options, requestKey: key }, 201);
    const deny = async (pathname, token, method = 'GET', body) => {
      const response = await fetch(base + '/api' + pathname, {
        method,
        headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
      assert.ok([400, 401, 403, 404, 409].includes(response.status), 'authority fence must refuse');
      await response.body?.cancel();
      return response.status;
    };
    let claim;
    const prepare = async (execute) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]) === base + '/api/render-workers/claims' && response.status === 200)
          claim = await response.clone().json();
        return response; // The real HTTP body is passed unchanged to the worker.
      };
      try {
        return await prepareOneClaim({ serverUrl: base, sessionToken: admitted.sessionToken, execute });
      } finally {
        globalThis.fetch = originalFetch;
      }
    };
    const waitVersion = async (id) => {
      for (let i = 0; i < 120; i++) {
        const value = await api('/studio/exports/' + id, 'GET', owner.accessToken);
        if (['published', 'failed', 'cancelled'].includes(value.state)) {
          assert.equal(value.state, 'published');
          return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.fail('publication did not finish within fixture budget');
    };
    const whole = await queue('whole');
    const result = await prepare(executeStillClaim);
    assert.equal(result.status, 'completed');
    assert.equal(claim.operationId, whole.version.renderOperationId);
    for (const ref of claim.snapshot.studio.resources) {
      assert.ok(!('ownerId' in ref) && !('path' in ref) && !('token' in ref));
      assert.ok(typeof ref.sourceAccess === 'string');
    }
    assert.match(claim.artifactInputDigest, /^[a-f0-9]{64}$/);
    const version = await waitVersion(whole.version.id);
    assert.equal(version.scope, 'library');
    assert.equal(version.sourceCount, 2);
    assert.equal(version.locked, false);
    const download = async (id) => {
      const response = await fetch(base + `/api/assets/${id}/original`, {
        headers: { authorization: 'Bearer ' + owner.accessToken },
      });
      assert.equal(response.status, 200);
      return Buffer.from(await response.arrayBuffer());
    };
    const output = await download(version.resultAssetId);
    const filename = path.join(evidence, 'whole.mp4');
    await writeFile(filename, output, { flag: 'wx' });
    const probe = JSON.parse(
      (await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filename]))
        .stdout,
    );
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(video.r_frame_rate, '24/1');
    assert.equal(video.nb_read_frames, '48');
    const observed = [];
    for (const [frame, expected] of [
      [0, [0, 0, 255]],
      [12, [255, 0, 0]],
      [36, [0.15 * 255, 255, 0.15 * 255]],
    ]) {
      const { stdout } = await run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          filename,
          '-vf',
          `select='eq(n,${frame})',crop=16:16:632:352`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 },
      );
      assert.equal(stdout.length, 16 * 16 * 3);
      const mean = [0, 1, 2].map((c) => {
        let sum = 0;
        for (let i = c; i < stdout.length; i += 3) sum += stdout[i];
        return sum / (stdout.length / 3);
      });
      for (let c = 0; c < 3; c++)
        assert.ok(Math.abs(mean[c] - expected[c]) <= 8, `native decoded channel mismatch frame${frame} channel${c}`);
      observed.push({ frame, expected, mean });
      stdout.fill(0);
    }
    const revision = await api(`/studio/projects/${project.id}/revisions/1`, 'GET', owner.accessToken);
    assert.equal(sha(canonicalJson(revision.envelope.graph)), sha(canonicalJson(graph)));
    assert.ok(!JSON.stringify(revision).includes('gpu-file-lut-v1'));
    assert.ok(!JSON.stringify(version).includes('fileLutData'));
    // Read-only SQL proves the actual publication's durable resource provenance, never stages it.
    const sql = postgres(pgUrl.href, { max: 1 });
    t.after(() => sql.end());
    const sources =
      await sql`select "key", "kind", "resourceId", "checksum", "sourceAccess" from studio_export_version_source where "versionId"=${version.id} order by "key"`;
    const lutSource = sources.find((s) => s.kind === 'lut');
    assert.equal(lutSource.resourceId, lutId);
    assert.equal(lutSource.checksum, sha(lut));
    assert.equal(lutSource.sourceAccess, 'project');
    assert.equal(sources.filter((s) => s.kind === 'library-asset').length, 2);
    // New authenticated session after a real process restart reopens persisted original and output.
    const oldGrant = claim.inputs.find((i) => i.kind === 'lut');
    await stop();
    await start();
    const reopened = await api('/studio/exports/' + version.id, 'GET', owner.accessToken);
    assert.equal(reopened.state, 'published');
    assert.equal(sha(await download(reopened.resultAssetId)), sha(output));
    const stale = await fetch(base + oldGrant.url, {
      headers: { 'x-frameleaf-worker-session': admitted.sessionToken },
    });
    assert.ok([400, 401, 403, 404].includes(stale.status));
    await stale.body?.cancel();
    // A fresh real claim uses new process-signed grants and the same opaque current source binding.
    const sub = await api(
      `/studio/projects/${project.id}/exports`,
      'POST',
      owner.accessToken,
      { ...options, range: { inPoint: 6, outPoint: 36 }, requestKey: 'subrange' },
      201,
    );
    const priorDigest = claim.artifactInputDigest;
    assert.equal((await prepare(executeStillClaim)).status, 'completed');
    assert.equal(claim.artifactInputDigest, priorDigest);
    assert.ok(claim.inputs.find((i) => i.kind === 'lut').url !== oldGrant.url, 'fresh process grant required');
    const subVersion = await waitVersion(sub.version.id);
    const subBytes = await download(subVersion.resultAssetId);
    const subFile = path.join(evidence, 'subrange.mp4');
    await writeFile(subFile, subBytes, { flag: 'wx' });
    const subProbe = JSON.parse(
      (await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', subFile])).stdout,
    );
    assert.equal(subProbe.streams.find((s) => s.codec_type === 'video').nb_read_frames, '30');
    const { stdout: wholeRgb } = await run(
      'ffmpeg',
      ['-v', 'error', '-i', filename, '-vf', 'crop=16:16:632:352', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
    );
    const { stdout: subRgb } = await run(
      'ffmpeg',
      ['-v', 'error', '-i', subFile, '-vf', 'crop=16:16:632:352', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
    );
    assert.equal(wholeRgb.length, 48 * 16 * 16 * 3);
    assert.equal(subRgb.length, 30 * 16 * 16 * 3);
    let subrangeMaxError = 0,
      subrangeError = 0;
    for (let i = 0; i < subRgb.length; i++) {
      const error = Math.abs(subRgb[i] - wholeRgb[i + 6 * 16 * 16 * 3]);
      subrangeError += error;
      subrangeMaxError = Math.max(subrangeMaxError, error);
    }
    assert.ok(subrangeMaxError <= 8);
    assert.ok(subrangeError / subRgb.length <= 3);
    wholeRgb.fill(0);
    subRgb.fill(0);
    // Foreign authenticated owners cannot see the project, export, input grants or output.
    await api(
      '/admin/users',
      'POST',
      admin.accessToken,
      { email: `fl105-stranger-${suffix}@example.test`, password, name: 'FL105 stranger', shouldChangePassword: false },
      201,
    );
    const stranger = await api(
      '/auth/login',
      'POST',
      undefined,
      { email: `fl105-stranger-${suffix}@example.test`, password },
      201,
    );
    await deny('/studio/exports/' + version.id, stranger.accessToken);
    await deny(`/studio/projects/${project.id}/revisions/1`, stranger.accessToken);
    await deny(`/assets/${version.resultAssetId}/original`, stranger.accessToken);
    await deny(`/studio/projects/${project.id}/exports`, stranger.accessToken, 'POST', {
      ...options,
      requestKey: 'foreign',
    });
    // Cancellation is a real owner request observed by the worker's heartbeat and release/ack.
    const cancelled = await queue('cancel');
    const cancelResult = await prepare(async (context) => {
      await api(`/media-operations/${context.claim.operationId}/cancel`, 'POST', owner.accessToken);
      await context.heartbeat();
      assert.fail('cancelled claim reached rendering');
    });
    assert.equal(cancelResult.status, 'cancelled');
    assert.notEqual(
      (await api('/studio/exports/' + cancelled.version.id, 'GET', owner.accessToken)).state,
      'published',
    );
    // Fresh PIN requirement on an owner-locked source, and deliberate background authority.
    await api('/assets', 'PUT', owner.accessToken, { ids: [media[0]], visibility: 'locked' }, 204);
    await api('/auth/session/lock', 'POST', owner.accessToken, undefined, 204);
    await deny(`/studio/projects/${project.id}/exports`, owner.accessToken, 'POST', {
      ...options,
      requestKey: 'locked-refused',
    });
    await api('/auth/session/unlock', 'POST', owner.accessToken, { pinCode: '123456' }, 204);
    const locked = await queue('locked-background');
    await api('/auth/session/lock', 'POST', owner.accessToken, undefined, 204);
    assert.equal((await prepare(executeStillClaim)).status, 'completed');
    await deny('/studio/exports/' + locked.version.id, owner.accessToken);
    await api('/auth/session/unlock', 'POST', owner.accessToken, { pinCode: '123456' }, 204);
    const unlocked = await waitVersion(locked.version.id);
    assert.equal(unlocked.locked, true);
    assert.ok(unlocked.resultAssetId);
    assert.ok((await download(unlocked.resultAssetId)).length > 0);
    await api('/auth/session/lock', 'POST', owner.accessToken, undefined, 204);
    await deny(`/assets/${unlocked.resultAssetId}/original`, owner.accessToken);
    await deny('/studio/exports/' + locked.version.id, owner.accessToken);
    await api('/auth/session/unlock', 'POST', owner.accessToken, { pinCode: '123456' }, 204);
    // Physical corruption of only fixture-owned import bytes must fail before rendering.
    const [stored] =
      await sql`select "path" from studio_project_import where "projectId"=${project.id} and "id"=${lutId}`;
    assert.ok(stored.path.startsWith(process.env.FL105_MEDIA_ROOT));
    const originalLut = await readFile(stored.path);
    assert.equal(sha(originalLut), sha(lut));
    const corrupted = await queue('checksum');
    await writeFile(stored.path, Buffer.from('corrupt fixture bytes'));
    try {
      assert.equal((await prepare(executeStillClaim)).status, 'failed');
    } finally {
      await writeFile(stored.path, originalLut);
    }
    await api(`/media-operations/${corrupted.version.renderOperationId}/cancel`, 'POST', owner.accessToken);
    assert.notEqual(
      (await api('/studio/exports/' + corrupted.version.id, 'GET', owner.accessToken)).state,
      'published',
    );
    // The real executor must refuse a substituted preparation digest before rendering/checkpoint writes.
    const tampered = await queue('prepared-digest-tamper');
    const tamperResult = await prepare(async (context) => {
      context.prepared.artifactInputDigest = '0'.repeat(64);
      return executeStillClaim(context);
    });
    assert.equal(tamperResult.status, 'failed');
    const [checkpointCount] =
      await sql`select count(*)::int as count from media_operation_checkpoint where "operationId"=${tampered.version.renderOperationId}`;
    assert.equal(checkpointCount.count, 0);
    await api(`/media-operations/${tampered.version.renderOperationId}/cancel`, 'POST', owner.accessToken);
    // An interrupted *live* claim's process-signed grant is valid before restart and invalid after it.
    const recovery = await queue('process-reclaim');
    const workerPost = async (pathname, body, status = 200) => {
      const response = await fetch(base + '/api' + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-frameleaf-worker-session': admitted.sessionToken },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, status);
      const text = await response.text();
      return text ? JSON.parse(text) : undefined;
    };
    const interrupted = await workerPost('/render-workers/claims', { kinds: ['studio_export'] });
    assert.equal(interrupted.operationId, recovery.version.renderOperationId);
    const currentGrant = interrupted.inputs.find((i) => i.kind === 'lut');
    const readGrant = async () =>
      fetch(base + currentGrant.url, { headers: { 'x-frameleaf-worker-session': admitted.sessionToken } });
    const live = await readGrant();
    assert.equal(live.status, 200);
    assert.equal(sha(Buffer.from(await live.arrayBuffer())), sha(lut));
    const legacySources = interrupted.snapshot.studio.resources
      .map(({ key, id, checksum }) => ({ key, id, checksum }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const legacyDigest = sha(JSON.stringify({ revisionId: interrupted.revisionId, sources: legacySources }));
    await workerPost(
      `/render-workers/operations/${interrupted.operationId}/checkpoints`,
      {
        claimToken: interrupted.claimToken,
        sequence: 0,
        chunkKey: 'legacy',
        inputDigest: legacyDigest,
        historyDigest: sha(JSON.stringify(interrupted.snapshot.studio.graph)),
        configDigest: 'c'.repeat(64),
        seed: null,
        timebase: '1/24',
        startTicks: '0',
        endTicks: '48',
        requiresSequentialContext: false,
      },
      400,
    );
    await stop();
    await start();
    // Session/claim are still active: this isolates signature-secret rotation from lease expiry.
    const beat = await workerPost(`/render-workers/operations/${interrupted.operationId}/heartbeat`, {
      claimToken: interrupted.claimToken,
      outputBytes: '0',
    });
    assert.equal(beat.leaseExtended, true);
    const rotated = await readGrant();
    assert.equal(rotated.status, 404);
    await rotated.body?.cancel();
    const expiry = Date.now() + beat.leaseMs;
    // Real recovery owns the 90s lease and 30s sweep. Do not edit the DB or shorten production clocks.
    await new Promise((resolve) => setTimeout(resolve, beat.leaseMs + 100));
    let recovered;
    for (let i = 0; i < 80; i++) {
      recovered = await prepare(executeStillClaim);
      if (recovered.status !== 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(Date.now() >= expiry);
    assert.equal(recovered.status, 'completed');
    assert.equal(claim.operationId, interrupted.operationId);
    assert.ok(claim.claimToken !== interrupted.claimToken, 'recovery claim token must rotate');
    assert.ok(claim.inputs.find((i) => i.kind === 'lut').url !== currentGrant.url, 'recovery grant must rotate');
    assert.equal(claim.artifactInputDigest, interrupted.artifactInputDigest);
    assert.equal(claim.checkpoints.length, 0);
    await waitVersion(recovery.version.id);
    // Current owner access is rechecked after grant preparation, before checkpoint/upload/publication.
    const revoked = await queue('source-revoked');
    const revokedResult = await prepare(async (context) => {
      await api('/assets', 'DELETE', owner.accessToken, { ids: [media[1]], force: false }, 204);
      return executeStillClaim(context);
    });
    assert.ok(['failed', 'cancelled'].includes(revokedResult.status));
    // Revocation may already settle the operation; generic cleanup handles any active retry.
    const revokedVersion = await api('/studio/exports/' + revoked.version.id, 'GET', owner.accessToken);
    assert.notEqual(revokedVersion.state, 'published');
    assert.equal(revokedVersion.resultAssetId, null);
    const [revokedStored] =
      await sql`select "state", "resultAssetId" from studio_export_version where "id"=${revoked.version.id}`;
    assert.notEqual(revokedStored.state, 'published');
    assert.equal(revokedStored.resultAssetId, null);
    const persisted =
      await sql`select "envelope" from studio_project_revision where "projectId"=${project.id} and revision=1`;
    assert.equal(sha(canonicalJson(persisted[0].envelope.graph)), sha(canonicalJson(graph)));
    for (let i = 1; i <= launches; i++) {
      const log = await readFile(path.join(evidence, `api-${i}.log`), 'utf8');
      assert.ok(!log.includes('fileLutData') && !log.includes('gpu-file-lut-v1'));
    }
    const report = {
      realHttpClaim: true,
      realPgPublication: true,
      processRestarts: launches - 1,
      sourceSha256: config.sourceSha256,
      artifactSha256: build.artifactSha256,
      whole: { frames: 48, sha256: sha(output), versionId: version.id, observed },
      subrange: {
        frames: 30,
        sha256: sha(subBytes),
        versionId: subVersion.id,
        subrangeMaxError,
        meanError: subrangeError / (30 * 16 * 16 * 3),
      },
      lutSha256: sha(lut),
      originalGraphSha256: sha(canonicalJson(graph)),
      fences: [
        'foreign-owner',
        'PIN-before-enqueue',
        'locked-background-publication',
        'relock-download',
        'cancel-release-ack',
        'checksum-corruption',
        'stale-process-grant',
        'live-claim-restart-reclaim',
        'legacy-checkpoint-refusal',
        'prepared-digest-tamper',
        'source-revoked-after-read',
        'opaque-source-digest',
      ],
      limitations: [
        'controlled synthetic accounts and raster media',
        'no HDR acceptance',
        'no gallery/thumbnail acceptance',
        'no full FL105 acceptance',
      ],
    };
    await writeFile(path.join(evidence, 'durable-observation.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
  },
);
