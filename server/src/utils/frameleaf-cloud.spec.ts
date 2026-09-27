import { describe, expect, it } from 'vitest';
import { MlAdmissionRefusal, MlWorkload } from 'src/enum.js';
import { hardwareSchema } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import {
  CLOUD_MODEL_GROUPS,
  CLOUD_UPLOAD_PART_BYTES,
  CLOUD_WORKLOAD_IDS,
  CONSENT_VERSION_PATTERN,
  CloudErrorCode,
  FrameleafCloudError,
  type FrameleafDiscoveryDocument,
  accountServerUrl,
  accountStoreUrl,
  appWorkloadsForCloudId,
  capabilitiesSchema,
  catalogDefaults,
  catalogEntrySchema,
  catalogGroupKey,
  catalogSchema,
  cloudAddressProblem,
  cloudDefaultGroupFor,
  cloudDomainOf,
  cloudErrorCode,
  cloudFactsFromCapabilities,
  cloudModelFor,
  cloudModelGroupFor,
  cloudRequestBody,
  cloudWorkloadIdFor,
  compareConsentVersions,
  consentCurrentQuery,
  consentCurrentSchema,
  consentRecordRequestSchema,
  consentRecordedSchema,
  descriptionsResultSchema,
  discoveryProblem,
  discoverySchema,
  errorEnvelopeSchema,
  estimateRequestSchema,
  estimateResponseSchema,
  estimateUsable,
  isEntitled,
  isFinalCloudJobStatus,
  isGatewayCloneSuspected,
  isLocalOnlyModel,
  isNewWorkPaused,
  jobAdmittedSchema,
  jobCreateRequestSchema,
  jobResultSchema,
  jobRunSchema,
  jobStatusSchema,
  jobViewSchema,
  knownWorkloads,
  offeredCatalogModels,
  pausedException,
  pausedMessageOf,
  refusalFromCloudError,
  stepUpUrl,
  storeAddress,
  studioAiCloudWorkloadId,
  uploadTargetSchema,
  uploadTargetsResponseSchema,
  usageItemSchema,
  usageSchema,
  walletResponseSchema,
  workloadForCatalogEntry,
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
        // FL-165: the direct domain remote access names live under, as the cloud publishes it
        expect(document.remote).toEqual(cloudContractFixture(name).remote);
        // FC-19 final (383f815): the account site's store, a sibling too (as-built decision #29)
        expect(storeAddress('https://api.frameleaf.cloud', document.store)).toBe('https://frameleaf.cloud/store');
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
      // frameleaf-cloud#57: the account app and store are served at the cloud domain's apex
      expect(
        cloudAddressProblem('https://api.frameleaf.cloud', 'account link', 'https://frameleaf.cloud/wallet'),
      ).toBeNull();
    });

    it('drops a store address that is not a URL without failing discovery', () => {
      const document = discoverySchema.parse({ ...production, store: 'not a url' });
      expect(document.store).toBeUndefined();
      expect(storeAddress('https://api.frameleaf.cloud', undefined)).toBeNull();
      expect(storeAddress('https://api.frameleaf.cloud', 'http://frameleaf.cloud/store')).toBeNull();
    });

    it('reads the published link-code switch and redeem address from the golden discovery documents (CLD-004)', () => {
      for (const name of ['instance/discovery.json', 'instance/discovery-instance.json']) {
        const document = discoverySchema.parse(cloudContractFixture(name));
        expect(document.features?.licenseLinkCode).toBe(true);
        expect(document.endpoints?.licenseLinkCode).toBe('https://api.frameleaf.cloud/v1/licenses/redeem-link-code');
        expect(discoveryProblem('https://api.frameleaf.cloud', document)).toBeNull();
      }
    });

    it('reads the licence link-code switch, off when absent or malformed, and accepts new endpoint names (CLD-004)', () => {
      expect(discoverySchema.parse(production).features?.licenseLinkCode).toBeUndefined();
      const on = discoverySchema.parse({
        ...production,
        features: { licenseLinkCode: true, somethingNew: 1 },
        endpoints: { licenseLinkCode: 'https://api.frameleaf.cloud/v1/licenses/redeem-link-code' },
        somethingElseNew: { a: 1 },
      });
      expect(on.features?.licenseLinkCode).toBe(true);
      expect(on.endpoints?.licenseLinkCode).toBe('https://api.frameleaf.cloud/v1/licenses/redeem-link-code');
      expect(
        discoverySchema.parse({ ...production, features: { licenseLinkCode: 'yes' } }).features?.licenseLinkCode,
      ).toBe(undefined);
      expect(discoverySchema.parse({ ...production, features: 'on' }).features).toBeUndefined();
    });

    describe('account site links (the store and a server page)', () => {
      it('takes the origin from the store discovery names', () => {
        const store = 'https://frameleaf.cloud/store';
        expect(accountStoreUrl('https://api.frameleaf.cloud', store)).toBe('https://frameleaf.cloud/store');
        expect(accountServerUrl('https://api.frameleaf.cloud', store, 'inst-1')).toBe(
          'https://frameleaf.cloud/servers/inst-1',
        );
        expect(accountServerUrl('https://api.frameleaf.cloud', 'https://account.frameleaf.cloud/en/store', 'a b')).toBe(
          'https://account.frameleaf.cloud/servers/a%20b',
        );
      });

      it('never points at the API host: without discovery the cloud domain apex serves the account site', () => {
        expect(accountStoreUrl('https://api.frameleaf.cloud', null)).toBe('https://frameleaf.cloud/store');
        expect(accountServerUrl('https://api.frameleaf.cloud', undefined, 'inst-1')).toBe(
          'https://frameleaf.cloud/servers/inst-1',
        );
        // a store address discovery names that fails the address rule is ignored the same way
        expect(accountStoreUrl('https://api.frameleaf.cloud', 'https://attacker.example/store')).toBe(
          'https://frameleaf.cloud/store',
        );
      });

      it('uses the configured address itself for a development cloud without a cloud domain', () => {
        expect(accountStoreUrl('http://127.0.0.1:3100', null)).toBe('http://127.0.0.1:3100/store');
        expect(accountServerUrl('http://127.0.0.1:3100', null, 'inst-1')).toBe('http://127.0.0.1:3100/servers/inst-1');
      });
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
    ['errors/key-retired.json', 401, CloudErrorCode.KeyRetired, MlAdmissionRefusal.CloudUnavailable, null],
    ['errors/nonce-invalid.json', 400, CloudErrorCode.NonceInvalid, MlAdmissionRefusal.CloudUnavailable, null],
    ['errors/rotation-rate-limited.json', 429, 'rate-limited', MlAdmissionRefusal.QuotaExceeded, null],
    // FL-184 (FC-66, FC-22 final fixtures): a bad DPoP proof answered by the token endpoint or an API
    // call, mapped like every other 401 that is not key_retired or entitlement-missing. The golden
    // envelope names why the proof was refused (`detail: replayed`).
    ['errors/invalid-dpop-proof.json', 401, 'invalid_dpop_proof', MlAdmissionRefusal.DestinationUnhealthy, 'replayed'],
  ])('reads the golden %s envelope (FC-19)', (name, status, code, refusal, detail) => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture(name));
    expect(envelope).toMatchObject({ code, refusal: null, detail, data: null, requestId: expect.any(String) });
    expect(envelope.message).not.toBe('');
    expect(refusalFromCloudError(status, envelope)).toBe(refusal);
  });

  it('reads the golden invalid-dpop-proof envelope’s detail (FL-184, FL-178)', () => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture('errors/invalid-dpop-proof.json'));
    expect(envelope).toMatchObject({ code: 'invalid_dpop_proof', retryable: false, detail: 'replayed' });
  });

  it.each([
    ['errors/estimate-mismatch.json', 409, MlAdmissionRefusal.ModelMismatch],
    ['errors/request-invalid.json', 422, MlAdmissionRefusal.RequestInvalid],
  ])('takes the golden %s envelope’s explicit refusal over the status (FL-184, FC-66)', (name, status, refusal) => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture(name));
    expect(envelope.refusal).toBe(refusal);
    expect(refusalFromCloudError(status, envelope)).toBe(refusal);
  });

  // FL-183 (FC-34): the gateway's refusals, with and without their explicit `refusal`, so the status
  // and code alone map the same way; none of them ever picks another destination.
  it.each([
    ['errors/capacity.json', 503, CloudErrorCode.Capacity, MlAdmissionRefusal.DestinationUnhealthy],
    ['errors/consent-missing.json', 403, CloudErrorCode.ConsentMissing, MlAdmissionRefusal.ConsentMissing],
    [
      'errors/consent-version-outdated.json',
      403,
      CloudErrorCode.ConsentVersionOutdated,
      MlAdmissionRefusal.ConsentVersionOutdated,
    ],
    ['errors/daily-cap.json', 402, CloudErrorCode.DailyCap, MlAdmissionRefusal.BudgetExceeded],
    ['errors/entitlement-missing.json', 403, CloudErrorCode.EntitlementMissing, MlAdmissionRefusal.EntitlementMissing],
    ['errors/estimate-used.json', 409, CloudErrorCode.EstimateMismatch, MlAdmissionRefusal.ModelMismatch],
    ['errors/ml-rate-limited.json', 429, 'rate-limited', MlAdmissionRefusal.QuotaExceeded],
    ['errors/region-mismatch.json', 403, CloudErrorCode.RegionMismatch, MlAdmissionRefusal.DestinationUnhealthy],
  ])('maps the golden %s gateway refusal (FL-183, FC-34)', (name, status, code, refusal) => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture(name));
    expect(envelope).toMatchObject({ code, refusal, requestId: expect.any(String) });
    expect(refusalFromCloudError(status, envelope)).toBe(refusal);
    expect(refusalFromCloudError(status, { ...envelope, refusal: null })).toBe(refusal);
  });

  it('carries the version now required on a consent-version-outdated refusal, and marks capacity retryable', () => {
    const outdated = errorEnvelopeSchema.parse(cloudContractFixture('errors/consent-version-outdated.json'));
    expect(outdated.data).toEqual({ requiredVersion: '2026-09-26.1' });
    expect(errorEnvelopeSchema.parse(cloudContractFixture('errors/estimate-used.json')).detail).toBe('used');
    expect(errorEnvelopeSchema.parse(cloudContractFixture('errors/capacity.json')).retryable).toBe(true);
  });

  it('maps an estimate that expired to a model mismatch, and any other 503 to the cloud being unavailable', () => {
    expect(failure(409, { code: CloudErrorCode.EstimateExpired, message: '' }).refusal).toBe(
      MlAdmissionRefusal.ModelMismatch,
    );
    expect(failure(503, { code: 'maintenance', message: '' }).refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
  });

  it('maps a gateway clone_suspected to the cloud being unavailable, whatever refusal it names (FL-183, FL-185)', () => {
    for (const refusal of [undefined, 'destination-unhealthy']) {
      const error = failure(403, { code: CloudErrorCode.CloneSuspected, message: 'copy', refusal });
      expect(error.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
      expect(isGatewayCloneSuspected(error)).toBe(true);
    }
    // region-mismatch and capacity keep their own mapping
    expect(failure(403, { code: CloudErrorCode.RegionMismatch, message: '' }).refusal).toBe(
      MlAdmissionRefusal.DestinationUnhealthy,
    );
    expect(failure(503, { code: CloudErrorCode.Capacity, message: '' }).refusal).toBe(
      MlAdmissionRefusal.DestinationUnhealthy,
    );
    // the token endpoint's refusal is an OAuth 400, handled by the gateway resolution (FL-185)
    expect(isGatewayCloneSuspected(failure(400, { code: CloudErrorCode.CloneSuspected, message: '' }))).toBe(false);
    expect(isGatewayCloneSuspected(new Error('clone_suspected'))).toBe(false);
  });

  // FL-184: licence-domain envelopes (FC-22) carry no `refusal` — the licence service reads their
  // `code` and `message` directly (see frameleaf-license.service.ts `activateWithCloud`), rather than
  // going through the ML admission map these other envelopes exercise.
  it.each([
    [
      'errors/license-not-found.json',
      'license_not_found',
      "We couldn't find that licence key. Check it and try again.",
    ],
    [
      'errors/activation-limit.json',
      'activation_limit',
      'This key is already active on another server. Deactivate it there or in your Frameleaf account, then try again.',
    ],
    ['errors/activation-rate-limited.json', 'rate-limited', 'Too many activation attempts. Try again later.'],
  ])('reads the golden %s licence envelope (FL-184, FC-22)', (name, code, message) => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture(name));
    expect(envelope).toMatchObject({ code, message, refusal: null, requestId: expect.any(String) });
  });

  it('carries the activation-limit envelope’s data object untouched (FL-184)', () => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture('errors/activation-limit.json'));
    expect(envelope.data).toMatchObject({
      activationId: expect.any(String),
      instanceName: 'Basement NAS',
      activatedAt: expect.any(String),
    });
    expect(envelope.retryable).toBe(false);
  });

  it('marks the golden activation-rate-limited envelope retryable (FL-184)', () => {
    const envelope = errorEnvelopeSchema.parse(cloudContractFixture('errors/activation-rate-limited.json'));
    expect(envelope.retryable).toBe(true);
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
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp('https://frameleaf.cloud/wallet'))).toBe(
      'https://frameleaf.cloud/wallet',
    );
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp('https://account.attacker.example/wallet'))).toBeNull();
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp('javascript:alert(1)'))).toBeNull();
    expect(stepUpUrl('https://api.frameleaf.cloud', stepUp(7))).toBeNull();
    expect(
      stepUpUrl(
        'https://api.frameleaf.cloud',
        failure(403, { code: 'consent-missing', message: '', data: { url: 'https://frameleaf.cloud' } }),
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
      topUpUrl: 'https://frameleaf.cloud/wallet/top-up',
      settingsUrl: 'https://frameleaf.cloud/wallet',
    });
    expect(wallet).toMatchObject({
      balanceUsd: 12.345678,
      heldUsd: 0.3,
      dailyCapUsd: 20,
      spentTodayUsd: 1,
      settingsUrl: 'https://frameleaf.cloud/wallet',
    });
    // an address that is not https is dropped on its own, never failing the wallet
    expect(walletResponseSchema.parse({ balanceUsd: 1, settingsUrl: 'http://x.test' }).settingsUrl).toBeNull();
    expect(walletResponseSchema.parse({ balanceUsd: 1 }).settingsUrl).toBeNull();
  });

  it('reads the golden usage.json: settled jobs by id, with SKUs only (FL-183)', () => {
    const usage = usageSchema.parse(cloudContractFixture('ml/usage.json'));
    expect(usage.items).toEqual([
      {
        jobId: '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
        clientRef: 'batch-0192f1b0',
        settledUsd: 0.0244,
        credits: null,
        settledAt: '2026-09-26T04:03:00.000Z',
        modelSku: 'ms_K6WT70CS',
        computeSku: 'cs_KGECTVQ0',
        gpuSeconds: 3.4,
        workers: 1,
        estimateUsd: 0.024,
      },
    ]);
  });

  it('refuses the item of the rejected usage-model-id.json, counting it, so no settlement is applied from it', () => {
    expect(usageSchema.parse(cloudContractFixture('ml/rejected/usage-model-id.json'))).toEqual({
      items: [],
      refused: 1,
    });
  });

  it('keeps every good usage item when one among them is refused (FL-183)', () => {
    const [item] = cloudContractFixture<{ items: Record<string, unknown>[] }>('ml/usage.json').items;
    const [leaky] = cloudContractFixture<{ items: unknown[] }>('ml/rejected/usage-model-id.json').items;
    const later = { ...item, jobId: '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e10' };
    const usage = usageSchema.parse({ items: [item, leaky, later] });
    expect(usage.items.map((entry) => entry.jobId)).toEqual([
      '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
      '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e10',
    ]);
    expect(usage.refused).toBe(1);
  });

  it('refuses a usage item whose SKU is a model or GPU name (FL-183)', () => {
    const [item] = cloudContractFixture<{ items: Record<string, unknown>[] }>('ml/usage.json').items;
    expect(usageItemSchema.safeParse({ ...item, modelSku: 'qwen3.5-9b@1' }).success).toBe(false);
    expect(usageItemSchema.safeParse({ ...item, computeSku: 'gpu48pro' }).success).toBe(false);
    expect(usageItemSchema.safeParse({ ...item, modelSku: null, computeSku: null }).success).toBe(true);
    expect(usageSchema.safeParse({ items: 'not a list' }).success).toBe(false);
  });
});

