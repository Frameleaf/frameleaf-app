import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import z from 'zod';
import { MlAdmissionRefusal, MlWorkload } from 'src/enum.js';

/**
 * Frameleaf Cloud contracts the self-hosted server reads (FL-159, CLD-201; program plan section 4,
 * "Discovery", "Tokens" and "Cloud ML v2"). These schemas are the server's side of the published
 * `packages/contracts` fixtures: unknown fields are ignored, missing required fields fail the read,
 * and a response that fails its schema is treated as the cloud being unavailable, never as a grant.
 */

/** Longest a cloud response body may be; discovery, capabilities, catalogue and wallet are small. */
export const FRAMELEAF_CLOUD_MAX_BODY_BYTES = 256 * 1024;

/** Timeout for one call to Frameleaf Cloud. */
export const FRAMELEAF_CLOUD_TIMEOUT_MS = 10_000;

/** How long before its expiry a cached access token is replaced. */
export const FRAMELEAF_CLOUD_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Lifetime of the signed client assertion (the contract allows at most five minutes). */
export const FRAMELEAF_CLOUD_ASSERTION_TTL_SECONDS = 120;

export const discoverySchema = z.object({
  version: z.number().int(),
  validFor: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60),
  issuer: z.url({ protocol: /^https?$/ }),
  api: z.url({ protocol: /^https?$/ }),
  ml: z.record(z.string().min(1).max(16), z.url({ protocol: /^https?$/ })),
  /** FL-155: named instance endpoints (`heartbeat`, `commands`, …); absent ones follow `api`. */
  endpoints: z.record(z.string().min(1).max(64), z.url({ protocol: /^https?$/ })).optional(),
});
export type FrameleafDiscoveryDocument = z.infer<typeof discoverySchema>;

/**
 * Why a discovery document must not be used, or null. The token issuer, the API and every regional
 * gateway must be on the configured cloud's host, a subdomain of it, or a sibling subdomain of the
 * cloud domain it belongs to (`cloudAddressProblem`), over https unless the configured
 * `FRAMELEAF_CLOUD_URL` is itself http (a development cloud), on the configured address's effective
 * port. Otherwise a tampered or misconfigured document could send the signed client assertion or an
 * access token elsewhere.
 */
export const discoveryProblem = (cloudUrl: string, document: FrameleafDiscoveryDocument): string | null => {
  const entries: Array<[string, string]> = [
    ['issuer', document.issuer],
    ['api', document.api],
    ...Object.entries(document.ml).map(([region, url]): [string, string] => [`ml.${region}`, url]),
    // FL-155: named instance endpoints (heartbeat, commands) follow the same rule
    ...Object.entries(document.endpoints ?? {}).map(([name, url]): [string, string] => [`endpoints.${name}`, url]),
  ];
  for (const [name, value] of entries) {
    const problem = cloudAddressProblem(cloudUrl, `discovery ${name}`, value);
    if (problem) {
      return problem;
    }
  }
  return null;
};

/** Second-level labels country registries sell names under (`co.uk`, `com.au`, `ne.jp`, …). */
const REGISTRY_SECOND_LEVELS: ReadonlySet<string> = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'go',
  'gob',
  'gov',
  'ltd',
  'me',
  'ne',
  'net',
  'nic',
  'or',
  'org',
  'plc',
]);

/**
 * The cloud domain whose sibling subdomains an address may use (FL-177, as-built decision #1), or
 * null. Frameleaf Cloud serves discovery on `api.frameleaf.cloud` and its issuer on
 * `id.frameleaf.cloud`, so with `FRAMELEAF_CLOUD_URL=https://api.frameleaf.cloud` the cloud domain is
 * `frameleaf.cloud`. Only a configured host of at least three labels has one (its first label
 * removed): an apex such as `frameleaf.cloud` already covers its subdomains, and dropping a label
 * from a two-label host would reach a public suffix. The same holds for a country's registry
 * domain (`frameleaf.co.uk` never widens to `co.uk`). An IP address never has one.
 */
