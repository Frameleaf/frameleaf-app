import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Releases } from '../src/releases.js';
import { Refusal } from '../src/contracts.js';
const require = createRequire(import.meta.url);
const { verifyBundle, verifyNasManifest } = require('../../.github/verify-release-bundle.cjs');
const {
  createBundle,
  INSTALL_FILES,
  MANAGER_ASSETS,
  VARIANTS,
  REPOSITORY,
  ATTESTATION_TYPE,
} = require('../../.github/frameleaf-release.cjs');

test('Manager acquires exactly the v3 release assets and uses the authenticated verifier', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manager-release-'));
  const tag = 'frameleaf-v3.2.0-1';
  const sourceCommit = 'a'.repeat(40);
  const postgres = 'ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@sha256:' + 'c'.repeat(64);
  try {
    await mkdir(join(root, 'docker'));
    for (const name of INSTALL_FILES)
      await writeFile(
        join(root, 'docker', name),
        name === 'example.env'
          ? 'FRAMELEAF_VERSION=latest\n'
          : name.startsWith('docker-compose')
            ? [
                'services:',
                '  frameleaf-server:',
                '    image: ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}',
                '  frameleaf-machine-learning:',
                '    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}',
                '  database:',
                `    image: ${postgres}`,
                '',
              ].join('\n')
            : 'services: {}\n',
      );
    const manifest = {
      schemaVersion: 3,
      repository: REPOSITORY,
      tag,
      sourceCommit,
      buildRun: 'https://github.com/Frameleaf/frameleaf-app/actions/runs/123',
      dependencies: [{ reference: postgres.split('@')[0], digest: 'sha256:' + 'c'.repeat(64) }],
      images: VARIANTS.map((spec: any) => ({
        image: `ghcr.io/frameleaf/${spec.image}`,
        suffix: spec.suffix,
        platforms: spec.platforms,
        digest: 'sha256:' + 'b'.repeat(64),
        sourceCommit,
      })),
    };
    const bundle = join(root, 'bundle');
    await createBundle(bundle, root, tag, manifest);
    await assert.rejects(
      createBundle(join(root, 'amd64-only'), root, tag, {
        ...manifest,
        images: manifest.images.map((image) => ({ ...image, platforms: ['linux/amd64'] })),
      }),
      /NAS images are missing linux\/arm64/,
    );
    const nas = JSON.parse(await readFile(join(bundle, 'nas-manifest.json'), 'utf8'));
    const authenticated: string[] = [];
    const run = (_binary: string, args: string[]) => {
      const reference = args.at(-1)!;
      authenticated.push(args[0]);
      if (args[0] === 'verify') return '{}';
      const [name, digest] = reference.split('@');
      return JSON.stringify({
        payload: Buffer.from(
          JSON.stringify({
            predicateType: ATTESTATION_TYPE,
            predicate: manifest,
            subject: [{ name, digest: { sha256: digest.slice(7) } }],
          }),
        ).toString('base64'),
      });
    };
    const request = async () => ({
      head_sha: sourceCommit,
      head_branch: 'main',
      head_repository: { full_name: REPOSITORY },
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/docker.yml',
    });
    assert.equal((await verifyBundle(bundle, tag, { authenticate: true, run, request })).tag, tag);
    assert.equal(authenticated.filter((x) => x === 'verify').length, VARIANTS.length);
    assert.equal(authenticated.filter((x) => x === 'verify-attestation').length, VARIANTS.length);
    await assert.rejects(
      verifyBundle(bundle, tag, {
        authenticate: true,
        run: () => {
          throw new Error('signature refused');
        },
        request,
      }),
      /signature refused/,
    );
    await assert.rejects(
      verifyBundle(bundle, tag, {
        authenticate: true,
        run,
        request: async () => ({ ...(await request()), head_sha: 'd'.repeat(40) }),
      }),
      /Build provenance is not trusted/,
    );
    assert.throws(() => verifyNasManifest({ ...nas, schemaVersion: 1 }, manifest));
    for (const image of ['postgres:19', postgres.replace(':19beta4-pgvector0.8.7', ':14'), postgres.replace(':19beta4-pgvector0.8.7', ':19.0-pgvector0.8.7')])
      assert.throws(
        () => verifyNasManifest({ ...nas, images: { ...nas.images, postgres: image } }, manifest),
        /NAS database (?:image is not a digest-pinned|was not verified)/,
        image,
      );
    // Review M2: a GA build of the same major verifies once the release lists it as a verified dependency.
    const ga = postgres.replace(':19beta4-pgvector0.8.7', ':19.0-pgvector0.8.7');
    verifyNasManifest(
      { ...nas, images: { ...nas.images, postgres: ga } },
      { ...manifest, dependencies: [{ reference: ga.split('@')[0], digest: ga.split('@')[1] }] },
    );

    const names = [...INSTALL_FILES, 'nas-manifest.json', 'release-manifest.json', 'SHA256SUMS'];
    const assets = await Promise.all(
      names.map(async (name: string) => ({
        name,
        size: (await readFile(join(bundle, name))).length,
        browser_download_url: `https://github.com/Frameleaf/frameleaf-app/releases/download/${tag}/${name}`,
      })),
    );
    const downloaded: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (new URL(url).hostname === 'api.github.com')
        return new Response(JSON.stringify({ assets, draft: false, prerelease: false }));
      const name = url.split('/').at(-1)!;
      downloaded.push(name);
      return new Response(new Uint8Array(await readFile(join(bundle, name))));
    });
    const releases = new Releases(join(root, 'acquired'), 'seed');
    // The worker's process boundary remains production-only; the same shared verifier is exercised above.
    t.mock.method(releases, 'verify', async (directory: string, expectedTag: string) => ({
      directory,
      nas,
      release: await verifyBundle(directory, expectedTag, { authenticate: true, run, request }),
    }));
    assert.equal((await releases.acquire(tag)).nas.schemaVersion, 3);
    assert.deepEqual(downloaded, names);
    assert.equal(nas.migration, undefined);
    assert.equal(nas.images.valkey, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Manager lists only installable releases, newest first', async (t) => {
  const complete = MANAGER_ASSETS.map((name: string) => ({ name }));
  const release = (n: number, publishedAt: string, assets = complete) => ({
    tag_name: `frameleaf-v3.2.0-${n}`,
    published_at: publishedAt,
    draft: false,
    prerelease: false,
    body: '',
    assets,
  });
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(
      JSON.stringify([
        release(9, '2026-10-01T00:00:00Z'),
        release(13, '2026-10-03T00:00:00Z'),
        release(14, '2026-10-04T00:00:00Z', complete.filter((asset: any) => asset.name !== 'nas-manifest.json')),
        release(10, '2026-10-02T00:00:00Z'),
      ]),
    ),
  );
  const listed = await new Releases('/nonexistent', 'seed').available();
  assert.deepEqual(
    listed.map((item) => item.tag),
    ['frameleaf-v3.2.0-13', 'frameleaf-v3.2.0-10', 'frameleaf-v3.2.0-9'],
  );
});

