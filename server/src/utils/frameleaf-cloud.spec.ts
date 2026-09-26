import { describe, expect, it } from 'vitest';
import { MlAdmissionRefusal } from 'src/enum.js';
import {
  CloudErrorCode,
  FrameleafCloudError,
  type FrameleafDiscoveryDocument,
  cloudAddressProblem,
  cloudDomainOf,
  cloudErrorCode,
  discoveryProblem,
  discoverySchema,
  errorEnvelopeSchema,
  refusalFromCloudError,
  stepUpUrl,
  storeAddress,
  usageSchema,
  walletResponseSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

// These cases need plain-http addresses to prove they are refused.
/* eslint-disable unicorn/prefer-https */
const document = (overrides: Partial<FrameleafDiscoveryDocument> = {}): FrameleafDiscoveryDocument => ({
  version: 1,
  validFor: 3600,
  issuer: 'https://id.frameleaf.cloud',
  api: 'https://frameleaf.cloud/api',
  ml: { eu: 'https://ml.eu.frameleaf.cloud', na: 'https://ml.na.frameleaf.cloud' },
  ...overrides,
});

describe(discoveryProblem.name, () => {
  it('accepts the configured cloud host and its subdomains over https', () => {
    expect(discoveryProblem('https://frameleaf.cloud', document())).toBeNull();
  });

  it('refuses a token issuer, API or gateway on another host (FL-159)', () => {
    for (const overrides of [
      { issuer: 'https://id.attacker.example' },
      { issuer: 'https://frameleaf.cloud.attacker.example' },
      { issuer: 'https://evilframeleaf.cloud' },
      { api: 'https://api.example.com' },
      { ml: { eu: 'https://ml.eu.frameleaf.cloud', na: 'https://ml.example.net' } },
    ]) {
      expect(discoveryProblem('https://frameleaf.cloud', document(overrides)), JSON.stringify(overrides)).toMatch(
        /is not on frameleaf\.cloud/,
      );
    }
  });

  it('pins every address to the configured effective port', () => {
    expect(
      discoveryProblem('https://frameleaf.cloud', document({ api: 'https://frameleaf.cloud:443/api' })),
    ).toBeNull();
    expect(
      discoveryProblem('https://frameleaf.cloud', document({ issuer: 'https://id.frameleaf.cloud:8443' })),
    ).toMatch(/is not on port 443/);
    expect(discoveryProblem('https://frameleaf.cloud:8443', document())).toMatch(/is not on port 8443/);
    expect(
      discoveryProblem('https://frameleaf.cloud:8443', {
        ...document(),
        issuer: 'https://id.frameleaf.cloud:8443',
        api: 'https://frameleaf.cloud:8443/api',
        ml: { eu: 'https://ml.eu.frameleaf.cloud:8443' },
      }),
    ).toBeNull();
  });

  it('refuses http unless the configured cloud is itself http, and credentials in a URL', () => {
    expect(discoveryProblem('https://frameleaf.cloud', document({ issuer: 'http://id.frameleaf.cloud' }))).toMatch(
      /not https/,
    );
    expect(
      discoveryProblem('http://cloud.test:8080', {
        ...document(),
        issuer: 'http://cloud.test:8080/id',
        api: 'http://cloud.test:8080/api',
        ml: { eu: 'http://ml.eu.cloud.test:8080' },
      }),
    ).toBeNull();
    expect(
      discoveryProblem('https://frameleaf.cloud', document({ api: 'https://user:secret@frameleaf.cloud/api' })),
    ).toMatch(/credentials/);
  });

  describe('sibling subdomains of the cloud domain (FL-177, as-built decision #1)', () => {
    const production = {
      version: 1,
      validFor: 3600,
      issuer: 'https://id.frameleaf.cloud',
      api: 'https://api.frameleaf.cloud',
      ml: { eu: 'https://ml.eu.frameleaf.cloud', na: 'https://ml-na.frameleaf.cloud' },
      endpoints: { heartbeat: 'https://api.frameleaf.cloud/v1/instance/heartbeat' },
    };

    it.each(['instance/discovery.json', 'instance/discovery-instance.json'])(
      'reads the golden %s and accepts every address in it (api., id., ml. siblings)',
      (name) => {
        const document = discoverySchema.parse(cloudContractFixture(name));
        expect(document).toMatchObject({
          issuer: 'https://id.frameleaf.cloud',
          api: 'https://api.frameleaf.cloud',
          ml: { eu: 'https://ml.eu.frameleaf.cloud', na: 'https://ml.na.frameleaf.cloud' },
          endpoints: {
            heartbeat: 'https://api.frameleaf.cloud/v1/instance/heartbeat',
            mlGrant: 'https://id.frameleaf.cloud/token',
          },
        });
        expect(discoveryProblem('https://api.frameleaf.cloud', document)).toBeNull();
        // FC-19 final (383f815): the account site's store, a sibling too (as-built decision #29)
        expect(storeAddress('https://api.frameleaf.cloud', document.store)).toBe(
          'https://account.frameleaf.cloud/store',
        );
        expect(storeAddress('https://api.frameleaf.example', document.store)).toBeNull();
        // the same document under another configured cloud is refused as a whole
        expect(discoveryProblem('https://api.frameleaf.example', document)).toMatch(
          /is not on api\.frameleaf\.example/,
        );
      },
    );

    it('accepts id., api. and ml. under FRAMELEAF_CLOUD_URL=https://api.frameleaf.cloud', () => {
      expect(discoveryProblem('https://api.frameleaf.cloud', production)).toBeNull();
      expect(
        cloudAddressProblem('https://api.frameleaf.cloud', 'sign-in issuer', 'https://id.frameleaf.cloud'),
      ).toBeNull();
    });

    it('drops a store address that is not a URL without failing discovery', () => {
      const document = discoverySchema.parse({ ...production, store: 'not a url' });
      expect(document.store).toBeUndefined();
      expect(storeAddress('https://api.frameleaf.cloud', undefined)).toBeNull();
      expect(storeAddress('https://api.frameleaf.cloud', 'http://account.frameleaf.cloud/store')).toBeNull();
    });

    it('keeps refusing every other host', () => {
      for (const issuer of [
        'https://frameleaf.cloud.attacker.example',
        'https://id.attacker.example',
        'https://evilframeleaf.cloud',
        'https://id.cloud',
      ]) {
        expect(discoveryProblem('https://api.frameleaf.cloud', { ...production, issuer }), issuer).toMatch(
          /is not on frameleaf\.cloud/,
        );
      }
    });

    it('never widens an apex, a two-label host, an IP address, localhost or any other domain to its parent', () => {
      expect(cloudDomainOf('api.frameleaf.cloud')).toBe('frameleaf.cloud');
      expect(cloudDomainOf('frameleaf.cloud')).toBeNull();
      expect(cloudDomainOf('cloud.test')).toBeNull();
      expect(cloudDomainOf('localhost')).toBeNull();
      expect(cloudDomainOf('127.0.0.1')).toBeNull();
      expect(cloudDomainOf('[::1]')).toBeNull();
      expect(cloudDomainOf('frameleaf.co.uk')).toBeNull();
      expect(cloudDomainOf('api.frameleaf.co.uk')).toBeNull();
      expect(cloudDomainOf('evilframeleaf.cloud')).toBeNull();
      expect(cloudAddressProblem('https://frameleaf.co.uk', 'issuer', 'https://id.attacker.co.uk')).toMatch(/not on/);
      expect(cloudAddressProblem('https://frameleaf.cloud', 'issuer', 'https://id.other.cloud')).toMatch(/not on/);
      expect(cloudAddressProblem('http://127.0.0.1:8080', 'issuer', 'http://1.0.0.1:8080')).toMatch(/not on/);
    });

    // FL-177 review: shared hosting and registry domains are registrable by anyone
    it.each([
      ['https://frameleaf.herokuapp.com', 'https://attacker.herokuapp.com'],
      ['https://frameleaf.github.io', 'https://attacker.github.io'],
      ['https://frameleaf.duckdns.org', 'https://attacker.duckdns.org'],
      ['https://frameleaf.fly.dev', 'https://attacker.fly.dev'],
      ['https://api.ec2-1-2-3-4.compute.amazonaws.com', 'https://id.ec2-5-6-7-8.compute.amazonaws.com'],
      ['https://api.frameleaf.id.au', 'https://id.attacker.id.au'],
      ['https://api.cloud.example.com', 'https://id.example.com'],
    ])('accepts only %s itself and its subdomains, never %s', (configured, sibling) => {
      expect(cloudDomainOf(new URL(configured).hostname)).toBeNull();
      expect(cloudAddressProblem(configured, 'issuer', sibling)).toMatch(/not on/);
      expect(cloudAddressProblem(configured, 'issuer', configured)).toBeNull();
      expect(cloudAddressProblem(configured, 'issuer', configured.replace('https://', 'https://id.'))).toBeNull();
    });

    it('still pins siblings to https and the configured port', () => {
      expect(cloudAddressProblem('https://api.frameleaf.cloud', 'issuer', 'http://id.frameleaf.cloud')).toMatch(
        /not https/,
      );
      expect(cloudAddressProblem('https://api.frameleaf.cloud', 'issuer', 'https://id.frameleaf.cloud:8443')).toMatch(
        /not on port 443/,
      );
    });
  });
});

describe('error envelope (FL-177, as-built decisions #15–#18)', () => {
  const failure = (status: number, body: unknown) => {
    const parsed = errorEnvelopeSchema.safeParse(body);
    const envelope = parsed.success ? parsed.data : null;
    return new FrameleafCloudError(refusalFromCloudError(status, envelope), status, 'x', envelope);
  };

  it('reads the golden insufficient-credits envelope: kebab-case refusal, string detail, data object', () => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture('errors/insufficient-credits.json'));
    expect(envelope).toEqual({
      code: 'insufficient-credits',
      message: 'Your AI Wallet balance is too low for this job.',
      retryable: false,
      refusal: 'wallet-insufficient',
      detail: null,
      data: { requiredUsd: 1.25, freeUsd: 0.4 },
      requestId: 'req_01J8ZK3M4N5P6Q7R',
    });
    expect(refusalFromCloudError(402, envelope)).toBe(MlAdmissionRefusal.WalletInsufficient);
  });

  it('reads the golden use_dpop_nonce envelope, which carries no refusal', () => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture('errors/use-dpop-nonce.json'));
    expect(envelope).toMatchObject({ code: 'use_dpop_nonce', retryable: true, refusal: null, data: null });
    expect(refusalFromCloudError(401, envelope)).toBe(MlAdmissionRefusal.DestinationUnhealthy);
  });

  it.each([
    ['errors/key-retired.json', 401, CloudErrorCode.KeyRetired, MlAdmissionRefusal.CloudUnavailable],
    ['errors/nonce-invalid.json', 400, CloudErrorCode.NonceInvalid, MlAdmissionRefusal.CloudUnavailable],
    ['errors/rotation-rate-limited.json', 429, 'rate-limited', MlAdmissionRefusal.QuotaExceeded],
  ])('reads the golden %s envelope (FC-19)', (name, status, code, refusal) => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture(name));
    expect(envelope).toMatchObject({ code, refusal: null, detail: null, data: null, requestId: expect.any(String) });
    expect(envelope.message).not.toBe('');
    expect(refusalFromCloudError(status, envelope)).toBe(refusal);
  });

  it('keeps the code when one field has another shape, so a daily cap is never misread', () => {
    const envelope = errorEnvelopeSchema.parse({
      code: 'daily-cap',
      message: 'Daily cap reached',
      detail: { capUsd: 10 },
      refusal: 42,
      data: 'not an object',
      requestId: 'req_01J8ZK3M4N5P6Q7R',
    });
    expect(envelope).toMatchObject({ code: 'daily-cap', detail: null, refusal: null, data: null });
    expect(refusalFromCloudError(402, envelope)).toBe(MlAdmissionRefusal.BudgetExceeded);
  });

  it('takes an explicit refusal, including request-invalid, and maps 422 without one', () => {
    expect(failure(422, { code: 'request-invalid', message: 'bad', refusal: 'request-invalid' }).refusal).toBe(
      MlAdmissionRefusal.RequestInvalid,
    );
    expect(failure(422, { code: 'request-invalid', message: 'bad' }).refusal).toBe(MlAdmissionRefusal.RequestInvalid);
    expect(failure(503, { code: 'capacity', message: 'busy', refusal: 'destination-unhealthy' }).refusal).toBe(
      MlAdmissionRefusal.DestinationUnhealthy,
    );
  });

  it('maps the contract codes the server acts on', () => {
    expect(failure(403, { code: CloudErrorCode.ConsentVersionOutdated, message: '' }).refusal).toBe(
      MlAdmissionRefusal.ConsentVersionOutdated,
    );
    expect(failure(403, { code: CloudErrorCode.EntitlementMissing, message: '' }).refusal).toBe(
      MlAdmissionRefusal.EntitlementMissing,
    );
    expect(failure(401, { code: CloudErrorCode.EntitlementMissing, message: '' }).refusal).toBe(
      MlAdmissionRefusal.EntitlementMissing,
    );
    expect(failure(403, { code: CloudErrorCode.InstanceRevoked, message: '' }).refusal).toBe(
      MlAdmissionRefusal.CloudUnavailable,
    );
    expect(failure(401, { code: CloudErrorCode.InvalidToken, message: '' }).refusal).toBe(
      MlAdmissionRefusal.DestinationUnhealthy,
    );
    expect(cloudErrorCode(failure(409, { code: CloudErrorCode.InstanceIdTaken, message: '' }))).toBe(
      'instance-id-taken',
    );
    expect(cloudErrorCode(new Error('x'))).toBeNull();
  });

  it('finds the account-app page of a step-up refusal only on the configured cloud', () => {
    const stepUp = (url: unknown) =>
      failure(403, { code: CloudErrorCode.StepUpRequired, message: 'confirm', data: { url } });
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp('https://account.frameleaf.cloud/wallet'))).toBe(
      'https://account.frameleaf.cloud/wallet',
    );
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp('https://account.attacker.example/wallet'))).toBeNull();
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp('javascript:alert(1)'))).toBeNull();
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp(7))).toBeNull();
    expect(
      stepUpUrl(
        'https://api.frameleaf.cloud',
        failure(403, { code: 'consent-missing', message: '', data: { url: 'https://account.frameleaf.cloud' } }),
      ),
    ).toBeNull();
  });
});