export const cloudDomainOf = (hostname: string): string | null => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replaceAll(/^\[|\]$/g, ''))) {
    return null;
  }
  const labels = host.split('.');
  if (labels.length < 3 || labels.some((label) => !label)) {
    return null;
  }
  const domain = labels.slice(1);
  if (domain.length === 2 && domain[1].length === 2 && REGISTRY_SECOND_LEVELS.has(domain[0])) {
    return null;
  }
  return domain.join('.');
};

/**
 * Why an address the cloud handed over must not be used, or null: the same rule as discovery (the
 * configured host, a subdomain of it, or a subdomain of its cloud domain, https unless the configured
 * address is http, the configured port, no credentials). FL-155/FL-158 also apply it to the addresses
 * in the link response (the sign-in issuer), to the sign-in logout endpoint and to account-app links,
 * so a signed assertion or a person never leaves the cloud.
 */
export const cloudAddressProblem = (cloudUrl: string, name: string, value: string): string | null => {
  let configured: URL;
  let url: URL;
  try {
    configured = new URL(cloudUrl);
  } catch {
    return `the configured Frameleaf Cloud address ${cloudUrl} is not a URL`;
  }
  try {
    url = new URL(value);
  } catch {
    return `${name} ${value} is not a URL`;
  }
  const host = configured.hostname.toLowerCase();
  const allowHttp = configured.protocol === 'http:';
  const effectivePort = (address: URL) => address.port || (address.protocol === 'http:' ? '80' : '443');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return `${name} ${value} is not https`;
  }
  const candidate = url.hostname.toLowerCase();
  const domain = cloudDomainOf(host);
  const onCloud =
    candidate === host || candidate.endsWith(`.${host}`) || (domain !== null && candidate.endsWith(`.${domain}`));
  if (!onCloud) {
    return `${name} ${value} is not on ${domain ?? host}`;
  }
  if (effectivePort(url) !== effectivePort(configured)) {
    return `${name} ${value} is not on port ${effectivePort(configured)}`;
  }
  if (url.username || url.password) {
    return `${name} carries credentials`;
  }
  return null;
};

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().optional(),
  expires_in: z
    .number()
    .int()
    .min(1)
    .max(24 * 60 * 60),
});

const consentFeaturesSchema = z.object({
  identityNames: z.boolean().default(false),
  medicalSignals: z.boolean().default(false),
  ocrAddon: z.boolean().default(false),
});
export type CloudConsentFeatures = z.infer<typeof consentFeaturesSchema>;

/** Micro-USD per dollar: the cloud's ledger unit, and the finest a gateway `*Usd` amount may be. */
const MICROS_PER_USD = 1_000_000;

/**
 * A gateway amount named `*Usd` (FL-177, as-built decision #21): a decimal number of US dollars
 * with at most six decimals, never an integer count of micro-USD. The value is rounded to whole
 * micro-USD so binary floating point never shows as a stray fraction of a cent.
 */
export const usdAmount = () =>
  // zod 4 numbers are finite already
  z.number().transform((value) => Math.round(value * MICROS_PER_USD) / MICROS_PER_USD);

const walletSchema = z.object({
  balanceUsd: usdAmount(),
  heldUsd: usdAmount().pipe(z.number().min(0)).default(0),
  dailyCapUsd: usdAmount().pipe(z.number().min(0)).nullable().default(null),
  spentTodayUsd: usdAmount().pipe(z.number().min(0)).default(0),
});

/** An https address, or null when the cloud sent none or something else. */
const optionalHttpsUrl = () =>
  z
    .url({ protocol: /^https$/ })
    .nullable()
    .default(null)
    .catch(null);

/**
 * `GET /capabilities`. `workloads` lists only what can run right now (entitled, consented and with a
 * balance). `entitlement` is the account's cloud processing entitlement, either as a flag or as an
 * object carrying `active`.
 */
