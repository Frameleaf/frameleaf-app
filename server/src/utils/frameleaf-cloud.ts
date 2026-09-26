import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import z from 'zod';
import { MlAdmissionRefusal, MlWorkload } from 'src/enum.js';

/**
 * Frameleaf Cloud contracts the self-hosted server reads (FL-159, CLD-201; program plan section 4,
 * "Discovery", "Tokens" and "Cloud ML v2"). These schemas are the server's side of the published
 * `packages/contracts` fixtures: unknown fields are ignored, missing required fields fail the read,
 * and a response that fails its schema is treated as the cloud being unavailable, never as a grant.
 * FL-183: the ML gateway shapes the contract declares strict (catalogue entries, estimates, job
 * admission, `job.run` and usage items) are strict here too, so an internal identifier or worker
 * detail on the wire is refused rather than dropped, and every body sent to the gateway is checked
 * against its contract first (`cloudRequestBody`).
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
  /**
   * FL-177 (as-built decision #29): the account site's store, `/store?product=<id>`. Checked on its
   * own (`storeAddress`); a bad value is dropped and never fails discovery.
   */
  store: z
    .url({ protocol: /^https?$/ })
    .optional()
    // eslint-disable-next-line unicorn/no-useless-undefined -- a bad store address is dropped, keeping the optional type
    .catch(() => undefined),
});
export type FrameleafDiscoveryDocument = z.infer<typeof discoverySchema>;

/**
 * The store address discovery names, when it passes the same address rule as every other cloud
 * address (`cloudAddressProblem`), without a trailing slash; otherwise null.
 */
export const storeAddress = (cloudUrl: string, store: string | null | undefined): string | null =>
  store && !cloudAddressProblem(cloudUrl, 'discovery store', store) ? store.replace(/\/+$/, '') : null;

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

/**
 * The registrable domains Frameleaf Cloud runs on (FL-177 review). Only these widen the address rule
 * to sibling subdomains. Any other configured host (a hosting provider's shared domain such as
 * `herokuapp.com`, `github.io` or `compute.amazonaws.com`, a registry domain such as `id.au`, a
 * development cloud) accepts only itself and its own subdomains.
 */
export const FRAMELEAF_CLOUD_REGISTRABLE_DOMAINS: readonly string[] = ['frameleaf.cloud'];

/**
 * The cloud domain whose sibling subdomains an address may use (FL-177, as-built decision #1), or
 * null. Frameleaf Cloud serves discovery on `api.frameleaf.cloud` and its issuer on
 * `id.frameleaf.cloud`, so with `FRAMELEAF_CLOUD_URL=https://api.frameleaf.cloud` the cloud domain is
 * `frameleaf.cloud`. Only a configured host under an allowlisted registrable domain
 * (`FRAMELEAF_CLOUD_REGISTRABLE_DOMAINS`) has one; the apex itself already covers its subdomains.
 */
export const cloudDomainOf = (hostname: string): string | null => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return FRAMELEAF_CLOUD_REGISTRABLE_DOMAINS.find((domain) => host.endsWith(`.${domain}`)) ?? null;
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

/**
 * A consent disclosure version as the gateway names it (FC-34 `ConsentVersion`): the date it was
 * written and a revision, `2026-09-26.1`. Versions are never edited in place, so a new text is a new
 * version and consent recorded for an older one answers 403 `consent-version-outdated`.
 */
export const CONSENT_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/;

/**
 * The opaque identifiers of the ML gateway (FC-66 `packages/contracts/src/ml/identifiers.ts`):
 * Crockford base32 without I, L, O and U. A model SKU (`ms_`) replaces the old model id, a model
 * revision (`mr_`) the old model fingerprint, a compute SKU (`cs_`) the GPU class, and a voice SKU
 * (`vs_`) a TTS voice name. None of them can be derived from, or matched to, a model or GPU name.
 */
export const MODEL_SKU_PATTERN = /^ms_[\dA-HJKMNP-TV-Z]{8}$/;
export const COMPUTE_SKU_PATTERN = /^cs_[\dA-HJKMNP-TV-Z]{8}$/;
export const VOICE_SKU_PATTERN = /^vs_[\dA-HJKMNP-TV-Z]{8}$/;
export const MODEL_REV_PATTERN = /^mr_[\dA-HJKMNP-TV-Z]{12}$/;

const modelSkuSchema = z.string().regex(MODEL_SKU_PATTERN);
const computeSkuSchema = z.string().regex(COMPUTE_SKU_PATTERN);
const voiceSkuSchema = z.string().regex(VOICE_SKU_PATTERN);
const modelRevSchema = z.string().regex(MODEL_REV_PATTERN);

