import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Releases } from '../src/releases.js';
const require = createRequire(import.meta.url);
const { verifyBundle, verifyNasManifest } = require('../../.github/verify-release-bundle.cjs');
const {
  createBundle,
  INSTALL_FILES,
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
          ? 'FRAMELEAF_VERSION=release\n'
          : name.startsWith('docker-compose')
            ? [
                'services:',
                '  frameleaf-server:',
                '    image: ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}',
                '  immich-machine-learning:',
                '    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}',
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
      head_branch: 'fork/main',
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
    for (const image of ['postgres:19', postgres.replace(':19beta4-pgvector0.8.7', ':14')])
      assert.throws(() => verifyNasManifest({ ...nas, images: { ...nas.images, postgres: image } }, manifest));

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
      if (url.includes('api.github.com'))
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