test('Manager reads every release page: a late patch can sit past the first page', async (t) => {
  const assets = MANAGER_ASSETS.map((name: string) => ({ name }));
  const release = (n: number) => ({ tag_name: `frameleaf-v3.2.${n}`, published_at: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}Z`, draft: false, prerelease: false, body: '', assets });
  const pages = [Array.from({ length: 30 }, (_, n) => release(n + 10)), [release(1)]];
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested.push(new URL(url).searchParams.get('page')!);
    return new Response(JSON.stringify(pages[requested.length - 1]));
  });
  const listed = await new Releases('/nonexistent', 'seed').available();
  assert.deepEqual(requested, ['1', '2']);
  assert.equal(listed.length, 31);
  assert.ok(listed.some((item) => item.tag === 'frameleaf-v3.2.1'));
});

test('a missing release is ineligible, while other GitHub failures retain their HTTP status', async (t) => {
  const releases = new Releases('/nonexistent', 'seed');
  for (const status of [404, 403, 429, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status }));
    await assert.rejects(releases.eligible('frameleaf-v1.1.8'), (error: unknown) => {
      assert.ok(error instanceof Refusal);
      assert.equal(error.code, status === 404 ? 'release_not_eligible' : 'release_service_unavailable');
      assert.match(error.detail!, new RegExp(`HTTP ${status}`));
      return true;
    });
    if (status === 404)
      await assert.rejects(releases.available(), { code: 'release_service_unavailable' });
    t.mock.restoreAll();
  }
});