/**
 * FL-181: the one boundary mapping between the cloud's six wire workload IDs (FC-66) and this
 * server's finer-grained `MlWorkload` values. `restoration` admits both restoration workloads;
 * `transcription` and `tts` both admit Studio AI; every other ID and every app workload not sent to
 * the cloud (face, clip, ocr, pet-recognition, studio-render) map to nothing.
 */
describe('cloud workload ID mapping (FL-181)', () => {
  it('names the six canonical IDs, in the order the cloud documents them', () => {
    expect(CLOUD_WORKLOAD_IDS).toEqual([
      'descriptions',
      'upscale',
      'restoration',
      'transcription',
      'tts',
      'interpolation',
    ]);
  });

  it('admits the app workload(s) a known cloud ID names', () => {
    expect(appWorkloadsForCloudId('descriptions')).toEqual([MlWorkload.Enrichment]);
    expect(appWorkloadsForCloudId('upscale')).toEqual([MlWorkload.Upscale]);
    expect(appWorkloadsForCloudId('restoration')).toEqual([
      MlWorkload.RestorationFaithful,
      MlWorkload.RestorationCreative,
    ]);
    expect(appWorkloadsForCloudId('transcription')).toEqual([MlWorkload.StudioAi]);
    expect(appWorkloadsForCloudId('tts')).toEqual([MlWorkload.StudioAi]);
    expect(appWorkloadsForCloudId('interpolation')).toEqual([MlWorkload.Interpolation]);
  });

  it('admits nothing for an ID it does not know, never guessing', () => {
    for (const unknown of ['face', 'clip', 'ocr', 'pet-recognition', 'studio-render', 'music', 'captioning', '']) {
      expect(appWorkloadsForCloudId(unknown), unknown).toEqual([]);
    }
  });

  it('folds a capabilities `workloads[]` list into the app workloads it admits, dropping unknown IDs and duplicates', () => {
    expect(knownWorkloads(['descriptions', 'restoration', 'transcription', 'tts', 'face', 'teleportation'])).toEqual([
      MlWorkload.Enrichment,
      MlWorkload.RestorationFaithful,
      MlWorkload.RestorationCreative,
      MlWorkload.StudioAi,
    ]);
    expect(knownWorkloads([])).toEqual([]);
  });

  it('sends the cloud ID a job for an app workload belongs under', () => {
    expect(cloudWorkloadIdFor(MlWorkload.Enrichment)).toBe('descriptions');
    expect(cloudWorkloadIdFor(MlWorkload.Upscale)).toBe('upscale');
    expect(cloudWorkloadIdFor(MlWorkload.RestorationFaithful)).toBe('restoration');
    expect(cloudWorkloadIdFor(MlWorkload.RestorationCreative)).toBe('restoration');
    expect(cloudWorkloadIdFor(MlWorkload.Interpolation)).toBe('interpolation');
  });

  it('never names a cloud ID for a workload the cloud never serves this way', () => {
    // Studio AI needs studioAiCloudWorkloadId (one app workload, two cloud IDs); the rest are never sent at all.
    for (const workload of [
      MlWorkload.StudioAi,
      MlWorkload.Face,
      MlWorkload.Clip,
      MlWorkload.Ocr,
      MlWorkload.PetRecognition,
      MlWorkload.StudioRender,
    ]) {
      expect(cloudWorkloadIdFor(workload), workload).toBeNull();
    }
  });

  it('picks transcription for speech-to-text and captions, tts for speech; music is never mapped here', () => {
    expect(studioAiCloudWorkloadId('speech-to-text')).toBe('transcription');
    expect(studioAiCloudWorkloadId('captions')).toBe('transcription');
    expect(studioAiCloudWorkloadId('speech')).toBe('tts');
  });

  it('assigns a restoration catalog entry to the app workload its own mode names', () => {
    expect(workloadForCatalogEntry('restoration', 'faithful')).toBe(MlWorkload.RestorationFaithful);
    expect(workloadForCatalogEntry('restoration', 'creative')).toBe(MlWorkload.RestorationCreative);
    // The cloud never publishes a restoration model without a mode (FL-181); a null one is still
    // left unassigned rather than guessed, since this server never over-admits a restoration mode.
    expect(workloadForCatalogEntry('restoration', null)).toBeNull();
  });

  it('assigns every other catalog entry from its cloud ID alone, mode ignored', () => {
    expect(workloadForCatalogEntry('descriptions', null)).toBe(MlWorkload.Enrichment);
    expect(workloadForCatalogEntry('upscale', null)).toBe(MlWorkload.Upscale);
    expect(workloadForCatalogEntry('interpolation', null)).toBe(MlWorkload.Interpolation);
    expect(workloadForCatalogEntry('transcription', null)).toBe(MlWorkload.StudioAi);
    expect(workloadForCatalogEntry('unknown-future-workload', null)).toBeNull();
  });
});

