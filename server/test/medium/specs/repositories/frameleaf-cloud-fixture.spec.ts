import { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CloudConnectionState, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

/**
 * FL-201: the e2e fake Frameleaf Cloud (`e2e/src/fixtures/frameleaf-cloud-fixture.mjs`, answering the
 * vendored `@frameleaf/cloud-contracts` fixtures) is driven here by this server's real cloud client:
 * discovery, the DPoP-bound instance token, the ML gateway and the consent calls. If the fake or the
 * contract fixtures drift from what the client accepts, this fails before any e2e run.
 */
const FIXTURE = fileURLToPath(new URL('../../../../../e2e/src/fixtures/frameleaf-cloud-fixture.mjs', import.meta.url));
const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';

let fixture: ChildProcess;
let identityDir: string;
let CLOUD_URL: string;

/** Waits for the fixture's ready line; fails at once, with its stderr, if it exits first. */
const startFixture = (child: ChildProcess) =>
  new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const fail = (reason: string) =>
      reject(new Error(`the Frameleaf Cloud fixture did not start: ${reason}\nstdout: ${stdout}\nstderr: ${stderr}`));
    const timer = setTimeout(() => fail('no ready line within 30 s'), 30_000);
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      const ready = /listening on (http:\/\/\S+)/.exec(stdout);
      if (ready) {
        clearTimeout(timer);
        resolve(ready[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(String(error));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      fail(`exited with code ${code} (signal ${signal})`);
    });
  });

beforeAll(async () => {
  identityDir = await mkdtemp(join(tmpdir(), 'fl201-identity-'));
  // Port 0 lets the fixture take any free port; without a URL it reports the address it bound.
  const { FRAMELEAF_CLOUD_FIXTURE_URL: _unused, ...inherited } = process.env;
  const env = { ...inherited, FRAMELEAF_CLOUD_FIXTURE_PORT: '0' };
  fixture = spawn(process.execPath, [FIXTURE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  CLOUD_URL = await startFixture(fixture);
}, 35_000);

afterAll(async () => {
  fixture?.kill();
  await rm(identityDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${CLOUD_URL}/__fixture/reset`, { method: 'POST' });
});

const setup = () => {
  const metadata = new Map<string, unknown>([
    [
      SystemMetadataKey.FrameleafCloudLink,
      {
        status: 'linked',
        cloudUrl: CLOUD_URL,
        instanceId: INSTANCE_ID,
        dataRegion: 'eu',
        heartbeat: { nextAt: '2099-01-01T00:00:00.000Z' },
      },
    ],
  ]);
  const logger = LoggingRepository.create();
  const cloud = new FrameleafCloudRepository(logger);
  const deps = {
    configRepository: {
      getEnv: () => mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, url: CLOUD_URL, identityDir } }),
    },
    databaseRepository: { withLock: (_lock: unknown, callback: () => unknown) => callback() },
    systemMetadataRepository: {
      get: (key: string) => Promise.resolve(metadata.get(key) ?? null),
      set: (key: string, value: unknown) => Promise.resolve(void metadata.set(key, value)),
      delete: (key: string) => Promise.resolve(void metadata.delete(key)),
    },
    instanceIdentityRepository: new InstanceIdentityRepository(),
    frameleafCloudRepository: cloud,
    eventRepository: { emit: () => Promise.resolve() },
    logger,
  } as never;
  return { deps, ml: new FrameleafCloudMlRepository(cloud) };
};

const bump = (requiredVersion: string) =>
  fetch(`${CLOUD_URL}/__fixture/consent`, { method: 'POST', body: JSON.stringify({ requiredVersion }) });

describe('the e2e Frameleaf Cloud fixture against this server’s client (FL-201)', () => {
  it('links, mints a DPoP-bound token and answers the gateway in the shapes the client accepts', async () => {
    const { deps, ml } = setup();
    const resolution = await resolveCloudGateway(deps);
    expect(resolution.state).toBe(CloudConnectionState.Ready);
    const gateway = (resolution as { gateway: Parameters<typeof ml.getCapabilities>[0] }).gateway;

    await ml.ping(gateway);
    const capabilities = await ml.getCapabilities(gateway);
    expect(capabilities.consent).toMatchObject({ requiredVersion: '2026-09-26.1', recordedVersion: null });
    await expect(ml.getCatalog(gateway)).resolves.toBeDefined();
    await expect(ml.getWallet(gateway)).resolves.toBeDefined();
  });

  it('records, refuses an outdated version, withdraws, and reports a bumped required version', async () => {
    const { deps, ml } = setup();
    const { gateway } = (await resolveCloudGateway(deps)) as never as {
      gateway: Parameters<typeof ml.getCapabilities>[0];
    };
    const features = { identityNames: false, medicalSignals: false, ocrAddon: false };

    const terms = await ml.getConsent(gateway, { identityNames: false, medicalSignals: false });
    expect(terms).toMatchObject({ requiredVersion: '2026-09-26.1', recordedVersion: null });
    await expect(ml.recordConsent(gateway, { version: terms.requiredVersion, features })).resolves.toMatchObject({
      recordedVersion: '2026-09-26.1',
    });
    expect((await ml.getCapabilities(gateway)).consent.recordedVersion).toBe('2026-09-26.1');

    // the cloud requires a newer disclosure: an older version is refused with the version now required
    await bump('2026-10-01.1');
    expect((await ml.getCapabilities(gateway)).consent).toMatchObject({
      requiredVersion: '2026-10-01.1',
      recordedVersion: '2026-09-26.1',
    });
    const outdated = await ml.recordConsent(gateway, { version: '2026-09-26.1', features }).catch((error) => error);
    expect(outdated).toBeInstanceOf(FrameleafCloudError);
    expect((outdated as FrameleafCloudError).refusal).toBe('consent-version-outdated');
    const bumped = await ml.getConsent(gateway);
    expect(bumped.requiredVersion).toBe('2026-10-01.1');
    // the terms are a different text, so their digest changes too
    expect(bumped.textSha256).not.toBe(terms.textSha256);

    await ml.revokeConsent(gateway);
    expect((await ml.getCapabilities(gateway)).consent.recordedVersion).toBeNull();
  });
});