/** An ISO 8601 timestamp with a zone, as every gateway timestamp is. */
const gatewayTimestamp = () => z.iso.datetime({ offset: true });

/** Text for people only (FC-66 `DisplayText`): never an identifier, no markup or control characters. */
const displayText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}<>]*$/u);

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

/** A gateway price or charge (FC-66 `GatewayUsd`): a `usdAmount` that is never negative and at most 1,000,000. */
const gatewayUsd = () => usdAmount().pipe(z.number().min(0).max(1_000_000));

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
 * `GET /capabilities` (FC-34 `CapabilitiesResponse`). `workloads` lists only what can run right now
 * (a published model, the entitlement active or in grace, consent at the required version and a
 * wallet with free balance that is not frozen); an ID this server does not know is ignored.
 * `entitlement` is `{active, state, graceUntil}`: `active` (grace included) is what this server
 * reads, and `state`/`graceUntil` only explain it.
 */
export const capabilitiesSchema = z.object({
  protocol: z.literal('frameleaf-cloud-v2'),
  region: z.string().min(1).max(16),
  workloads: z.array(z.string().max(64)).max(64),
  consent: z.object({
    requiredVersion: z.string().min(1).max(64),
    recordedVersion: z.string().min(1).max(64).nullable(),
    features: consentFeaturesSchema,
  }),
  entitlement: z.object({
    active: z.boolean(),
    state: z.string().min(1).max(40),
    graceUntil: gatewayTimestamp().nullable(),
  }),
  wallet: walletSchema,
  /** `maxInputBytes`, `maxInputs` and `concurrentTimePriced` (the jobs this account may run at once). */
  limits: z.record(z.string().max(64), z.number()),
  catalogEtag: z.string().max(200).nullable(),
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

/** Video restoration styles: a restoration model SKU is either faithful or creative (FC-34). */
export const CLOUD_RESTORATION_MODES = ['faithful', 'creative'] as const;
export type CloudRestorationMode = (typeof CLOUD_RESTORATION_MODES)[number];

/**
 * One `GET /v2/catalog` entry (FC-66 `CatalogEntry`, FC-34 `mode` and `licence`). The cloud's model
 * identity is `sku` (the model SKU) and `rev` (its current revision); this server stores and compares
 * the SKU wherever it used to keep a catalogue model id (`ml_workload_route.modelId`,
 * `CloudProbeFacts.modelIds`) and shows `rev` where it used to show the model fingerprint. `label` and
 * `display` are text for people and are never sent back.
 *
 * Strict, as the contract is: an entry that names an internal identifier (`modelId`, `gpuClass`,
 * `modelFingerprint`), carries a name where a SKU or revision belongs, gives a restoration model no
 * mode (or any other model one), or has a licence that forbids commercial hosted use is refused.
 * `catalogSchema` leaves such an entry out rather than failing the whole catalogue, so it is never
 * offered, chosen or sent.
 */
export const catalogEntrySchema = z
  .strictObject({
    sku: modelSkuSchema,
    workload: z.string().min(1).max(64),
    /** Position on the workload's ladder, 1 = lightest. */
    rank: z.number().int().min(1).max(50),
    label: displayText(80),
    display: z.strictObject({ model: displayText(80), gpu: displayText(80) }),
    computeSku: computeSkuSchema,
    rate: z.strictObject({ perSecondUsd: gatewayUsd(), startFeeUsd: gatewayUsd() }),
    eta: z.strictObject({ p50Sec: z.number().min(0), p90Sec: z.number().min(0) }),
    limits: z
      .record(z.string().regex(/^[a-z][\dA-Za-z]{0,39}$/), z.number())
      .refine((limits) => Object.keys(limits).length <= 20, 'at most 20 limits'),
    rev: modelRevSchema,
    /** Licence attribution where a model licence requires it ("Built with Qwen"). */
    notice: displayText(200).optional(),
    /**
     * FL-181, FC-34: `faithful` or `creative` on every restoration model and null or absent on every
     * other workload; the restoration style is chosen by choosing the SKU.
     */
    mode: z.enum(CLOUD_RESTORATION_MODES).nullable().optional(),
    /**
     * FC-34: the model licence shown next to the model. Only `yes` and `conditions` are ever
     * published; `no` (a licence forbidding commercial hosted use) refuses the entry.
     */
    licence: z.strictObject({ name: displayText(80), commercialHosted: z.enum(['yes', 'conditions']) }).optional(),
    /**
     * FC-34 (cloud decision 2026-09-26): the model the cloud recommends for its group, the workload
     * (and, for restoration, the mode) in this region. At most one model per group carries it; none
     * does when the recommended model is not available to this region or licence.
     */
    default: z.boolean().optional(),
  })
  .superRefine((entry, context) => {
    const hasMode = entry.mode !== undefined && entry.mode !== null;
    if (entry.workload === 'restoration' && !hasMode) {
      context.addIssue({ code: 'custom', path: ['mode'], message: 'a restoration model names its mode' });
    }
    if (entry.workload !== 'restoration' && hasMode) {
      context.addIssue({ code: 'custom', path: ['mode'], message: 'only restoration models have a mode' });
    }
  })
  .transform((entry) => ({
    ...entry,
    notice: entry.notice ?? null,
    mode: entry.mode ?? null,
    licence: entry.licence ?? null,
    default: entry.default === true,
  }));
export type CloudCatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * The catalogue group a model belongs to for its default (FC-34): its cloud workload, and for
 * restoration its mode too (`restoration:faithful`, `restoration:creative`). The region is the
 * gateway's own, so it is never part of the key.
 */
export const catalogGroupKey = (workload: string, mode: CloudRestorationMode | null): string =>
  mode ? `${workload}:${mode}` : workload;

/**
 * `GET /v2/catalog` (FC-34 `CatalogResponse`): only what this server may run now. Every entry is
 * checked on its own against `catalogEntrySchema`; one that fails is left out and counted in
 * `refused`, so a single bad entry never hides the rest and is never offered. A group that marks more
 * than one default (FC-34 allows at most one) keeps its models but loses every default mark, and
 * counts once in `refused`: this server never guesses which of them the cloud meant.
 */
export const catalogSchema = z
  .object({
    etag: z.string().max(200).nullable(),
    models: z.array(z.unknown()).max(500),
  })
  .transform(({ etag, models }) => {
    const accepted: CloudCatalogEntry[] = [];
    let refused = 0;
    for (const model of models) {
      const parsed = catalogEntrySchema.safeParse(model);
      if (parsed.success) {
        accepted.push(parsed.data);
      } else {
        refused++;
      }
    }
    const defaultsPerGroup = new Map<string, number>();
    for (const model of accepted) {
      if (model.default) {
        const key = catalogGroupKey(model.workload, model.mode);
        defaultsPerGroup.set(key, (defaultsPerGroup.get(key) ?? 0) + 1);
      }
    }
    const conflicting = new Set([...defaultsPerGroup].filter(([, count]) => count > 1).map(([key]) => key));
    refused += conflicting.size;
    return {
      etag,
      models: accepted.map((model) =>
        conflicting.has(catalogGroupKey(model.workload, model.mode)) ? { ...model, default: false } : model,
      ),
      refused,
    };
  });
export type CloudCatalog = z.infer<typeof catalogSchema>;

/**
 * The catalogue models this server may offer: every accepted entry except a local-only model (FL-146),
 * recognised by its display name, since a SKU never names the model.
 */
export const offeredCatalogModels = (catalog: Pick<CloudCatalog, 'models'> | null): CloudCatalogEntry[] =>
  (catalog?.models ?? []).filter((model) => !isLocalOnlyModel(model.sku) && !isLocalOnlyModel(model.display.model));

/**
 * The default model SKU of each catalogue group (`catalogGroupKey`) among `models` (FC-34): only a
 * model the catalogue marks and this server offers. A group without one has no entry, and nothing
 * else is ever picked in its place.
 */
export const catalogDefaults = (models: readonly CloudCatalogEntry[]): Record<string, string> =>
  Object.fromEntries(
    models.filter((model) => model.default).map((model) => [catalogGroupKey(model.workload, model.mode), model.sku]),
  );

/**
 * `GET /v2/consent/current` (FC-34 `ConsentCurrent`): the disclosure the region asks for now and
 * what this server last recorded, with the per-feature choices recorded alongside that version.
 */
export const consentCurrentSchema = z.object({
  requiredVersion: z.string().min(1).max(64),
  recordedVersion: z.string().min(1).max(64).nullable(),
  recordedAt: gatewayTimestamp().nullable(),
  features: consentFeaturesSchema,
  summary: z.string().max(4000).default(''),
  /** SHA-256 (hex) of the disclosure text: what a consent record stores. */
  textSha256: z
    .string()
    .regex(/^[\da-f]{64}$/)
    .nullable()
    .default(null),
  documentUrl: z
    .url({ protocol: /^https$/ })
    .nullable()
    .default(null),
});
export type CloudConsentCurrent = z.infer<typeof consentCurrentSchema>;

/**
 * `POST /v2/consent` body (FC-34 `ConsentRecordRequest`), checked before it is sent. Only the
 * current required version is accepted by the cloud; the text-recognition add-on (`ocrAddon`) is
 * reserved and always off; `acknowledgedBy`, when sent, is this server's opaque user id, never a
 * name or an email.
 */
export const consentRecordRequestSchema = z.strictObject({
  version: z.string().regex(CONSENT_VERSION_PATTERN),
  features: z.strictObject({ identityNames: z.boolean(), medicalSignals: z.boolean(), ocrAddon: z.literal(false) }),
  acknowledgedBy: z
    .string()
    .regex(/^[\w-]{1,64}$/)
    .optional(),
});
export type CloudConsentRecordRequest = z.infer<typeof consentRecordRequestSchema>;

/** `POST /v2/consent` answer (FC-34 `ConsentRecorded`). */
export const consentRecordedSchema = z.object({
  recordedVersion: z.string().min(1).max(64),
  recordedAt: gatewayTimestamp(),
  features: consentFeaturesSchema,
});
export type CloudConsentRecorded = z.infer<typeof consentRecordedSchema>;

/**
 * One `GET /v2/usage` item (FL-177, as-built decision #24; FC-66 `UsageItem`). Models and compute
 * are opaque SKUs (`modelSku`, `computeSku`). Strict, as the contract is: an item carrying a model id
 * (or any other field) is refused.
 */
export const usageItemSchema = z.strictObject({
  jobId: z.uuid(),
  clientRef: z.string().max(200).nullable(),
  settledUsd: gatewayUsd(),
  credits: z.number().nullable(),
  settledAt: gatewayTimestamp(),
  // What the settlement is made of (metered GPU time, start fees per worker), when reported.
  modelSku: modelSkuSchema.nullable(),
  computeSku: computeSkuSchema.nullable(),
  gpuSeconds: z.number().min(0).nullable(),
  workers: z.number().int().min(0).nullable(),
  estimateUsd: gatewayUsd().nullable(),
});
export type CloudUsageItem = z.infer<typeof usageItemSchema>;

/**
 * `GET /v2/usage?since=<ISO 8601>`. Every item is checked on its own, as catalogue entries are: one
 * that fails is left out and counted in `refused` (so its settlement is not applied from it), and
 * every other settlement is still applied, so one bad item never stops the budget from counting.
 */
export const usageSchema = z.object({ items: z.array(z.unknown()).max(1000) }).transform(({ items }) => {
  const accepted: CloudUsageItem[] = [];
  let refused = 0;
  for (const item of items) {
    const parsed = usageItemSchema.safeParse(item);
    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      refused++;
    }
  }
  return { items: accepted, refused };
});
export type CloudUsage = z.infer<typeof usageSchema>;

/** One input a job uploads, described by its digest; the cloud never sees a file name (FC-66 `JobInput`). */
const jobInputSchema = z.strictObject({
  inputId: z.string().regex(/^[\w-]{1,64}$/),
  contentType: z.string().regex(/^[a-z]+\/[\d+.a-z-]{1,100}$/),
  bytes: z.number().int().min(1).max(68_719_476_736),
  sha256: z.string().regex(/^[\da-f]{64}$/),
});
export type CloudJobInput = z.infer<typeof jobInputSchema>;

const jobInputsSchema = z
  .array(jobInputSchema)
  .min(1)
  .max(1000)
  .refine((inputs) => new Set(inputs.map((input) => input.inputId)).size === inputs.length, 'inputId must be unique');

/** A language tag (ISO 639 with an optional region), never free text. */
const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
const scale = z.union([z.literal(2), z.literal(4)]);

/**
 * The strict `request` allow-list per cloud workload (FC-66 `WORKLOAD_REQUESTS`, API protection
 * measure 2): prompts, sampling and model parameters stay in the cloud, and any other key is refused
 * here before it is sent, as the cloud would refuse it with 422 `request-invalid`.
 */
export const CLOUD_WORKLOAD_REQUESTS = {
  descriptions: z.strictObject({
    language: languageTag.optional(),
    length: z.enum(['short', 'standard', 'long']).optional(),
  }),
  upscale: z.strictObject({ scale: scale.optional() }),
  restoration: z.strictObject({ mode: z.enum(CLOUD_RESTORATION_MODES).optional(), scale: scale.optional() }),
  transcription: z.strictObject({ language: languageTag.optional() }),
  // `text` is what is spoken, not an instruction: plain text, no control characters but line breaks.
  tts: z.strictObject({
    voice: voiceSkuSchema,
    text: z
      .string()
      .min(1)
      .max(5000)
      .regex(/^(?:[^\p{Cc}]|\n)*$/u),
  }),
  interpolation: z.strictObject({ factor: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional() }),
} as const;

/**
 * The sealed estimate (FC-66, FC-34): an opaque `est1.` token binding this server, the workload,
 * model SKU and revision, compute SKU, inputs, request and price for 15 minutes. It is spent by the
 * first job admitted with it, so it is sent once, never edited and never reused for another job.
 */
const sealedEstimateSchema = z.string().regex(/^est1\.[\w-]{40,8192}$/);

const estimateRequestFor = <W extends keyof typeof CLOUD_WORKLOAD_REQUESTS>(workload: W) =>
  z.strictObject({
    workload: z.literal(workload),
    modelSku: modelSkuSchema,
    inputs: jobInputsSchema,
    request: CLOUD_WORKLOAD_REQUESTS[workload],
  });

/** `POST /v2/estimates` body (FC-66 `EstimateRequest`), checked before it is sent. */
export const estimateRequestSchema = z.discriminatedUnion('workload', [
  estimateRequestFor('descriptions'),
  estimateRequestFor('upscale'),
  estimateRequestFor('restoration'),
  estimateRequestFor('transcription'),
  estimateRequestFor('tts'),
  estimateRequestFor('interpolation'),
]);
export type CloudEstimateRequest = z.infer<typeof estimateRequestSchema>;

/** `POST /v2/estimates` answer (FC-66 `EstimateResponse`): the sealed estimate and what it quotes. */
export const estimateResponseSchema = z.strictObject({
  estimate: sealedEstimateSchema,
  expiresAt: gatewayTimestamp(),
  modelSku: modelSkuSchema,
  modelRev: modelRevSchema,
  computeSku: computeSkuSchema,
  cost: z.strictObject({
    p50: gatewayUsd(),
    p90: gatewayUsd(),
    startup: gatewayUsd(),
    hold: gatewayUsd(),
    minimum: gatewayUsd(),
  }),
  seconds: z.strictObject({ coldStart: z.number().min(0), run: z.number().min(0) }),
  basis: z.enum(['measured', 'modelled']),
});
export type CloudEstimate = z.infer<typeof estimateResponseSchema>;

/** Whether a sealed estimate may still be sent with a job: the cloud refuses it after `expiresAt`. */
export const estimateUsable = (estimate: Pick<CloudEstimate, 'expiresAt'>, now = Date.now()): boolean =>
  Date.parse(estimate.expiresAt) > now;

const jobRequestFor = <W extends keyof typeof CLOUD_WORKLOAD_REQUESTS>(workload: W) =>
  z.strictObject({
    estimate: sealedEstimateSchema,
    workload: z.literal(workload),
    modelSku: modelSkuSchema,
    modelRev: modelRevSchema,
    clientRef: z
      .string()
      .max(200)
      .regex(/^[^\p{Cc}]*$/u)
      .nullable()
      .optional(),
    packKey: z
      .string()
      .regex(/^[\w-]{1,64}$/)
      .optional(),
    deadlineSeconds: z.number().int().min(60).max(604_800).optional(),
    inputs: jobInputsSchema,
    request: CLOUD_WORKLOAD_REQUESTS[workload],
  });

/**
 * `POST /v2/jobs` body (FC-66 `JobCreateRequest`), checked before it is sent. It must match what its
 * sealed estimate binds; otherwise the cloud answers 409 `estimate-mismatch` (`ModelMismatch`).
 */
export const jobCreateRequestSchema = z.discriminatedUnion('workload', [
  jobRequestFor('descriptions'),
  jobRequestFor('upscale'),
  jobRequestFor('restoration'),
  jobRequestFor('transcription'),
  jobRequestFor('tts'),
  jobRequestFor('interpolation'),
]);
export type CloudJobCreateRequest = z.infer<typeof jobCreateRequestSchema>;

/**
 * `Idempotency-Key` on `POST /v2/jobs`: one per logical submission. A retry with the same key and
 * body answers the same admission, so a retry never spends a second estimate or holds twice.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\w-]{8,100}$/;

/**
 * `POST /v2/jobs` answer up to admission (FC-34 `JobAdmitted`): the sealed estimate is spent and the
 * wallet holds `hold.amountUsd`. Uploads and every later state belong to the broker (FC-39).
 */
export const jobAdmittedSchema = z.strictObject({
  jobId: z.uuid(),
  status: z.literal('admitted'),
  modelSku: modelSkuSchema,
  modelRev: modelRevSchema,
  computeSku: computeSkuSchema,
  hold: z.strictObject({ amountUsd: gatewayUsd(), ceilingUsd: gatewayUsd(), minimumUsd: gatewayUsd() }),
  createdAt: gatewayTimestamp(),
});
export type CloudJobAdmitted = z.infer<typeof jobAdmittedSchema>;

/** `job.run` (FC-66 `JobRun`): exactly these four fields; worker or data-centre details refuse it. */
export const jobRunSchema = z.strictObject({
  startedAt: gatewayTimestamp().nullable(),
  meteredSeconds: z.number().min(0),
  workers: z.number().int().min(0),
  startFees: z.number().int().min(0),
});
export type CloudJobRun = z.infer<typeof jobRunSchema>;

/** The job states of `GET /v2/jobs/{id}` (docs/cloud-ml.md job state machine, FC-34 `admitted`). */
export const CLOUD_JOB_STATUSES = [
  'admitted',
  'awaiting_upload',
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'cancelled_budget',
  'expired',
] as const;

/** Identifier fields that name cloud internals; no gateway answer carries them (FC-66). */
const INTERNAL_IDENTIFIER_FIELDS = ['modelId', 'gpuClass', 'modelFingerprint'] as const;

/**
 * `GET /v2/jobs/{id}` (FC-34 up to `admitted`; the later states, `progress` and `result` are FC-39's
 * and not yet published). Unknown fields are ignored, but a status naming an internal identifier is
 * refused, and `run` must have exactly its four fields.
 */
export const jobStatusSchema = z
  .object({
    jobId: z.uuid(),
    status: z.enum(CLOUD_JOB_STATUSES),
    modelSku: modelSkuSchema,
    modelRev: modelRevSchema,
    computeSku: computeSkuSchema.optional(),
    hold: z.strictObject({ amountUsd: gatewayUsd(), ceilingUsd: gatewayUsd(), minimumUsd: gatewayUsd() }).optional(),
    run: jobRunSchema.nullable().optional(),
    charges: z
      .object({ meteredUsd: gatewayUsd(), holdUsd: gatewayUsd(), ceilingUsd: gatewayUsd() })
      .nullable()
      .optional(),
    purgeAfter: gatewayTimestamp().nullable().optional(),
  })
  .loose()
  .superRefine((status, context) => {
    for (const field of INTERNAL_IDENTIFIER_FIELDS) {
      if (field in status) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} is never on the wire` });
      }
    }
  });
export type CloudJobStatus = z.infer<typeof jobStatusSchema>;

/**
 * A body this server is about to send to the ML gateway, checked against the contract first. One the
 * cloud would refuse is never sent: it is refused here with `RequestInvalid`, as the cloud would.
 */
export const cloudRequestBody = <T extends z.ZodType>(schema: T, body: unknown, what: string): z.infer<T> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw new FrameleafCloudError(
      MlAdmissionRefusal.RequestInvalid,
      null,
      `This server did not send ${what}: Frameleaf Cloud would not accept it${where}`,
    );
  }
  return parsed.data;
};

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
  /** 403: consent is recorded for an older disclosure version (`data.requiredVersion` names the current one). */
  ConsentVersionOutdated = 'consent-version-outdated',
  DailyCap = 'daily-cap',
  RequestInvalid = 'request-invalid',
  /** 409: the sealed estimate does not match the job, or was already spent (`detail: "used"`). */
  EstimateMismatch = 'estimate-mismatch',
  /** 409: the sealed estimate is older than 15 minutes. */
  EstimateExpired = 'estimate-expired',
  /** 503 (FC-34): the region takes no new jobs now (until FC-39 binds the broker, every job). */
  Capacity = 'capacity',
  /** 403 (FC-34): the account or the server belongs to another region's gateway. */
  RegionMismatch = 'region-mismatch',
  /** 403 (FC-19, FC-34): the cloud suspects this server's identity was copied. */
  CloneSuspected = 'clone_suspected',
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
  if (status === 403 && envelope?.code === CloudErrorCode.CloneSuspected) {
    // FL-183, as FL-185's token path: the cloud suspects a copy of this server, so it is unavailable
    // to this server until that clears, whatever `refusal` the envelope names
    return MlAdmissionRefusal.CloudUnavailable;
  }
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
        case CloudErrorCode.RegionMismatch: {
          // FC-34: the gateway refuses this server itself, never for want of consent
          return MlAdmissionRefusal.DestinationUnhealthy;
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
    case 503: {
      // FC-34: `capacity` refuses this destination now; the job is never moved to another one
      return code === CloudErrorCode.Capacity
        ? MlAdmissionRefusal.DestinationUnhealthy
        : MlAdmissionRefusal.CloudUnavailable;
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
    /** The answer's `Retry-After`, in seconds, when it had a usable one. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'FrameleafCloudError';
  }
}

/** The error code of a failed cloud call: the envelope's `code`, else the OAuth `error`. */
export const cloudErrorCode = (error: unknown): string | null =>
  error instanceof FrameleafCloudError ? (error.envelope?.code ?? error.oauth?.error ?? null) : null;

/**
 * The ML gateway itself (not the token endpoint, FL-185) answered 403 `clone_suspected` (FC-34
 * `MlInstanceGuard`): Frameleaf Cloud suspects a copy of this server.
 */
export const isGatewayCloneSuspected = (error: unknown): error is FrameleafCloudError =>
  error instanceof FrameleafCloudError &&
  error.status === 403 &&
  error.envelope?.code === CloudErrorCode.CloneSuspected;

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

/** A `Retry-After` header (delay in seconds, or an HTTP date) as seconds from `now`, or null. */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | null => {
  const text = value?.trim() ?? '';
  if (!text) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
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
  /**
   * The model SKUs (`ms_…`, FC-66) the catalogue offered at this check (FL-183): the cloud's model
   * identity, and what `ml_workload_route.modelId` names for Frameleaf Cloud work.
   */
  modelIds: string[];
  /**
   * The app workload each catalogued model SKU serves (FL-181 P1), from the catalogue's own
   * `workload`/`mode`, exactly as `workloadForCatalogEntry` reads it. `null` for a model the catalog
   * does not place. Admission uses this to refuse a modelId whose catalogue mode does not match the
   * workload asked for, since `restoration` alone (in `modelIds`) cannot tell faithful and creative
   * models apart.
   */
  modelWorkloads: Record<string, MlWorkload | null>;
  /**
   * FC-34: the model SKU the catalogue marks as the default of each group (`catalogGroupKey`:
   * `descriptions`, `restoration:faithful`, …), among the models offered. Admission uses it when no
   * model is routed; a group without one refuses. Absent on facts stored before FL-183, which
   * therefore name no default.
   */
  defaultModels?: Record<string, string>;
  refusal: { refusal: MlAdmissionRefusal; detail: string } | null;
};

/**
 * Models that run on this server only (FL-146 owner decisions, 2026-09-25): the nllb-clip search
 * models (base and large, every variant; CC-BY-NC-4.0), MusicGen-small (CC-BY-NC-4.0) and
 * Qwen2.5-VL-3B-Instruct (Qwen Research License, including its OpenVINO conversion). They are never
 * taken from a Frameleaf Cloud catalogue, never routed or configured there, and admission refuses a
 * cloud job for them. They stay available on this server and home-network workers.
 */
const LOCAL_ONLY_MODEL = /nllbclip|musicgensmall|qwen25vl3b/;

/**
 * Whether `id` (a model id, or a catalogue display name such as "Qwen2.5 VL 3B") names a local-only
 * model. Letters and digits alone are compared, lower-cased, so spaces, dots, hyphens, slashes and
 * underscores never hide one.
 */
export const isLocalOnlyModel = (id: string | null | undefined): boolean =>
  !!id && LOCAL_ONLY_MODEL.test(id.toLowerCase().replaceAll(/[^\da-z]/g, ''));

/**
 * The catalogue group a Frameleaf Cloud job for `workload` takes its default from (FC-34), or null
 * when there is none to take: Studio AI spans two cloud workloads (`transcription`, `tts`), so it
 * always names its model, and work the cloud never runs has no group.
 */
export const cloudDefaultGroupFor = (workload: MlWorkload): string | null => {
  const cloudId = cloudWorkloadIdFor(workload);
  if (!cloudId) {
    return null;
  }
  switch (workload) {
    case MlWorkload.RestorationFaithful: {
      return catalogGroupKey(cloudId, 'faithful');
    }
    case MlWorkload.RestorationCreative: {
      return catalogGroupKey(cloudId, 'creative');
    }
    default: {
      return catalogGroupKey(cloudId, null);
    }
  }
};

/**
 * The model a Frameleaf Cloud job for `workload` names (FL-183, FC-34): the one an administrator
 * chose (never a local-only one), else the model the catalogue marks as its group's default at the
 * last check, else null. A null answer is refused at admission; no model name or other model is ever
 * put in its place.
 */
export const cloudModelFor = (
  workload: MlWorkload,
  chosen: string | null | undefined,
  facts: Pick<CloudProbeFacts, 'defaultModels'> | null | undefined,
): string | null => {
  if (chosen) {
    return isLocalOnlyModel(chosen) ? null : chosen;
  }
  const group = cloudDefaultGroupFor(workload);
  if (!group) {
    return null;
  }
  return facts?.defaultModels?.[group] ?? null;
};

/** FC-34: the server reads `active` alone, which already includes a grace period (`state: grace`). */
export const isEntitled = (entitlement: CloudCapabilities['entitlement']): boolean => entitlement.active;

export const cloudFactsFromCapabilities = (
  capabilities: CloudCapabilities,
  modelIds: string[],
  modelWorkloads: Record<string, MlWorkload | null> = {},
  defaultModels: Record<string, string> = {},
): CloudProbeFacts => ({
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
  modelWorkloads,
  defaultModels,
  refusal: null,
});

/**
 * The workload IDs Frameleaf Cloud uses on the wire (FC-66, FL-181; canonical set in
 * `instance-contract.md` §FC-34, confirmed 2026-09-25): `descriptions`, `upscale`, `restoration`,
 * `transcription`, `tts`, `interpolation`. These IDs are never reused and are not the same strings
 * as `MlWorkload`: this server's workloads are finer-grained than the cloud's (restoration has a
 * faithful and a creative mode; Studio AI covers more than one kind of cloud work), so every place
 * that reads or sends a workload string on the cloud boundary (capabilities, catalogue, estimates,
 * jobs, usage) goes through the mapping below rather than comparing strings directly. An ID this
 * server does not recognise is always ignored, never guessed at.
 */
export const CLOUD_WORKLOAD_IDS = [
  'descriptions',
  'upscale',
  'restoration',
  'transcription',
  'tts',
  'interpolation',
] as const;
export type CloudWorkloadId = (typeof CLOUD_WORKLOAD_IDS)[number];

export const cloudWorkloadIdSchema = z.enum(CLOUD_WORKLOAD_IDS);

/**
 * The app workload(s) a cloud workload ID admits (FL-181). `restoration` admits both restoration
 * workloads at the capability level: a specific job still needs the catalog to say which mode a
 * model runs (`workloadForCatalogEntry`). `transcription` and `tts` both admit Studio AI, since a
 * cloud that offers either one can run some Studio AI work; which ID a specific job needs is decided
 * by the Studio feature being run (`studioAiCloudWorkloadId`), not by this capability check. An ID
 * this server does not know (or one of the workloads this server never sends: face, clip, ocr,
 * pet-recognition, studio-render) admits nothing.
 */
export const appWorkloadsForCloudId = (id: string): MlWorkload[] => {
  switch (id) {
    case 'descriptions': {
      return [MlWorkload.Enrichment];
    }
    case 'upscale': {
      return [MlWorkload.Upscale];
    }
    case 'restoration': {
      return [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative];
    }
    case 'transcription':
    case 'tts': {
      return [MlWorkload.StudioAi];
    }
    case 'interpolation': {
      return [MlWorkload.Interpolation];
    }
    default: {
      return [];
    }
  }
};

/** The server-known app workloads a cloud `workloads[]` list admits; an unknown ID is ignored. */
export const knownWorkloads = (values: readonly string[]): MlWorkload[] => [
  ...new Set(values.flatMap((value) => appWorkloadsForCloudId(value))),
];

/**
 * The cloud ID a job for `workload` is sent under (FL-181). `null` for a workload the cloud never
 * serves this way: Studio AI needs `studioAiCloudWorkloadId` instead, since one app workload covers
 * two cloud IDs and a specific job needs its own; face, clip, ocr, pet-recognition and studio-render
 * are never sent to the cloud at all.
 */
export const cloudWorkloadIdFor = (workload: MlWorkload): CloudWorkloadId | null => {
  switch (workload) {
    case MlWorkload.Enrichment: {
      return 'descriptions';
    }
    case MlWorkload.Upscale: {
      return 'upscale';
    }
    case MlWorkload.RestorationFaithful:
    case MlWorkload.RestorationCreative: {
      return 'restoration';
    }
    case MlWorkload.Interpolation: {
      return 'interpolation';
    }
    default: {
      return null;
    }
  }
};

/**
 * The Studio feature a Studio AI cloud job runs. Music is not a cloud workload in v1 (FL-181,
 * cloud-confirmed 2026-09-25): a music job is refused for the cloud by the existing Studio AI
 * refusal and is never mapped here or silently moved to a different workload.
 */
export type StudioAiCloudFeature = 'speech-to-text' | 'captions' | 'speech';

/**
 * The cloud ID a Studio AI job for `feature` is sent under (FL-181, cloud-confirmed 2026-09-25):
 * `transcription` covers speech-to-text and captions; `speech` uses `tts`.
 */
export const studioAiCloudWorkloadId = (feature: StudioAiCloudFeature): CloudWorkloadId =>
  feature === 'speech' ? 'tts' : 'transcription';

/**
 * The app workload a catalog entry serves (FL-181). Every workload but `restoration` maps to
 * exactly one app workload; a `restoration` entry needs its own `mode` (faithful or creative, read
 * from the catalog entry) to say which one, and `null` when the catalog does not say.
 */
export const workloadForCatalogEntry = (workload: string, mode: CloudRestorationMode | null): MlWorkload | null => {
  if (workload === 'restoration') {
    if (mode === 'creative') {
      return MlWorkload.RestorationCreative;
    }
    return mode === 'faithful' ? MlWorkload.RestorationFaithful : null;
  }
  return appWorkloadsForCloudId(workload)[0] ?? null;
};

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
