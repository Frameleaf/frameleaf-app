import { LoginResponseDto } from '@frameleaf/sdk';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-201 against the fake Frameleaf Cloud (`docker-compose.frameleaf-cloud-fixture.yml`): an
 * administrator accepts the processing terms, revokes them, and the cloud then requires a newer version.
 * Every cloud-processing path fails closed with the refusal's code, and the cloud's own record follows.
 */
const FIXTURE = 'http://127.0.0.1:3010';
const CLOUD_URL = 'http://frameleaf-cloud-fixture:3010';
const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
// FL-286: formerly pending workloads now use the same versioned consent as descriptions.
const WORKLOAD = 'enrichment';
const PENDING = ['restoration-faithful', 'restoration-creative', 'upscale', 'interpolation'];
/** Admission reads the required version from /capabilities, cached for 10 seconds. */
const PROBE_CACHE_MS = 11_000;

type FixtureState = {
  requiredVersion: string;
  recorded: { version: string } | null;
};

const fixtureState = async (): Promise<FixtureState> => {
  const response = await fetch(`${FIXTURE}/__fixture/state`);
  return (await response.json()) as FixtureState;
};

/** What the cloud has on record for this server. */
const recorded = async () => {
  const state = await fixtureState();
  return state.recorded;
};

describe('Frameleaf Cloud processing consent (FL-201)', () => {
  let admin: LoginResponseDto;
  let destinationId: string;
  const auth = () => asBearerAuth(admin.accessToken);

  const admission = () =>
    request(app).post(`/ml-destinations/${destinationId}/admission`).set(auth()).send({ workload: WORKLOAD });

  const accept = async (identityNames = false) => {
    const { body: terms } = await request(app)
      .get(`/admin/cloud/ml/consent/terms?identityNames=${identityNames}&medicalSignals=false`)
      .set(auth())
      .expect(200);
    return request(app)
      .put(`/ml-destinations/${destinationId}/consent`)
      .set(auth())
      .send({
        acknowledgeMediaLeavesNetwork: true,
        version: terms.requiredVersion,
        textSha256: terms.textSha256,
        features: { identityNames, medicalSignals: false, ocrAddon: false },
      });
  };

  beforeAll(async () => {
    await fetch(`${FIXTURE}/__fixture/reset`, { method: 'POST' });
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    // linked to the fake, with Cloud processing on and the explicit request allow-list configured
    const client = await utils.connectDatabase();
    const put = (key: string, value: unknown) =>
      client.query(
        `INSERT INTO system_metadata (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = system_metadata.value || EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    await put('frameleaf-cloud-link', {
      status: 'linked',
      cloudUrl: CLOUD_URL,
      instanceId: INSTANCE_ID,
      dataRegion: 'eu',
      heartbeat: { nextAt: '2099-01-01T00:00:00.000Z' },
    });
    const config = await utils.getSystemConfig(admin.accessToken);
    await put('system-config', {
      frameleafCloud: {
        ...config.frameleafCloud,
        cloudMl: {
          ...config.frameleafCloud!.cloudMl,
          enabled: true,
          routing: {
            ...config.frameleafCloud!.cloudMl.routing,
            descriptions: 'both',
            upscale: 'both',
            restoration: 'both',
            interpolation: 'both',
          },
        },
      },
    });
    await utils.getSystemConfig(admin.accessToken); // refresh the server's cached config

    const { body: status } = await request(app).get('/admin/cloud/ml').set(auth()).expect(200);
    expect(status.connection).toBe('ready');
    const { body: destination } = await request(app)
      .post('/admin/cloud/ml/destination')
      .set(auth())
      .send({ workloads: [WORKLOAD, ...PENDING] })
      .expect(201);
    destinationId = destination.id;
  });

  it('refuses every cloud-processing path until consent is accepted, with code consent-missing', async () => {
    const { status, body } = await admission();
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'consent-missing' });
    for (const workload of PENDING) {
      const refused = await request(app)
        .post(`/ml-destinations/${destinationId}/admission`)
        .set(auth())
        .send({ workload })
        .expect(400);
      expect(refused.body).toMatchObject({ code: 'consent-missing' });
    }
    expect(await recorded()).toBeNull();
  });

  it('accepts the version the cloud requires, and records it with the cloud too', async () => {
    const { requiredVersion } = await fixtureState();
    const accepted = await accept();
    expect(accepted.status).toBe(200);
    expect(await recorded()).toMatchObject({ version: requiredVersion });

    const { body: status } = await request(app).get('/admin/cloud/ml').set(auth()).expect(200);
    expect(status.consent).toMatchObject({
      requiredVersion,
      acceptedVersion: requiredVersion,
      outdated: false,
    });
    const admitted = await admission();
    // This fixture's catalogue contains restoration only: approved description consent passes,
    // but no description model is fabricated to make downstream model admission succeed.
    expect(admitted.body).toMatchObject({ code: 'model-mismatch' });
    expect(admitted.status).toBe(400);
  });

  it('admits approved restoration models and still requires provider support for upscale/interpolation (FL-286)', async () => {
    for (const workload of PENDING) {
      const refused = await request(app)
        .post(`/ml-destinations/${destinationId}/admission`)
        .set(auth())
        .send({ workload });
      if (workload.startsWith('restoration-')) {
        expect(refused.status).toBe(200);
        expect(refused.body).toMatchObject({ kind: 'frameleaf-cloud', workload });
      } else {
        // The fixture advertises restoration only; approval does not invent provider support.
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({ code: 'workload-not-served' });
      }
    }
  });

  it('revokes consent on this server and with the cloud; every path is refused again', async () => {
    await request(app).delete(`/ml-destinations/${destinationId}/consent`).set(auth()).expect(200);
    expect(await recorded()).toBeNull();

    const { status, body } = await admission();
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'consent-missing' });
    for (const workload of PENDING) {
      const refused = await request(app)
        .post(`/ml-destinations/${destinationId}/admission`)
        .set(auth())
        .send({ workload })
        .expect(400);
      expect(refused.body).toMatchObject({ code: 'consent-missing' });
    }
  });

  it('fails closed with consent-version-outdated once the cloud requires a newer version', async () => {
    const acceptedAgain = await accept();
    expect(acceptedAgain.status).toBe(200);
    await fetch(`${FIXTURE}/__fixture/consent`, {
      method: 'POST',
      body: JSON.stringify({ requiredVersion: '2026-10-01.1' }),
    });
    await new Promise((resolve) => setTimeout(resolve, PROBE_CACHE_MS));

    const refused = await admission();
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'consent-version-outdated' });
    for (const workload of PENDING) {
      const refused = await request(app)
        .post(`/ml-destinations/${destinationId}/admission`)
        .set(auth())
        .send({ workload })
        .expect(400);
      expect(refused.body).toMatchObject({ code: 'consent-version-outdated' });
    }
    const { body: status } = await request(app).get('/admin/cloud/ml').set(auth()).expect(200);
    expect(status.consent).toMatchObject({
      requiredVersion: '2026-10-01.1',
      outdated: true,
    });

    // Every approved workload still needs the provider's current version and digest.
    const acceptedNew = await accept();
    expect(acceptedNew.status).toBe(200);
    expect(await recorded()).toMatchObject({ version: '2026-10-01.1' });
    await new Promise((resolve) => setTimeout(resolve, PROBE_CACHE_MS));
    const admitted = await admission();
    expect(admitted.body).toMatchObject({ code: 'model-mismatch' });
    expect(admitted.status).toBe(400);
  });
});