/**
 * FL-181, FL-183: the cloud's own `ml/` and `ml/rejected/` fixtures (FC-34, Frameleaf/frameleaf-cloud#29
 * at `89fb079f2a2dd7f82bd01c15b7609e2068cd09d6`; see `test/fixtures/frameleaf-cloud-contracts/SOURCE.md`)
 * drive these specs: every gateway answer this server reads parses with its production schema, every
 * body it sends passes the contract check it is sent through, and every rejected fixture is refused.
 */
describe('Frameleaf Cloud ml contract fixtures (FC-34, FL-181, FL-183)', () => {
  const REJECTED_CATALOG_ENTRIES = [
    'catalog-entry-gpu-class.json',
    'catalog-entry-mode-on-descriptions.json',
    'catalog-entry-model-id.json',
    'catalog-entry-name-as-compute-sku.json',
    'catalog-entry-name-as-rev.json',
    'catalog-entry-non-commercial-licence.json',
    'catalog-entry-restoration-without-mode.json',
  ];
  const REJECTED_ESTIMATES = [
    'estimate-display-as-input.json',
    'estimate-gpu-class.json',
    'estimate-model-id.json',
    'estimate-name-as-sku.json',
    'estimate-unknown-request-key.json',
  ];
  const REJECTED_JOBS = ['job-model-fingerprint.json', 'job-model-id.json'];

  /** The refusal `cloudRequestBody` throws for `body`, or null when it would send it. */
  const sendRefusal = (schema: Parameters<typeof cloudRequestBody>[0], body: unknown) => {
    try {
      cloudRequestBody(schema, body, 'the body');
      return null;
    } catch (error) {
      return error instanceof FrameleafCloudError ? error.refusal : error;
    }
  };

  describe('capabilities, hardware and wallet', () => {
    it('reads capabilities.json: the workloads that can run now, consent, entitlement, wallet and limits', () => {
      const capabilities = capabilitiesSchema.parse(cloudContractFixture('ml/capabilities.json'));
      expect(capabilities).toEqual({
        protocol: 'frameleaf-cloud-v2',
        region: 'eu',
        workloads: ['descriptions', 'restoration'],
        consent: {
          requiredVersion: '2026-09-26.1',
          recordedVersion: '2026-09-26.1',
          features: { identityNames: false, medicalSignals: false, ocrAddon: false },
        },
        entitlement: { active: true, state: 'active', graceUntil: null },
        wallet: { balanceUsd: 10, heldUsd: 0.203251, dailyCapUsd: 20, spentTodayUsd: 0 },
        limits: { maxInputBytes: 2_147_483_648, maxInputs: 1000, concurrentTimePriced: 2 },
        catalogEtag: '"cat-eu-3f9c2a71b0d4e58c"',
      });
      expect(knownWorkloads(capabilities.workloads)).toEqual([
        MlWorkload.Enrichment,
        MlWorkload.RestorationFaithful,
        MlWorkload.RestorationCreative,
      ]);
      expect(isEntitled(capabilities.entitlement)).toBe(true);
    });

    it('reads capabilities-not-ready.json: in grace is still entitled, and an older recorded consent is outdated', () => {
      const capabilities = capabilitiesSchema.parse(cloudContractFixture('ml/capabilities-not-ready.json'));
      expect(capabilities.workloads).toEqual([]);
      expect(capabilities.entitlement).toEqual({
        active: true,
        state: 'grace',
        graceUntil: '2026-10-03T00:00:00.000Z',
      });
      expect(isEntitled(capabilities.entitlement)).toBe(true);
      expect(capabilities.consent.recordedVersion).not.toBe(capabilities.consent.requiredVersion);
      expect(capabilities.consent.features).toEqual({ identityNames: true, medicalSignals: false, ocrAddon: false });
      expect(cloudFactsFromCapabilities(capabilities, [])).toMatchObject({
        entitled: true,
        consentRequiredVersion: '2026-09-26.1',
        consentRecordedVersion: '2026-01-15.1',
        balanceUsd: 4.5,
        spentTodayUsd: 1.25,
      });
    });

    it('reads `active` alone: an expired entitlement is not entitled, and the old flag shape is refused', () => {
      const capabilities = cloudContractFixture<Record<string, unknown>>('ml/capabilities.json');
      const expired = capabilitiesSchema.parse({
        ...capabilities,
        entitlement: { active: false, state: 'expired', graceUntil: null },
      });
      expect(isEntitled(expired.entitlement)).toBe(false);
      expect(capabilitiesSchema.safeParse({ ...capabilities, entitlement: true }).success).toBe(false);
      expect(capabilitiesSchema.safeParse({ ...capabilities, entitlement: { active: true } }).success).toBe(false);
    });

    it('reads hardware.json, the synthetic CUDA descriptor', () => {
      expect(hardwareSchema.parse(cloudContractFixture('ml/hardware.json'))).toEqual({
        providers: ['CUDAExecutionProvider'],
        cudaDeviceCount: 1,
        preferredAcceleration: 'cuda',
      });
    });

    it('reads wallet.json with its account-app settings page', () => {
      expect(walletResponseSchema.parse(cloudContractFixture('ml/wallet.json'))).toEqual({
        balanceUsd: 10,
        heldUsd: 0.203251,
        dailyCapUsd: 20,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
        settingsUrl: 'https://frameleaf.cloud/wallet',
      });
    });
  });

  describe('catalogue', () => {
    it('reads every entry of catalog.json field for field, by SKU and revision', () => {
      const catalog = catalogSchema.parse(cloudContractFixture('ml/catalog.json'));
      expect(catalog.etag).toBe('"cat-2026-09-26.3"');
      expect(catalog.refused).toBe(0);
      expect(catalog.models.map((model) => [model.sku, model.rev, model.workload, model.mode])).toEqual([
        ['ms_K6WT70CS', 'mr_B2H147RBJBQ0', 'descriptions', null],
        ['ms_M7QG26PT', 'mr_68JDMAM8444M', 'descriptions', null],
        ['ms_54S55W7C', 'mr_0WNPDD697MT0', 'upscale', null],
      ]);
      expect(catalog.models[1]).toEqual({
        sku: 'ms_M7QG26PT',
        workload: 'descriptions',
        rank: 5,
        label: 'Descriptions · Best (fallback)',
        display: { model: 'Qwen2.5-VL-72B AWQ', gpu: 'H200-class, 141 GB' },
        computeSku: 'cs_7WF1N0N6',
        rate: { perSecondUsd: 0.004583, startFeeUsd: 0.1 },
        eta: { p50Sec: 120, p90Sec: 210 },
        limits: { maxInputs: 1000, maxInputBytes: 52_428_800 },
        rev: 'mr_68JDMAM8444M',
        notice: 'Built with Qwen',
        mode: null,
        licence: null,
        default: false,
      });
      for (const model of catalog.models) {
        expect(workloadForCatalogEntry(model.workload, model.mode), model.sku).not.toBeNull();
      }
    });

    it('reads catalog-restoration.json: one faithful and one creative model, each with its licence', () => {
      const catalog = catalogSchema.parse(cloudContractFixture('ml/catalog-restoration.json'));
      expect(catalog.refused).toBe(0);
      expect(
        catalog.models.map((model) => [
          model.sku,
          model.mode,
          workloadForCatalogEntry(model.workload, model.mode),
          model.licence,
        ]),
      ).toEqual([
        ['ms_YS60DAXB', 'faithful', MlWorkload.RestorationFaithful, { name: 'Apache-2.0', commercialHosted: 'yes' }],
        ['ms_F1SSRED6', 'creative', MlWorkload.RestorationCreative, { name: 'Apache-2.0', commercialHosted: 'yes' }],
      ]);
    });

    it.each(REJECTED_CATALOG_ENTRIES)('refuses the rejected %s entry', (name) => {
      const entry = cloudContractFixture<{ workload: string }>(`ml/rejected/${name}`);
      expect(catalogEntrySchema.safeParse(entry).success).toBe(false);
      // refused for leaking an identifier, its mode or its licence, never for its workload ID
      expect(appWorkloadsForCloudId(entry.workload)).not.toEqual([]);
    });

    it('leaves every rejected entry out of a catalogue and keeps the rest, counting what it refused', () => {
      const catalog = cloudContractFixture<{ etag: string; models: unknown[] }>('ml/catalog-restoration.json');
      const rejected = REJECTED_CATALOG_ENTRIES.map((name) => cloudContractFixture<unknown>(`ml/rejected/${name}`));
      const parsed = catalogSchema.parse({ ...catalog, models: [...catalog.models, ...rejected] });
      expect(parsed.models.map((model) => model.sku)).toEqual(['ms_YS60DAXB', 'ms_F1SSRED6']);
      expect(parsed.refused).toBe(REJECTED_CATALOG_ENTRIES.length);
    });

    it('never offers a restoration mode whose only model has a non-commercial licence', () => {
      const catalog = cloudContractFixture<{ etag: string; models: Array<{ mode: string }> }>(
        'ml/catalog-restoration.json',
      );
      const parsed = catalogSchema.parse({
        ...catalog,
        models: [
          ...catalog.models.filter((model) => model.mode !== 'creative'),
          cloudContractFixture<unknown>('ml/rejected/catalog-entry-non-commercial-licence.json'),
        ],
      });
      expect(parsed.models.map((model) => workloadForCatalogEntry(model.workload, model.mode))).toEqual([
        MlWorkload.RestorationFaithful,
      ]);
    });

    it('accepts an explicit null mode outside restoration and a licence with conditions', () => {
      const [entry] = cloudContractFixture<{ models: Record<string, unknown>[] }>('ml/catalog.json').models;
      expect(catalogEntrySchema.parse({ ...entry, mode: null }).mode).toBeNull();
      const licence = { name: 'Qwen License', commercialHosted: 'conditions' };
      expect(catalogEntrySchema.parse({ ...entry, licence }).licence).toEqual(licence);
    });

    it('refuses markup or control characters in text meant for people', () => {
      const [entry] = cloudContractFixture<{ models: Record<string, unknown>[] }>('ml/catalog.json').models;
      expect(catalogEntrySchema.safeParse({ ...entry, label: '<b>Standard</b>' }).success).toBe(false);
      expect(catalogEntrySchema.safeParse({ ...entry, notice: 'Built with\u{7}Qwen' }).success).toBe(false);
    });

    it('offers no local-only model, even under a SKU, recognised by its display name (FL-146)', () => {
      const catalog = catalogSchema.parse(cloudContractFixture('ml/catalog.json'));
      const [entry] = catalog.models;
      const localOnly = {
        ...entry,
        sku: 'ms_ZZZZZZZZ',
        display: { ...entry.display, model: 'Qwen2.5-VL-3B-Instruct' },
      };
      expect(offeredCatalogModels({ models: [...catalog.models, localOnly] }).map((model) => model.sku)).toEqual([
        'ms_K6WT70CS',
        'ms_M7QG26PT',
        'ms_54S55W7C',
      ]);
      expect(offeredCatalogModels(null)).toEqual([]);
    });

    it('recognises a local-only model whatever spaces or punctuation its name carries', () => {
      for (const name of [
        'Qwen2.5 VL 3B',
        'Qwen 2.5-VL 3B Instruct',
        'qwen2_5_vl_3b',
        'Qwen/Qwen2.5-VL-3B-Instruct',
        'llmware/qwen2.5-vl-3b-ov',
        'NLLB CLIP base',
        'nllb-clip-large-siglip__v1',
        'MusicGen Small',
        'Xenova/musicgen-small',
      ]) {
        expect(isLocalOnlyModel(name), name).toBe(true);
      }
      for (const name of [
        'Qwen2.5-VL-72B AWQ',
        'Qwen2.5-VL-32B',
        'Qwen3.5-9B',
        'SeedVR2-3B',
        'ms_K6WT70CS',
        '',
        null,
      ]) {
        expect(isLocalOnlyModel(name), String(name)).toBe(false);
      }
    });

    /**
     * FC-34 (cloud decision 2026-09-26): a catalogue entry may carry `default: true`, at most one per
     * group (workload; for restoration, workload and mode). The cloud's fixtures for this
     * (catalog-descriptions.json, rejected/catalog-two-defaults.json, the updated
     * catalog-restoration.json) are copied from origin/main, so these specs build their catalogues
     * from them directly.
     */
    describe('defaults', () => {
      const catalogModels = cloudContractFixture<{ models: Record<string, unknown>[] }>('ml/catalog.json').models;
      const [light, standard] = cloudContractFixture<{ models: Record<string, unknown>[] }>(
        'ml/catalog-descriptions.json',
      ).models;
      const [faithful, creative] = cloudContractFixture<{ models: Record<string, unknown>[] }>(
        'ml/catalog-restoration.json',
      ).models;
      const twoDefaults = cloudContractFixture<{ models: Record<string, unknown>[] }>(
        'ml/rejected/catalog-two-defaults.json',
      ).models;
      const upscale = catalogModels[2];
      const parse = (models: unknown[]) => catalogSchema.parse({ etag: '"cat-test"', models });

      it('reads one default per group, with restoration grouped by mode', () => {
        const catalog = parse([light, standard, { ...upscale, default: false }, faithful, creative]);
        expect(catalog.refused).toBe(0);
        expect(catalog.models.map((model) => model.default)).toEqual([false, true, false, true, true]);
        expect(catalogDefaults(catalog.models)).toEqual({
          descriptions: 'ms_K6WT70CS',
          'restoration-faithful': 'ms_YS60DAXB',
          'restoration-creative': 'ms_F1SSRED6',
        });
      });

      it('names no default for a group the cloud marks none in (not available to this region or licence)', () => {
        const catalog = parse([light, { ...standard, default: false }, faithful, { ...creative, default: false }]);
        expect(catalogDefaults(catalog.models)).toEqual({ 'restoration-faithful': 'ms_YS60DAXB' });
      });

      it('refuses two defaults in one group: the group keeps its models, has no default, and counts once', () => {
        const catalog = parse([
          ...twoDefaults,
          { ...upscale, default: true },
          creative,
          { ...creative, sku: 'ms_CRE8TVE2', rev: 'mr_CRE8TVE2CRE8' },
          faithful,
        ]);
        expect(catalog.refused).toBe(2);
        expect(catalog.models).toHaveLength(6);
        expect(catalogDefaults(catalog.models)).toEqual({
          upscale: 'ms_54S55W7C',
          'restoration-faithful': 'ms_YS60DAXB',
        });
      });

      it('never counts a refused entry toward a default, nor a default that is not a boolean', () => {
        const leaky = cloudContractFixture<Record<string, unknown>>('ml/rejected/catalog-entry-model-id.json');
        const catalog = parse([standard, { ...leaky, default: true }]);
        expect(catalog.refused).toBe(1);
        expect(catalogDefaults(catalog.models)).toEqual({ descriptions: 'ms_K6WT70CS' });
        expect(catalogEntrySchema.safeParse({ ...standard, default: 'yes' }).success).toBe(false);
      });

      it('never names a local-only model as a default', () => {
        const catalog = parse([{ ...standard, display: { model: 'Qwen2.5 VL 3B', gpu: 'Any' } }]);
        expect(catalogDefaults(offeredCatalogModels(catalog))).toEqual({});
      });

      it('takes a workload default from its own group only', () => {
        const facts = {
          defaultModels: { descriptions: 'ms_K6WT70CS', 'restoration-faithful': 'ms_YS60DAXB', tts: 'ms_TTS00000' },
        };
        expect(cloudDefaultGroupFor(MlWorkload.Enrichment)).toBe('descriptions');
        expect(cloudDefaultGroupFor(MlWorkload.RestorationCreative)).toBe('restoration-creative');
        expect(cloudDefaultGroupFor(MlWorkload.StudioAi)).toBeNull();
        expect(cloudDefaultGroupFor(MlWorkload.Face)).toBeNull();
        expect(cloudModelFor(MlWorkload.Enrichment, null, facts)).toBe('ms_K6WT70CS');
        expect(cloudModelFor(MlWorkload.RestorationFaithful, undefined, facts)).toBe('ms_YS60DAXB');
        expect(cloudModelFor(MlWorkload.RestorationCreative, null, facts)).toBeNull();
        expect(cloudModelFor(MlWorkload.StudioAi, null, facts)).toBeNull();
        expect(cloudModelFor(MlWorkload.Upscale, 'ms_54S55W7C', facts)).toBe('ms_54S55W7C');
        expect(cloudModelFor(MlWorkload.Enrichment, null, {})).toBeNull();
      });

      it('reads a chosen model per model group, Studio AI per feature (FL-186)', () => {
        expect(CLOUD_MODEL_GROUPS).toEqual([
          'descriptions',
          'upscale',
          'restoration-faithful',
          'restoration-creative',
          'interpolation',
          'transcription',
          'tts',
        ]);
        expect(catalogGroupKey('restoration', 'creative')).toBe('restoration-creative');
        expect(catalogGroupKey('tts', null)).toBe('tts');
        expect(cloudModelGroupFor(MlWorkload.Enrichment)).toBe('descriptions');
        expect(cloudModelGroupFor(MlWorkload.RestorationFaithful)).toBe('restoration-faithful');
        expect(cloudModelGroupFor(MlWorkload.StudioAi, 'speech-to-text')).toBe('transcription');
        expect(cloudModelGroupFor(MlWorkload.StudioAi, 'captions')).toBe('transcription');
        expect(cloudModelGroupFor(MlWorkload.StudioAi, 'speech')).toBe('tts');
        // a Studio AI job that names no feature has no model to send
        expect(cloudModelGroupFor(MlWorkload.StudioAi)).toBeNull();
        expect(cloudModelGroupFor(MlWorkload.Face)).toBeNull();
      });
    });
  });

  describe('consent', () => {
    it('reads consent-current.json: the required version, nothing recorded, the text digest', () => {
      const consent = consentCurrentSchema.parse(cloudContractFixture('ml/consent-current.json'));
      expect(consent).toMatchObject({
        requiredVersion: '2026-09-26.1',
        recordedVersion: null,
        recordedAt: null,
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
        textSha256: '9de54bf78bb10336c2198853a96988d2b390becbead134ce5ee3cdb3a30c3655',
        documentUrl: null,
      });
      expect(consent.summary).toMatch(/^Frameleaf Cloud processes/);
      expect(consent.requiredVersion).toMatch(CONSENT_VERSION_PATTERN);
    });

    it('sends consent-record-request.json as it is, and reads consent-recorded.json', () => {
      const request = cloudContractFixture<unknown>('ml/consent-record-request.json');
      expect(cloudRequestBody(consentRecordRequestSchema, request, 'the consent')).toEqual(request);
      expect(consentRecordedSchema.parse(cloudContractFixture('ml/consent-recorded.json'))).toEqual({
        recordedVersion: '2026-09-26.1',
        recordedAt: '2026-09-26T04:00:00.000Z',
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      });
    });

    it.each(['consent-record-email.json', 'consent-record-ocr-addon.json'])(
      'never sends the rejected %s body',
      (name) => {
        const body = cloudContractFixture<unknown>(`ml/rejected/${name}`);
        expect(sendRefusal(consentRecordRequestSchema, body)).toBe(MlAdmissionRefusal.RequestInvalid);
      },
    );

    it('never sends a consent version that is not a disclosure version', () => {
      const request = cloudContractFixture<Record<string, unknown>>('ml/consent-record-request.json');
      expect(sendRefusal(consentRecordRequestSchema, { ...request, version: '2026-09-26' })).toBe(
        MlAdmissionRefusal.RequestInvalid,
      );
    });
  });

  describe('estimates and jobs', () => {
    it('sends estimate-request.json as it is, and reads the sealed estimate-response.json', () => {
      const request = cloudContractFixture<unknown>('ml/estimate-request.json');
      expect(cloudRequestBody(estimateRequestSchema, request, 'the estimate request')).toEqual(request);
      const estimate = estimateResponseSchema.parse(cloudContractFixture('ml/estimate-response.json'));
      expect(estimate).toMatchObject({
        expiresAt: '2026-09-26T04:15:00.000Z',
        modelSku: 'ms_K6WT70CS',
        modelRev: 'mr_B2H147RBJBQ0',
        computeSku: 'cs_KGECTVQ0',
        cost: { p50: 0.021, p90: 0.024, startup: 0.02, hold: 0.05, minimum: 0.02 },
        seconds: { coldStart: 18, run: 1.1 },
        basis: 'measured',
      });
      expect(estimate.estimate).toMatch(/^est1\./);
      expect(estimateUsable(estimate, Date.parse('2026-09-26T04:14:59.000Z'))).toBe(true);
      expect(estimateUsable(estimate, Date.parse('2026-09-26T04:15:00.000Z'))).toBe(false);
    });

    it.each(REJECTED_ESTIMATES)('never sends the rejected %s estimate request', (name) => {
      const body = cloudContractFixture<{ workload: string }>(`ml/rejected/${name}`);
      expect(sendRefusal(estimateRequestSchema, body)).toBe(MlAdmissionRefusal.RequestInvalid);
      // refused for what it leaks or adds, never for its workload ID
      expect(appWorkloadsForCloudId(body.workload)).not.toEqual([]);
    });

    it('binds a job to its estimate: job-request.json is estimate-request.json plus the sealed estimate', () => {
      const estimateRequest = cloudContractFixture<Record<string, unknown>>('ml/estimate-request.json');
      const estimate = estimateResponseSchema.parse(cloudContractFixture('ml/estimate-response.json'));
      const job = cloudContractFixture<Record<string, unknown>>('ml/job-request.json');
      expect(cloudRequestBody(jobCreateRequestSchema, job, 'the job')).toEqual(job);
      expect(job).toMatchObject({
        ...estimateRequest,
        estimate: estimate.estimate,
        modelSku: estimate.modelSku,
        modelRev: estimate.modelRev,
      });
    });

    it.each(REJECTED_JOBS)('never sends the rejected %s job', (name) => {
      const body = cloudContractFixture<{ workload: string }>(`ml/rejected/${name}`);
      expect(sendRefusal(jobCreateRequestSchema, body)).toBe(MlAdmissionRefusal.RequestInvalid);
      expect(appWorkloadsForCloudId(body.workload)).not.toEqual([]);
    });

    it('keeps each workload to its own request allow-list', () => {
      const job = cloudContractFixture<Record<string, unknown>>('ml/job-request.json');
      const restoration = { ...job, workload: 'restoration', request: { mode: 'creative', scale: 2 } };
      expect(sendRefusal(jobCreateRequestSchema, restoration)).toBeNull();
      expect(sendRefusal(jobCreateRequestSchema, { ...restoration, request: { mode: 'vivid' } })).not.toBeNull();
      expect(sendRefusal(jobCreateRequestSchema, { ...job, request: { scale: 4 } })).not.toBeNull();
      const tts = { ...job, workload: 'tts' };
      expect(
        sendRefusal(jobCreateRequestSchema, { ...tts, request: { voice: 'alloy', text: 'Hello' } }),
      ).not.toBeNull();
      expect(sendRefusal(jobCreateRequestSchema, { ...tts, request: { voice: 'vs_8SWGRA09', text: 'Hi' } })).toBeNull();
      // a workload that is not one of the six canonical IDs, exactly as an unknown capability is
      expect(sendRefusal(jobCreateRequestSchema, { ...job, workload: 'legacy-caption' })).not.toBeNull();
      expect(appWorkloadsForCloudId('legacy-caption')).toEqual([]);
    });

    it('reads job-admitted.json, the answer up to admission', () => {
      expect(jobAdmittedSchema.parse(cloudContractFixture('ml/job-admitted.json'))).toEqual({
        jobId: '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
        status: 'admitted',
        modelSku: 'ms_K6WT70CS',
        modelRev: 'mr_B2H147RBJBQ0',
        computeSku: 'cs_KGECTVQ0',
        hold: { amountUsd: 0.203251, ceilingUsd: 0.223577, minimumUsd: 0.2 },
        createdAt: '2026-09-26T04:01:00.000Z',
      });
    });

    it('reads a job status from job-admitted.json and job-run.json, and refuses worker details', () => {
      const admitted = cloudContractFixture<Record<string, unknown>>('ml/job-admitted.json');
      const run = cloudContractFixture<unknown>('ml/job-run.json');
      expect(jobRunSchema.parse(run)).toEqual({
        startedAt: '2026-09-26T04:01:12.000Z',
        meteredSeconds: 3.4,
        workers: 1,
        startFees: 1,
      });
      expect(jobStatusSchema.parse(admitted)).toMatchObject({ status: 'admitted', modelSku: 'ms_K6WT70CS' });
      expect(jobStatusSchema.parse({ ...admitted, status: 'running', run })).toMatchObject({
        status: 'running',
        run: { meteredSeconds: 3.4 },
      });
      const leaky = cloudContractFixture<unknown>('ml/rejected/job-run-worker-details.json');
      expect(jobRunSchema.safeParse(leaky).success).toBe(false);
      expect(jobStatusSchema.safeParse({ ...admitted, status: 'running', run: leaky }).success).toBe(false);
      expect(jobStatusSchema.safeParse({ ...admitted, modelId: 'qwen3.5-9b@1' }).success).toBe(false);
      expect(jobStatusSchema.safeParse({ ...admitted, status: 'pending_hold' }).success).toBe(false);
    });

    it('links a settled usage item back to the job that created it, by id and client reference', () => {
      const job = cloudContractFixture<{ clientRef: string }>('ml/job-request.json');
      const admitted = jobAdmittedSchema.parse(cloudContractFixture('ml/job-admitted.json'));
      const usage = usageSchema.parse(cloudContractFixture('ml/usage.json'));
      expect(usage.items.map((item) => [item.jobId, item.clientRef])).toContainEqual([admitted.jobId, job.clientRef]);
    });

    it('round-trips the estimate and job workload: the app workload it admits sends the same cloud ID back', () => {
      for (const name of ['ml/estimate-request.json', 'ml/job-request.json']) {
        const body = cloudContractFixture<{ workload: string }>(name);
        const [workload] = appWorkloadsForCloudId(body.workload);
        expect(cloudWorkloadIdFor(workload), name).toBe(body.workload);
      }
    });
  });
});