export const capabilitiesSchema = z.object({
  protocol: z.literal('frameleaf-cloud-v2'),
  region: z.string().min(1).max(16),
  workloads: z.array(z.string()).max(64),
  consent: z.object({
    requiredVersion: z.string().min(1).max(64),
    recordedVersion: z.string().min(1).max(64).nullable().default(null),
    features: consentFeaturesSchema.default({ identityNames: false, medicalSignals: false, ocrAddon: false }),
  }),
  entitlement: z.union([z.boolean(), z.object({ active: z.boolean() }).loose()]),
  wallet: walletSchema,
  limits: z.record(z.string(), z.number()).default({}),
  catalogEtag: z.string().max(200).nullable().default(null),
});
export type CloudCapabilities = z.infer<typeof capabilitiesSchema>;

export const walletResponseSchema = walletSchema.extend({
  topUpUrl: z
    .url({ protocol: /^https$/ })
    .nullable()
    .default(null),
  /** Automatic top-up with the payment method saved on the account (§2.5: $25 when below $5). */
  autoTopUp: z.boolean().default(false),
  /**
   * FL-177 (as-built decision #22): the account-app page where the daily cap is raised and automatic
   * top-up is turned on, when the cloud names it. Both need step-up there; a server cannot do them.
   */
  settingsUrl: optionalHttpsUrl(),
});

/**
 * `PATCH /v2/wallet`: the wallet settings a linked server may change for its account. With an
 * instance token only changes that reduce spend are accepted: lowering the daily cap or turning
 * automatic top-up off. Anything else is answered 403 `step-up-required` (as-built decision #22).
 */
export type CloudWalletSettings = { dailyCapUsd?: number; autoTopUp?: boolean };
export type CloudWallet = z.infer<typeof walletResponseSchema>;

export const catalogSchema = z.object({
  etag: z.string().max(200).nullable().default(null),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        workload: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        fingerprint: z.string().min(1).max(200),
        description: z.string().max(2000).default(''),
        pricing: z
          .object({
            unit: z.string().min(1).max(64),
            usd: usdAmount().pipe(z.number().min(0)),
          })
          .nullable()
          .default(null),
        retired: z.boolean().default(false),
      }),
    )
    .max(500),
});
export type CloudCatalog = z.infer<typeof catalogSchema>;

export const consentCurrentSchema = z.object({
  requiredVersion: z.string().min(1).max(64),
  recordedVersion: z.string().min(1).max(64).nullable().default(null),
  features: consentFeaturesSchema.default({ identityNames: false, medicalSignals: false, ocrAddon: false }),
  summary: z.string().max(4000).default(''),
  documentUrl: z
    .url({ protocol: /^https$/ })
    .nullable()
    .default(null),
});
export type CloudConsentCurrent = z.infer<typeof consentCurrentSchema>;

export const consentRecordedSchema = z.object({
  recordedVersion: z.string().min(1).max(64),
  features: consentFeaturesSchema,
});

/**
 * `GET /v2/usage?since=<ISO 8601>` (FL-177, as-built decision #24). Models and compute are opaque
 * SKUs (`modelSku`, `computeSku`); a model name or id never travels on the wire.
 */
export const usageSchema = z.object({
  items: z
    .array(
      z.object({
        jobId: z.string().min(1).max(200),
        clientRef: z.string().max(200).nullable().default(null),
        settledUsd: usdAmount().pipe(z.number().min(0)),
        credits: z.number().nullable().default(null),
        settledAt: z.string(),
        // What the settlement is made of (metered GPU time, start fees per worker), when reported.
        modelSku: z.string().max(200).nullable().default(null),
        computeSku: z.string().max(200).nullable().default(null),
        gpuSeconds: z.number().min(0).nullable().default(null),
        workers: z.number().int().min(1).max(64).nullable().default(null),
        estimateUsd: usdAmount().pipe(z.number().min(0)).nullable().default(null),
      }),
    )
    .max(1000),
});
export type CloudUsage = z.infer<typeof usageSchema>;