describe('gateway amounts and usage (FL-177, as-built decisions #21, #22 and #24)', () => {
  it('reads *Usd fields as decimal dollars, to whole micro-USD', () => {
    const wallet = walletResponseSchema.parse({
      balanceUsd: 12.345678,
      heldUsd: 0.1 + 0.2,
      dailyCapUsd: 20,
      spentTodayUsd: 1.0000004,
      topUpUrl: 'https://account.frameleaf.cloud/wallet/top-up',
      settingsUrl: 'https://account.frameleaf.cloud/wallet',
    });
    expect(wallet).toMatchObject({
      balanceUsd: 12.345678,
      heldUsd: 0.3,
      dailyCapUsd: 20,
      spentTodayUsd: 1,
      settingsUrl: 'https://account.frameleaf.cloud/wallet',
    });
    // an address that is not https is dropped on its own, never failing the wallet
    expect(walletResponseSchema.parse({ balanceUsd: 1, settingsUrl: 'http://x.test' }).settingsUrl).toBeNull();
    expect(walletResponseSchema.parse({ balanceUsd: 1 }).settingsUrl).toBeNull();
  });

  it('reads usage items with modelSku and computeSku, never a model id', () => {
    const usage = usageSchema.parse({
      items: [
        {
          jobId: 'job-1',
          clientRef: 'ref-1',
          settledUsd: 2.21,
          credits: null,
          settledAt: '2026-09-25T08:00:00.000Z',
          modelSku: 'ms_01J8ZK3M4N5P6Q7R',
          computeSku: 'cs_01J8ZK3M4N5P6Q7R',
          gpuSeconds: 540,
          workers: 5,
          estimateUsd: 2.26,
          modelId: 'realbasicvsr@1',
        },
      ],
    });
    expect(usage.items[0]).toMatchObject({ modelSku: 'ms_01J8ZK3M4N5P6Q7R', computeSku: 'cs_01J8ZK3M4N5P6Q7R' });
    expect(usage.items[0]).not.toHaveProperty('modelId');
  });
});
