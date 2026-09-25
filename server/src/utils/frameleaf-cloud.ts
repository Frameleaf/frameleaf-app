import { createHash } from 'node:crypto';
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
});
export type FrameleafDiscoveryDocument = z.infer<typeof discoverySchema>;

/**
 * Why a discovery document must not be used, or null. The token issuer, the API and every regional
 * gateway must be on the configured cloud's host or a subdomain of it, over https unless the
 * configured `FRAMELEAF_CLOUD_URL` is itself http (a development cloud), on the configured address's
 * effective port. Otherwise a tampered or
 * misconfigured document could send the signed client assertion or an access token elsewhere.
 */
export const discoveryProblem = (cloudUrl: string, document: FrameleafDiscoveryDocument): string | null => {
  let configured: URL;
  try {
    configured = new URL(cloudUrl);
  } catch {
    return `the configured Frameleaf Cloud address ${cloudUrl} is not a URL`;
  }
  const host = configured.hostname.toLowerCase();
  const allowHttp = configured.protocol === 'http:';
  const effectivePort = (url: URL) => url.port || (url.protocol === 'http:' ? '80' : '443');
  const port = effectivePort(configured);
  const entries: Array<[string, string]> = [
    ['issuer', document.issuer],
    ['api', document.api],
    ...Object.entries(document.ml).map(([region, url]): [string, string] => [`ml.${region}`, url]),
  ];
  for (const [name, value] of entries) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      return `discovery ${name} ${value} is not https`;
    }
    const candidate = url.hostname.toLowerCase();
    if (candidate !== host && !candidate.endsWith(`.${host}`)) {
      return `discovery ${name} ${value} is not on ${host}`;
    }
    if (effectivePort(url) !== port) {
      return `discovery ${name} ${value} is not on port ${port}`;
    }
    if (url.username || url.password) {
      return `discovery ${name} carries credentials`;
    }
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

const walletSchema = z.object({
  balanceUsd: z.number(),
  heldUsd: z.number().min(0).default(0),
  dailyCapUsd: z.number().min(0).nullable().default(null),
  spentTodayUsd: z.number().min(0).default(0),
});

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
});

/** `PATCH /v2/wallet`: the wallet settings a linked server may change for its account. */
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
            usd: z.number().min(0),
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

export const usageSchema = z.object({
  items: z
    .array(
      z.object({
        jobId: z.string().min(1).max(200),
        clientRef: z.string().max(200).nullable().default(null),
        settledUsd: z.number().min(0),
        credits: z.number().nullable().default(null),
        settledAt: z.string(),
        // What the settlement is made of (metered GPU time, start fees per worker), when reported.
        modelId: z.string().max(200).nullable().default(null),
        gpuSeconds: z.number().min(0).nullable().default(null),
        workers: z.number().int().min(1).max(64).nullable().default(null),
        estimateUsd: z.number().min(0).nullable().default(null),
      }),
    )
    .max(1000),
});
export type CloudUsage = z.infer<typeof usageSchema>;

/** The error envelope every cloud endpoint answers with on failure. */
export const errorEnvelopeSchema = z.object({
  code: z.string().max(100),
  message: z.string().max(2000).default(''),
  retryable: z.boolean().default(false),
  refusal: z.string().max(100).nullable().default(null),
  detail: z.string().max(2000).nullable().default(null),
  requestId: z.string().max(200).nullable().default(null),
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
]);

/**
 * The admission refusal a failed cloud call means (program plan section 4 error mapping). An explicit
 * `refusal` in the envelope wins when it is one the server knows; otherwise the status decides.
 * Every outcome is a refusal of the named destination: nothing here ever picks another one.
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
      return code === 'entitlement-missing'
        ? MlAdmissionRefusal.EntitlementMissing
        : MlAdmissionRefusal.DestinationUnhealthy;
    }
    case 402: {
      return code === 'daily-cap' ? MlAdmissionRefusal.BudgetExceeded : MlAdmissionRefusal.WalletInsufficient;
    }
    case 403: {
      if (code === 'entitlement-missing') {
        return MlAdmissionRefusal.EntitlementMissing;
      }
      return code === 'consent-version-outdated'
        ? MlAdmissionRefusal.ConsentVersionOutdated
        : MlAdmissionRefusal.ConsentMissing;
    }
    case 409: {
      return MlAdmissionRefusal.ModelMismatch;
    }
    case 429: {
      return MlAdmissionRefusal.QuotaExceeded;
    }
    default: {
      return MlAdmissionRefusal.CloudUnavailable;
    }
  }
};

/** A failed call to Frameleaf Cloud, carrying the refusal it maps to. */
export class FrameleafCloudError extends Error {
  constructor(
    readonly refusal: MlAdmissionRefusal,
    readonly status: number | null,
    message: string,
    readonly envelope: CloudErrorEnvelope | null = null,
  ) {
    super(message);
    this.name = 'FrameleafCloudError';
  }
}

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