/**
 * The error codes of Frameleaf Cloud's `ErrorEnvelope` the server acts on (frameleaf-cloud
 * `packages/contracts/src/errors.ts`; as-built decisions #15–#18). Codes are never renamed:
 * `consent-version-outdated` is the only outdated-consent code.
 */
export enum CloudErrorCode {
  /** The cloud ended this server's link (a revoke), on a token or API call. */
  InstanceRevoked = 'instance_revoked',
  /** The access token was not accepted (expired or unknown); a new one is minted on the next call. */
  InvalidToken = 'invalid_token',
  /**
   * FC-19: 401 on every instance route for a token minted with a retired or revoked key (tokens
   * carry the key as `frameleaf_kid`). Only a new link helps.
   */
  KeyRetired = 'key_retired',
  /** FC-19: the key rotation nonce is unknown, used or expired; ask for a new one. */
  NonceInvalid = 'nonce_invalid',
  /** The account has no entitlement for what was asked. */
  EntitlementMissing = 'entitlement-missing',
  /** `POST /v1/instances`: this server's instance id is registered with another key. */
  InstanceIdTaken = 'instance-id-taken',
  /** `POST /v1/instances`: the account's plan allows no more linked servers. */
  InstanceLimit = 'instance-limit',
  /** `POST /v1/instances`: this server's key is already registered (a copied identity directory). */
  JwkAlreadyBound = 'jwk_already_bound',
  /** The change needs the account owner to confirm it in the account app (a wallet increase). */
  StepUpRequired = 'step-up-required',
  ConsentMissing = 'consent-missing',
  ConsentVersionOutdated = 'consent-version-outdated',
  DailyCap = 'daily-cap',
  RequestInvalid = 'request-invalid',
}

/**
 * The error envelope every cloud endpoint answers with on failure: `{code, message, retryable,
 * refusal, detail, data, requestId}`. `refusal` is a kebab-case `MlAdmissionRefusal` value, `detail` a
 * short string or null, and `data` an object carrying anything structured (for example the amounts
 * of an `insufficient-credits` refusal). A field that does not have its contract shape is dropped on
 * its own, so one odd field never hides the `code` the server acts on.
 */
export const errorEnvelopeSchema = z.object({
  code: z.string().max(100),
  message: z.string().max(2000).default('').catch(''),
  retryable: z.boolean().default(false).catch(false),
  refusal: z.string().max(100).nullable().default(null).catch(null),
  detail: z.string().max(2000).nullable().default(null).catch(null),
  data: z.record(z.string(), z.unknown()).nullable().default(null).catch(null),
  requestId: z.string().max(200).nullable().default(null).catch(null),
});
export type CloudErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

const CLOUD_REFUSALS = new Set<string>([
  MlAdmissionRefusal.CloudUnavailable,
  MlAdmissionRefusal.EntitlementMissing,
  MlAdmissionRefusal.ConsentMissing,
  MlAdmissionRefusal.ConsentVersionOutdated,
  MlAdmissionRefusal.WalletInsufficient,
  MlAdmissionRefusal.BudgetExceeded,
  MlAdmissionRefusal.QuotaExceeded,
  MlAdmissionRefusal.ModelMismatch,
  MlAdmissionRefusal.DestinationUnhealthy,
  MlAdmissionRefusal.RequestInvalid,
]);

/**
 * The admission refusal a failed cloud call means (program plan section 4 error mapping). An explicit
 * `refusal` in the envelope wins when it is one the server knows (the cloud sends it on every
 * refusal, as-built decisions #16 and #18); otherwise the status and code decide. Every outcome is a
 * refusal of the named destination: nothing here ever picks another one.
 */
