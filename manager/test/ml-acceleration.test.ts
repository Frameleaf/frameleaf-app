import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureUnraidCompose, detectAcceleration, detectTranscoding, releaseImages, renderCompose } from '../src/compose.js';
import type { Installation } from '../src/contracts.js';
import type { VerifiedRelease } from '../src/releases.js';

async function sysfs(root: string, cards: Record<string, string>, kfd = false) {
  for (const [node, vendor] of Object.entries(cards)) {
    await mkdir(join(root, 'class/drm', node, 'device'), { recursive: true });
    await writeFile(join(root, 'class/drm', node, 'device/vendor'), `${vendor}\n`);
  }
  if (kfd) await mkdir(join(root, 'class/kfd'), { recursive: true });
}

test('Manager picks the ML variant from host GPUs and Docker runtimes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'manager-accel-'));
  const none = async () => '{"runc":{}}';
  const nvidia = async () => '{"runc":{},"nvidia":{"path":"nvidia-container-runtime"}}';
  try {
    const empty = join(folder, 'empty');
    const intel = join(folder, 'intel');
    const amd = join(folder, 'amd');
    const amdNoKfd = join(folder, 'amd-no-kfd');
    await sysfs(intel, { renderD128: '0x8086', card0: '0x1af4' });
    await sysfs(amd, { renderD128: '0x8086', renderD129: '0x1002' }, true);
    await sysfs(amdNoKfd, { renderD128: '0x1002' });
    assert.deepEqual(await detectTranscoding(empty, none), {});
    assert.deepEqual(await detectTranscoding(intel, none), { devices: ['/dev/dri:/dev/dri'] });
    assert.deepEqual(await detectTranscoding(amdNoKfd, none), { devices: ['/dev/dri:/dev/dri'] });
    // An installed NVIDIA runtime alone is not evidence that this host has an NVIDIA GPU.
    assert.deepEqual(await detectTranscoding(empty, nvidia), {});
    const nv = join(folder, 'nvidia');
    await mkdir(join(nv, 'bus/pci/drivers/nvidia/0000:01:00.0'), { recursive: true });
    assert.deepEqual(await detectTranscoding(nv, none), {});
    assert.deepEqual(await detectTranscoding(nv, nvidia), {
      deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu', 'compute', 'video'] }] } } },
    });
    assert.equal(await detectAcceleration(empty, none, 'x64'), 'cpu');
    assert.equal(await detectAcceleration(intel, none, 'x64'), 'openvino');
    assert.equal(await detectAcceleration(amd, none, 'x64'), 'rocm');
    assert.equal(await detectAcceleration(amdNoKfd, none, 'x64'), 'cpu');
    assert.equal(await detectAcceleration(intel, nvidia, 'x64'), 'cuda');
    assert.equal(await detectAcceleration(intel, async () => Promise.reject(new Error('no docker')), 'x64'), 'openvino');
    // The accelerated images are amd64 only.
    assert.equal(await detectAcceleration(intel, nvidia, 'arm64'), 'cpu');
    process.env.MANAGER_ML_ACCELERATION = 'cpu';
    assert.equal(await detectAcceleration(intel, nvidia, 'x64'), 'cpu');
  } finally {
    delete process.env.MANAGER_ML_ACCELERATION;
    await rm(folder, { recursive: true, force: true });
  }
});