describe('Frameleaf Cloud job views, storage and cost (FL-162, FC-39, FC-42, FC-43)', () => {
  const REJECTED_JOB_VIEWS = [
    'job-view-cost-above-hold.json',
    'job-view-cost-lines-mismatch.json',
    'job-view-cost-not-charged-total.json',
    'job-view-cost-provider-details.json',
    'job-view-provider-details.json',
    'job-view-unknown-status.json',
  ];
  const REJECTED_STORAGE = [
    'upload-target-both-methods.json',
    'upload-target-inline-too-large.json',
    'upload-target-parts-dont-add-up.json',
  ];

  const JOB_VIEWS = [
    'job-queued.json',
    'job-running.json',
    'job-completed.json',
    'job-failed.json',
    'job-settled-budget.json',
  ];

  it.each(JOB_VIEWS)('reads %s field for field as a job view', (name) => {
    const fixture = cloudContractFixture<Record<string, unknown>>(`ml/${name}`);
    expect(jobViewSchema.parse(fixture)).toEqual(fixture);
  });

  it.each(REJECTED_JOB_VIEWS)('refuses the rejected %s job view', (name) => {
    expect(jobViewSchema.safeParse(cloudContractFixture(`ml/rejected/${name}`)).success).toBe(false);
  });

  it('reads the settled cost of a completed job: charge lines that add up to the total, within the hold', () => {
    const view = jobViewSchema.parse(cloudContractFixture('ml/job-completed.json'));
    expect(view.cost).toMatchObject({ outcome: 'charged', totalUsd: 0.2026, heldUsd: 0.203251, releasedUsd: 0.000651 });
    expect(view.cost?.lines.map((line) => line.kind)).toEqual(['start_fees', 'gpu_time']);
    expect(view.run).toEqual({ startedAt: '2026-09-26T04:02:10.000Z', meteredSeconds: 2, workers: 1, startFees: 1 });
  });

  it('reads a provider failure as nothing charged, with its fixed error code', () => {
    const view = jobViewSchema.parse(cloudContractFixture('ml/job-failed.json'));
    expect(view.status).toBe('failed');
    expect(isFinalCloudJobStatus(view.status)).toBe(true);
    expect(view.cost).toMatchObject({ outcome: 'not_charged', totalUsd: 0, releasedUsd: 0.203251 });
    expect(view.error).toMatchObject({ code: 'worker-unavailable', retryable: true });
  });

  it('reads a job stopped at its hold: charged at most the hold, the rest covered by Frameleaf Cloud', () => {
    const view = jobViewSchema.parse(cloudContractFixture('ml/job-settled-budget.json'));
    expect(view.status).toBe('cancelled_budget');
    expect(view.cost?.totalUsd).toBe(view.cost?.heldUsd);
    expect(view.cost?.lines.find((line) => line.sign === 'credit')).toMatchObject({ kind: 'covered_by_frameleaf' });
    expect(view.error?.code).toBe('budget-exceeded');
  });

  it('keeps waiting on the states that are not final', () => {
    for (const status of ['admitted', 'awaiting_upload', 'queued', 'starting', 'running'] as const) {
      expect(isFinalCloudJobStatus(status), status).toBe(false);
    }
  });

  it('reads the outputs of a completed job with the storage headers every download sends', () => {
    const view = jobViewSchema.parse(cloudContractFixture('ml/storage/job-completed-result.json'));
    expect(view.result?.outputs.map((output) => output.outputId)).toEqual(['a1', 'a2']);
    expect(Object.keys(view.result?.headers ?? {})).toContain('x-amz-server-side-encryption-customer-key');
    const noHeaders = cloudContractFixture<unknown>('ml/storage/rejected/job-result-no-headers.json');
    expect(jobResultSchema.safeParse(noHeaders).success).toBe(false);
  });

  it('reads an input that failed its SHA-256 as a failure that pays at most the minimum', () => {
    const view = jobViewSchema.parse(cloudContractFixture('ml/storage/job-failed-sha256.json'));
    expect(view.error?.code).toBe('input-sha256-mismatch');
  });

  it('reads the upload targets an admission answers with, inline and multipart', () => {
    const admitted = jobAdmittedSchema.parse(cloudContractFixture('ml/storage/job-admitted-uploads.json'));
    expect(admitted.uploads?.map((upload) => upload.method)).toEqual(['inline', 'multipart']);
    const targets = uploadTargetsResponseSchema.parse(cloudContractFixture('ml/storage/upload-targets.json'));
    const multipart = targets.uploads.find((upload) => upload.method === 'multipart');
    expect(multipart?.multipart?.partBytes).toBe(CLOUD_UPLOAD_PART_BYTES);
    expect(multipart?.multipart?.parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(multipart?.bytes);
    expect(uploadTargetSchema.parse(cloudContractFixture('ml/storage/upload-target-refreshed.json'))).toMatchObject({
      inputId: 'a1',
      method: 'inline',
      uploaded: false,
    });
  });

  it.each(REJECTED_STORAGE)('refuses the rejected %s upload target', (name) => {
    expect(uploadTargetSchema.safeParse(cloudContractFixture(`ml/storage/rejected/${name}`)).success).toBe(false);
  });

  it('refuses a job view whose cost lines do not add up, even when every line is well formed', () => {
    const view = cloudContractFixture<{ cost: { totalUsd: number } }>('ml/job-completed.json');
    expect(jobViewSchema.safeParse({ ...view, cost: { ...view.cost, totalUsd: 0.2027 } }).success).toBe(false);
  });
});

/**
 * FL-163: the cloud's FC-44 descriptions fixtures (`ml/descriptions/`): the request options a batch may
 * send, and the result document of each input that a batch writes back per photo.
 */
describe('Frameleaf Cloud descriptions contract (FC-44, FL-163)', () => {
  const REJECTED_REQUESTS = [
    'request-feature-not-boolean.json',
    'request-free-text-style.json',
    'request-max-tags-over.json',
    'request-prompt.json',
    'request-unknown-feature.json',
  ];
  const REJECTED_RESULTS = [
    'result-confidence-above-one.json',
    'result-control-characters.json',
    'result-described-with-failure.json',
    'result-duplicate-inputs.json',
    'result-duplicate-tags.json',
    'result-empty-without-warning.json',
    'result-failed-with-tags.json',
    'result-markup.json',
    'result-model-fingerprint.json',
    'result-model-name.json',
    'result-no-items.json',
    'result-too-long.json',
    'result-too-many-tags.json',
    'result-unknown-warning.json',
  ];

  it('sends the descriptions estimate and job requests, consent features included, as they are', () => {
    for (const [schema, name] of [
      [estimateRequestSchema, 'estimate-request.json'],
      [jobCreateRequestSchema, 'job-request.json'],
      [jobCreateRequestSchema, 'job-request-minimal.json'],
    ] as const) {
      const body = cloudContractFixture<unknown>(`ml/descriptions/${name}`);
      expect(cloudRequestBody(schema, body, name)).toEqual(body);
    }
  });

  it.each(REJECTED_REQUESTS)('never sends the rejected %s descriptions request', (name) => {
    const request = cloudContractFixture<unknown>(`ml/descriptions/rejected/${name}`);
    const body = { ...cloudContractFixture<Record<string, unknown>>('ml/descriptions/estimate-request.json'), request };
    expect(() => cloudRequestBody(estimateRequestSchema, body, name)).toThrow(FrameleafCloudError);
  });

  it('reads a described item, a failed item and one whose metadata the cloud removed', () => {
    expect(descriptionsResultSchema.parse(cloudContractFixture('ml/descriptions/result.json'))).toMatchObject({
      modelSku: 'ms_K6WT70CS',
      modelRev: 'mr_B2H147RBJBQ0',
      items: [{ inputId: 'a1', confidence: 0.87, moment: 'An evening run on the beach', warnings: [] }],
    });
    expect(
      descriptionsResultSchema.parse(cloudContractFixture('ml/descriptions/result-failed-item.json')).items[0],
    ).toMatchObject({ description: '', warnings: ['input-too-large'] });
    expect(
      descriptionsResultSchema.parse(cloudContractFixture('ml/descriptions/result-metadata-removed.json')).items[0]
        .warnings,
    ).toEqual(['metadata-removed', 'content-removed']);
  });

  it.each(REJECTED_RESULTS)('refuses the rejected %s result document', (name) => {
    expect(descriptionsResultSchema.safeParse(cloudContractFixture(`ml/descriptions/rejected/${name}`)).success).toBe(
      false,
    );
  });
});

describe('paused new work (FC-62)', () => {
  const refused = (status: number, code: string, message = 'Paused for maintenance until 18:00 UTC.') =>
    new FrameleafCloudError(
      MlAdmissionRefusal.CloudUnavailable,
      status,
      message,
      errorEnvelopeSchema.parse({ code, message, retryable: true }),
      null,
      300,
    );

  it('knows a paused refusal by its 503 code and keeps the cloud’s own message', () => {
    for (const code of ['service-paused', 'capacity', 'relay-unavailable']) {
      expect(isNewWorkPaused(refused(503, code))).toBe(true);
      expect(pausedMessageOf(refused(503, code))).toBe('Paused for maintenance until 18:00 UTC.');
    }
    expect(pausedMessageOf(refused(503, 'service-paused', '  '))).toBe(
      'Frameleaf Cloud has paused this for now. Try again later.',
    );
    expect(isNewWorkPaused(refused(503, 'down'))).toBe(false);
    expect(isNewWorkPaused(refused(403, 'service-paused'))).toBe(false);
    expect(pausedMessageOf(new Error('offline'))).toBeNull();
  });

  it('answers the administrator with a 503 carrying the message, the code and Retry-After', () => {
    const answer = pausedException(refused(503, 'service-paused'))!;
    expect(answer.getStatus()).toBe(503);
    expect(answer.getResponse()).toEqual({
      message: 'Paused for maintenance until 18:00 UTC.',
      error: 'Service Unavailable',
      statusCode: 503,
      code: 'service-paused',
      retryAfterSeconds: 300,
    });
    expect(pausedException(refused(500, 'internal'))).toBeNull();
  });
});

describe('consent versions and terms (FC-62)', () => {
  it('orders consent versions by date, then revision as a number', () => {
    expect(compareConsentVersions('2026-09-26.1', '2026-09-26.1')).toBe(0);
    expect(compareConsentVersions('2026-09-26.2', '2026-09-26.10')).toBeLessThan(0);
    expect(compareConsentVersions('2026-10-01.1', '2026-09-30.9')).toBeGreaterThan(0);
    expect(compareConsentVersions('2026-09-25', '2026-09-25.1')).toBeLessThan(0);
  });

  it('asks for the chosen features’ terms only once the cloud’s query is live', () => {
    const features = { identityNames: true, medicalSignals: false };
    expect(consentCurrentQuery(features, true)).toBe('?identityNames=true&medicalSignals=false');
    expect(consentCurrentQuery(features, false)).toBe('');
    expect(consentCurrentQuery(undefined, true)).toBe('');
  });
});