export const refusalFromCloudError = (
  status: number | null,
  envelope: CloudErrorEnvelope | null,
): MlAdmissionRefusal => {
  if (envelope?.refusal && CLOUD_REFUSALS.has(envelope.refusal)) {
    return envelope.refusal as MlAdmissionRefusal;
  }
  const code = envelope?.code ?? '';
  switch (status) {
    case 401: {
      if (code === CloudErrorCode.KeyRetired) {
        // the server has to be linked again before Frameleaf Cloud answers it at all
        return MlAdmissionRefusal.CloudUnavailable;
      }
      return code === CloudErrorCode.EntitlementMissing
        ? MlAdmissionRefusal.EntitlementMissing
        : MlAdmissionRefusal.DestinationUnhealthy;
    }
    case 402: {
      return code === CloudErrorCode.DailyCap
        ? MlAdmissionRefusal.BudgetExceeded
        : MlAdmissionRefusal.WalletInsufficient;
    }
    case 403: {
      switch (code) {
        case CloudErrorCode.EntitlementMissing: {
          return MlAdmissionRefusal.EntitlementMissing;
        }
        case CloudErrorCode.ConsentVersionOutdated: {
          return MlAdmissionRefusal.ConsentVersionOutdated;
        }
        case CloudErrorCode.InstanceRevoked: {
          // the link is gone: the cloud is unavailable to this server, whatever was asked
          return MlAdmissionRefusal.CloudUnavailable;
        }
        default: {
          return MlAdmissionRefusal.ConsentMissing;
        }
      }
    }
    case 409: {
      return MlAdmissionRefusal.ModelMismatch;
    }
    case 422: {
      return MlAdmissionRefusal.RequestInvalid;
    }
    case 429: {
      return MlAdmissionRefusal.QuotaExceeded;
    }
    default: {
      return MlAdmissionRefusal.CloudUnavailable;
    }
  }
};

/** An OAuth error answer (RFC 6749 section 5.2, RFC 8628 section 3.5). */
export const oauthErrorSchema = z.object({
  error: z.string().min(1).max(100),
  error_description: z.string().max(2000).optional(),
});
export type OAuthErrorBody = z.infer<typeof oauthErrorSchema>;

/** A failed call to Frameleaf Cloud, carrying the refusal it maps to. */
export class FrameleafCloudError extends Error {
  constructor(
    readonly refusal: MlAdmissionRefusal,
    readonly status: number | null,
    message: string,
    readonly envelope: CloudErrorEnvelope | null = null,
    readonly oauth: OAuthErrorBody | null = null,
  ) {
    super(message);
    this.name = 'FrameleafCloudError';
  }
}

/** The error code of a failed cloud call: the envelope's `code`, else the OAuth `error`. */
export const cloudErrorCode = (error: unknown): string | null =>
  error instanceof FrameleafCloudError ? (error.envelope?.code ?? error.oauth?.error ?? null) : null;

/**
 * The account-app page a `403 step-up-required` answer links to (`data.url`), when it is an https
 * address on the configured cloud (`cloudAddressProblem`); otherwise null.
 */
export const stepUpUrl = (cloudUrl: string, error: unknown): string | null => {
  if (!(error instanceof FrameleafCloudError) || cloudErrorCode(error) !== CloudErrorCode.StepUpRequired) {
    return null;
  }
  const value = error.envelope?.data?.url;
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    return null;
  }
  return cloudAddressProblem(cloudUrl, 'step-up address', value) ? null : value;
};

/**
 * What the last check of the Frameleaf Cloud destination learned, persisted on the destination row
 * (`ml_destination.lastProbeCloud`) so admission and the inventory can decide without contacting
 * the cloud again. `refusal` is set when the check itself was refused (for example 402 or 403).
 */
export type CloudProbeFacts = {
  region: string | null;
  consentRequiredVersion: string | null;
  consentRecordedVersion: string | null;
  features: CloudConsentFeatures;
  entitled: boolean;
  balanceUsd: number;
  heldUsd: number;
  dailyCapUsd: number | null;
  spentTodayUsd: number;
  limits: Record<string, number>;
  catalogEtag: string | null;
  modelIds: string[];
  refusal: { refusal: MlAdmissionRefusal; detail: string } | null;
};