test('the ML service uses the attested variant digest with its device passthrough', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'manager-accel-'));
  try {
    const bundle = join(folder, 'bundle'),
      stack = join(folder, 'stack');
    await mkdir(bundle);
    await writeFile(
      join(bundle, 'docker-compose.yml'),
      JSON.stringify({ services: { database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} } }),
    );
    const digest = (c: string) => `ghcr.io/frameleaf/frameleaf-machine-learning@sha256:${c.repeat(64)}`;
    const release = {
      directory: bundle,
      nas: {
        images: {
          server: digest('a'),
          machineLearning: digest('b'),
          machineLearningVariants: { openvino: digest('c'), cuda: digest('d'), rocm: digest('e') },
          postgres: digest('f'),
        },
      },
    } as unknown as VerifiedRelease;
    const installation = {
      id: 'a'.repeat(12),
      project: 'frameleaf-' + 'a'.repeat(12),
      ml: true,
      origin: 'new_import',
      databasePath: '/appdata/pg',
      mounts: [],
    } as unknown as Installation;
    const ml = async (accel: 'cpu' | 'cuda' | 'rocm' | 'openvino', r = release) => {
      await renderCompose(r, installation, 'pw', stack, undefined, accel);
      return JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8')).services['frameleaf-machine-learning'];
    };

    const openvino = await ml('openvino');
    assert.equal(openvino.image, digest('c'));
    assert.deepEqual(openvino.devices, ['/dev/dri:/dev/dri']);
    assert.deepEqual(openvino.device_cgroup_rules, ['c 189:* rmw']);

    const rocm = await ml('rocm');
    assert.equal(rocm.image, digest('e'));
    assert.deepEqual(rocm.devices, ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd']);
    assert.deepEqual(rocm.group_add, ['video']);

    const cuda = await ml('cuda');
    assert.equal(cuda.image, digest('d'));
    assert.deepEqual(cuda.deploy.resources.reservations.devices, [{ driver: 'nvidia', count: 1, capabilities: ['gpu'] }]);

    const cpu = await ml('cpu');
    assert.equal(cpu.image, digest('b'));
    assert.equal(cpu.devices, undefined);

    // An older release without variants keeps the CPU image and passes no devices.
    const older = { ...release, nas: { images: { ...release.nas.images, machineLearningVariants: undefined } } };
    const fallback = await ml('openvino', older as unknown as VerifiedRelease);
    assert.equal(fallback.image, digest('b'));
    assert.equal(fallback.devices, undefined);
    process.env.MANAGER_PLATFORM = 'unraid';
    await ml('openvino');
    const unraid = JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8'));
    for (const service of Object.values(unraid.services) as any[]) {
      assert.equal(service.labels['net.unraid.docker.managed'], 'dockerman');
      assert.ok(service.labels['net.unraid.docker.icon'].endsWith('/mark.png'));
      assert.equal(service.labels['app.frameleaf.manager'], installation.id);
    }
    assert.equal(unraid.services['frameleaf-server'].labels['net.unraid.docker.webui'], 'http://[IP]:[PORT:2283]');
    const transcoding = await detectTranscoding();
    assert.deepEqual(unraid.services['frameleaf-server'].devices, transcoding.devices ?? []);
    assert.deepEqual(unraid.services['frameleaf-server'].deploy, transcoding.deploy);
  } finally {
    delete process.env.MANAGER_PLATFORM;
    await rm(folder, { recursive: true, force: true });
  }
});

test('existing Unraid stacks refresh video devices without changing storage or ML configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-existing-gpu-'));
  const server = { labels: { 'app.frameleaf.manager': 'a'.repeat(12) },
    devices: ['/dev/dri:/dev/dri', '/dev/custom:/dev/custom'], volumes: [{ source: '/appdata/media', target: '/data' }],
    environment: { DB_PASSWORD: 'literal$$password' }, deploy: { resources: { limits: { cpus: '2' },
      reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu'] }] } } } };
  try {
    const path = join(directory, 'compose.json');
    const ml = { labels: { 'app.frameleaf.manager': 'a'.repeat(12) }, devices: ['/dev/kfd:/dev/kfd'], image: 'fixture/rocm' };
    await writeFile(path, JSON.stringify({ name: 'frameleaf-' + 'a'.repeat(12), services: { 'frameleaf-server': server, 'frameleaf-machine-learning': ml } }));
    for (const hardware of [{}, { devices: ['/dev/dri:/dev/dri'] }, {
      deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu', 'compute', 'video'] }] } } },
    }]) {
      await configureUnraidCompose(directory, hardware);
      const compose = JSON.parse(await readFile(path, 'utf8'));
      const actual = compose.services['frameleaf-server'];
      assert.deepEqual(actual.devices, ['/dev/custom:/dev/custom', ...((hardware as any).devices ?? [])]);
      assert.deepEqual(actual.deploy.resources.reservations.devices, (hardware as any).deploy?.resources.reservations.devices ?? []);
      assert.equal(actual.deploy.resources.limits.cpus, '2');
      assert.deepEqual(actual.volumes, server.volumes);
      assert.deepEqual(actual.environment, server.environment);
      assert.deepEqual(compose.services['frameleaf-machine-learning'].devices, ml.devices);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the download step pulls the ML variant the compose file runs', async () => {
  const digest = (c: string) => `ghcr.io/frameleaf/frameleaf-machine-learning@sha256:${c.repeat(64)}`;
  const images = {
    server: digest('a'),
    machineLearning: digest('b'),
    machineLearningVariants: { openvino: digest('c') },
    postgres: digest('f'),
  };
  assert.deepEqual(await releaseImages(images, 'openvino'), [digest('a'), digest('b'), digest('f'), digest('c')]);
  assert.deepEqual(await releaseImages(images, 'cpu'), [digest('a'), digest('b'), digest('f')]);
  // No attested CUDA digest: compose keeps the CPU image, so nothing extra is pulled.
  assert.deepEqual(await releaseImages(images, 'cuda'), [digest('a'), digest('b'), digest('f')]);
});