/**
 * Models that run on this server only (FL-146 owner decisions, 2026-09-25): the nllb-clip search
 * models (base and large, every variant; CC-BY-NC-4.0), MusicGen-small (CC-BY-NC-4.0) and
 * Qwen2.5-VL-3B-Instruct (Qwen Research License, including its OpenVINO conversion). They are never
 * taken from a Frameleaf Cloud catalogue, never routed or configured there, and admission refuses a
 * cloud job for them. They stay available on this server and home-network workers.
 */
const LOCAL_ONLY_MODEL = /nllb-clip|musicgen-small|qwen2\.5-vl-3b/i;
export const isLocalOnlyModel = (id: string | null | undefined): boolean => !!id && LOCAL_ONLY_MODEL.test(id);

/**
 * The Frameleaf Cloud model a kind of work uses when none is chosen (FL-146), matching the web
 * catalogue's `CLOUD_DEFAULT_MODELS`: descriptions use Qwen3.5 9B (Apache-2.0). Cloud work never
 * falls back to the local description setting (`machineLearning.imageDescription.modelName`).
 */
export const CLOUD_DESCRIPTION_DEFAULT_MODEL = 'qwen3.5-9b@1';

/** The model a Frameleaf Cloud job for `workload` names: the chosen one, or the licensed default. */
export const cloudModelFor = (workload: MlWorkload, chosen: string | null | undefined): string | null => {
  if (chosen && !isLocalOnlyModel(chosen)) {
    return chosen;
  }
  return workload === MlWorkload.Enrichment ? CLOUD_DESCRIPTION_DEFAULT_MODEL : null;
};

export const isEntitled = (entitlement: CloudCapabilities['entitlement']): boolean =>
  typeof entitlement === 'boolean' ? entitlement : entitlement.active;

export const cloudFactsFromCapabilities = (capabilities: CloudCapabilities, modelIds: string[]): CloudProbeFacts => ({
  region: capabilities.region,
  consentRequiredVersion: capabilities.consent.requiredVersion,
  consentRecordedVersion: capabilities.consent.recordedVersion,
  features: capabilities.consent.features,
  entitled: isEntitled(capabilities.entitlement),
  balanceUsd: capabilities.wallet.balanceUsd,
  heldUsd: capabilities.wallet.heldUsd,
  dailyCapUsd: capabilities.wallet.dailyCapUsd,
  spentTodayUsd: capabilities.wallet.spentTodayUsd,
  limits: capabilities.limits,
  catalogEtag: capabilities.catalogEtag,
  modelIds,
  refusal: null,
});

/** The server-known workloads in a cloud `workloads[]` list; anything else is ignored. */
export const knownWorkloads = (values: readonly string[]): MlWorkload[] =>
  values.filter((value): value is MlWorkload => (Object.values(MlWorkload) as string[]).includes(value));

export const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** RFC 7638 JWK thumbprint of an Ed25519 public key. */
export const ed25519Thumbprint = (jwk: { crv: string; kty: string; x: string }): string =>
  createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('base64url');

/** The regional processing gateway for a data region, from discovery. Never a hard-coded host. */
export const regionalGateway = (document: FrameleafDiscoveryDocument, region: string | undefined): string | null => {
  if (!region) {
    return null;
  }
  const url = document.ml[region];
  return url ? url.replace(/\/+$/, '') : null;
};

/**
 * `FRAMELEAF_TRUSTED_LAN_CIDRS` (FL-154): comma-separated IPv4 or IPv6 networks the edge worker
 * treats as home, besides RFC 1918 and ULA. A malformed entry stops start-up with a clear message
 * rather than silently widening or narrowing who counts as local.
 */
export const parseTrustedLanCidrs = (value: string | undefined): string[] => {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address, prefix, extra] = entry.split('/', 3);
      const family = isIP(address ?? '');
      const bits = Number(prefix);
      const max = family === 6 ? 128 : 32;
      if (extra !== undefined || !family || !/^\d{1,3}$/.test(prefix ?? '') || bits < 0 || bits > max) {
        throw new Error(`FRAMELEAF_TRUSTED_LAN_CIDRS has an invalid network: "${entry}"`);
      }
      return `${address}/${bits}`;
    });
};
