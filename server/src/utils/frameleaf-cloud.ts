import { HttpException, HttpStatus } from '@nestjs/common';
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

/**
 * FL-286: reviewed workloads covered by the October 3, 2026 AI GPU and AI Credits Terms:
 * https://frameleaf.app/legal/ai-gpu-and-ai-credits/
 * Cloud's current consent version/digest and per-job authorization remain required.
 */
export const hasPendingCloudDisclosure = (workload: MlWorkload): boolean =>
  ![
    MlWorkload.Enrichment,
    MlWorkload.RestorationFaithful,
    MlWorkload.RestorationCreative,
    MlWorkload.Upscale,
    MlWorkload.Interpolation,
    MlWorkload.StudioAi,
  ].includes(workload);

/** Longest a cloud response body may be; discovery, capabilities, catalogue and wallet are small. */
export const FRAMELEAF_CLOUD_MAX_BODY_BYTES = 256 * 1024;

/** Timeout for one call to Frameleaf Cloud. */
export const FRAMELEAF_CLOUD_TIMEOUT_MS = 10_000;

/** How long before its expiry a cached access token is replaced. */
export const FRAMELEAF_CLOUD_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Lifetime of the signed client assertion (the contract allows at most five minutes). */
export const FRAMELEAF_CLOUD_ASSERTION_TTL_SECONDS = 120;

/**
 * A remote-access zone (FL-165, cloud FC-29): a lowercase DNS name of at least two labels, each 1-63
 * characters of `a-z`, `0-9` and `-` without a leading or trailing hyphen, 253 characters at most:
 * the cloud's own `domainName` rule (frameleaf-cloud `packages/contracts/src/instance/discovery.ts`).
 * `frameleaf.net` in production, `frameleaf-direct.localhost` and `frameleaf-direct.test` in the
 * cloud's development and test setups, or a delegated subdomain such as `direct.example.com`. No
 * wildcard, trailing dot, uppercase, scheme or single label.
 */
export const DIRECT_DOMAIN = /^(?:[\da-z](?:[\da-z-]{0,61}[\da-z])?\.)+[\da-z](?:[\da-z-]{0,61}[\da-z])?$/;

const remoteSchema = z.object({ directDomain: z.string().max(253).regex(DIRECT_DOMAIN) });

/**
 * Why discovery's `remote` block is dropped, or null when it is absent or usable. The schema drops a
 * bad block without failing discovery; the caller logs this so the fallback to `frameleaf.net` is
 * never silent.
 */
export const discoveryRemoteProblem = (raw: unknown): string | null => {
  if (!raw || typeof raw !== 'object' || !('remote' in raw) || raw.remote === undefined) {
    return null;
  }
  if (remoteSchema.safeParse(raw.remote).success) {
    return null;
  }
  const value =
    raw.remote && typeof raw.remote === 'object' && 'directDomain' in raw.remote ? raw.remote.directDomain : raw.remote;
  return `remote.directDomain ${JSON.stringify(value)?.slice(0, 260)} is not a lowercase domain name`;
};

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
  /**
   * FL-165: remote access. `directDomain` is the zone per-server names live under (`<label>.<zone>`,
   * `*.<label>.<zone>`, `r.<label>.<zone>`); optional, `frameleaf.net` when absent
   * (`DEFAULT_DIRECT_DOMAIN`), and the enrolment answer's `domain` wins over it. Only a lowercase
   * domain name (`DIRECT_DOMAIN`) is taken; anything else drops the block, so the default applies
   * (`discoveryRemoteProblem` says why, for the log).
   */
  remote: remoteSchema
    .optional()
    // eslint-disable-next-line unicorn/no-useless-undefined -- a bad remote block is dropped, keeping the optional type
    .catch(() => undefined),
  /**
   * FC-62: the check-in and entitlement refresh intervals, set by staff (60–900 s and 3,600–86,400 s)
   * and read per request. Each is clamped where it is used; a bad value is dropped on its own, so the
   * contract default applies, and never fails discovery.
   */
  intervals: z
    .object({
      heartbeatSec: z.number().positive().optional().catch(undefined),
      entitlementRefreshSec: z.number().positive().optional().catch(undefined),
    })
    .optional()
    // eslint-disable-next-line unicorn/no-useless-undefined -- a bad intervals block is dropped, keeping the optional type
    .catch(() => undefined),
  /**
   * CLD-004: optional capability switches; a missing object or key means off, and a bad value is
   * dropped on its own (off) without failing discovery. `licenseLinkCode` turns on
   * `POST /v1/licenses/redeem-link-code` (the account site's one-time link codes).
   */
  features: z
    .object({
      licenseLinkCode: z.boolean().optional().catch(undefined),
    })
    .optional()
    // eslint-disable-next-line unicorn/no-useless-undefined -- a bad features block is dropped, keeping the optional type
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
 * The account site's origin. `FRAMELEAF_CLOUD_URL` is the API and discovery host, and the account site
 * is another origin (`https://frameleaf.cloud` against `api.frameleaf.cloud`), so it comes from the store
 * discovery names. Without one, the cloud domain's apex serves it (frameleaf-cloud#57), and a development
 * cloud without a cloud domain serves everything from the configured address.
 */
const accountSiteOrigin = (cloudUrl: string, store: string | null | undefined): string => {
  const named = storeAddress(cloudUrl, store);
  if (named) {
    return new URL(named).origin;
  }
  const configured = new URL(cloudUrl);
  const domain = cloudDomainOf(configured.hostname);
  return domain
    ? `${configured.protocol}//${domain}${configured.port ? `:${configured.port}` : ''}`
    : configured.origin;
};

/** The store: the address discovery names as given, else `/store` on the account site. */
export const accountStoreUrl = (cloudUrl: string, store: string | null | undefined): string =>
  storeAddress(cloudUrl, store) ?? `${accountSiteOrigin(cloudUrl, null)}/store`;

/** This server's page on the account site (`/servers/<instanceId>`), where its owner manages it. */
export const accountServerUrl = (cloudUrl: string, store: string | null | undefined, instanceId: string): string =>
  `${accountSiteOrigin(cloudUrl, store)}/servers/${encodeURIComponent(instanceId)}`;

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
 * configured host, a subdomain of it, or its cloud domain or a subdomain of it, https unless the configured
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
  // The cloud domain's apex is the cloud's own site (the account app and store, frameleaf-cloud#57).
  const onCloud =
    candidate === host ||
    candidate.endsWith(`.${host}`) ||
    (domain !== null && (candidate === domain || candidate.endsWith(`.${domain}`)));
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

/** A language tag (ISO 639 with an optional region), never free text. */
const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
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
    /** FC-48, transcription only: the languages the model is offered for, with the word error rate it is gated at. */
    languages: z
      .array(z.strictObject({ language: languageTag, wer: z.number().min(0).max(1) }))
      .max(100)
      .optional(),
    /** FC-48, TTS only: the voices that may be sent, as voice SKUs with a label and a language. */
    voices: z
      .array(z.strictObject({ sku: voiceSkuSchema, label: displayText(80), language: languageTag }))
      .max(100)
      .optional(),
  })
  .superRefine((entry, context) => {
    if (entry.languages && entry.workload !== 'transcription') {
      context.addIssue({ code: 'custom', path: ['languages'], message: 'only transcription models list languages' });
    }
    if (entry.voices && entry.workload !== 'tts') {
      context.addIssue({ code: 'custom', path: ['voices'], message: 'only tts models list voices' });
    }
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
    // FC-48 (owner decision 2026-09-27): speech is English only at launch; a voice in any other
    // language is never offered or sent, whatever a catalogue lists
    ...(entry.voices && { voices: entry.voices.filter((voice) => isEnglishVoice(voice.language)) }),
  }));
export type CloudCatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * FC-48 (owner decision 2026-09-27): Frameleaf Cloud speech (Kokoro) is English only at launch. Other
 * languages need a G2P engine under GPL-3.0 and their own review, so no other voice is offered.
 */
export const isEnglishVoice = (language: string): boolean => /^en(-|$)/.test(language);

/**
 * FC-48: speaker labels (transcription `diarize`) stay off until the cloud's rights register allows
 * pyannote. This server never asks for them: the transcription request below has no `diarize` key,
 * so a body carrying one is refused here before it is sent.
 */
export const CLOUD_SPEAKER_LABELS_OFFERED = false;

/**
 * The catalogue group a model belongs to (FC-34): its cloud workload, and for restoration its mode
 * too (`restoration-faithful`, `restoration-creative`). A group has at most one default, and it is
 * what an administrator chooses a Frameleaf Cloud model for (FL-186, `CloudModelGroup`). The region is
 * the gateway's own, so it is never part of the key.
 */
export const catalogGroupKey = (workload: string, mode: CloudRestorationMode | null): string =>
  mode ? `${workload}-${mode}` : workload;

/**
 * The groups an administrator chooses a Frameleaf Cloud model for (FL-186), keyed exactly as
 * `catalogGroupKey` keys the catalogue: one per cloud workload, restoration once per mode, and Studio
 * AI twice (`transcription` for speech to text and captions, `tts` for speech).
 */
export const CLOUD_MODEL_GROUPS = [
  'descriptions',
  'upscale',
  'restoration-faithful',
  'restoration-creative',
  'interpolation',
  'transcription',
  'tts',
] as const;
export type CloudModelGroup = (typeof CLOUD_MODEL_GROUPS)[number];

export const isCloudModelGroup = (value: string): value is CloudModelGroup =>
  (CLOUD_MODEL_GROUPS as readonly string[]).includes(value);

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
      if (!model.default) {
        continue;
      }
      const key = catalogGroupKey(model.workload, model.mode);
      defaultsPerGroup.set(key, (defaultsPerGroup.get(key) ?? 0) + 1);
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
 * FC-62: whether `GET /v2/consent/current` is asked for the version the CHOSEN features need
 * (`?identityNames=&medicalSignals=`), so the admin reads, and the server records, the terms those
 * features require. Live since frameleaf-cloud PR #78 (`ConsentCurrentQuery`); off, the cloud answers
 * for the features already on record.
 */
export const CONSENT_TERMS_FOR_FEATURES: boolean = true;

/**
 * The query of `GET /v2/consent/current` (FC-62): the chosen features as `"true"`/`"false"` strings when
 * `enabled`, else none, so the cloud answers for the features on record as before.
 */
export const consentCurrentQuery = (
  features: { identityNames: boolean; medicalSignals: boolean } | undefined,
  enabled: boolean = CONSENT_TERMS_FOR_FEATURES,
): string =>
  features && enabled
    ? `?${new URLSearchParams({
        identityNames: String(features.identityNames),
        medicalSignals: String(features.medicalSignals),
      })}`
    : '';

/**
 * Order two consent versions (`YYYY-MM-DD.N`): the date, then the revision as a number. Negative when
 * `a` is older. Consent never goes back to an older version (FC-62).
 */
export const compareConsentVersions = (a: string, b: string): number => {
  const [dateA, revisionA = '0'] = a.split('.', 2);
  const [dateB, revisionB = '0'] = b.split('.', 2);
  if (dateA !== dateB) {
    return dateA < dateB ? -1 : 1;
  }
  return Number(revisionA) - Number(revisionB);
};

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

const scale = z.union([z.literal(2), z.literal(4)]);

/**
 * The strict `request` allow-list per cloud workload (FC-66 `WORKLOAD_REQUESTS`, API protection
 * measure 2): prompts, sampling and model parameters stay in the cloud, and any other key is refused
 * here before it is sent, as the cloud would refuse it with 422 `request-invalid`.
 */
export const CLOUD_WORKLOAD_REQUESTS = {
  // FC-44 `DescriptionsRequest`: fixed options only, and the two consent-gated features as booleans
  descriptions: z.strictObject({
    language: languageTag.optional(),
    length: z.enum(['short', 'standard', 'long']).optional(),
    style: z.enum(['natural', 'factual']).optional(),
    maxTags: z.number().int().min(0).max(30).optional(),
    features: z.strictObject({ identityNames: z.boolean(), medicalSignals: z.boolean() }).partial().optional(),
  }),
  // FC-46 `UpscaleRequest`: `items` declares each input's pixel size, so the estimate prices it at the
  // scale it will really get and says which inputs the 64 MP output cap lowers (`EstimateUpscale`)
  upscale: z
    .strictObject({
      scale: scale.optional(),
      faceRestore: z.boolean().optional(),
      output: z
        .strictObject({
          format: z.enum(['png', 'jpeg', 'webp']).optional(),
          quality: z.number().int().min(50).max(100).optional(),
        })
        .refine((output) => output.quality === undefined || output.format === 'jpeg' || output.format === 'webp', {
          path: ['quality'],
          message: 'quality applies to jpeg and webp only',
        })
        .optional(),
      items: z
        .array(
          z.strictObject({
            inputId: z.string().regex(/^[\w-]{1,64}$/),
            width: z.number().int().min(1).max(65_535),
            height: z.number().int().min(1).max(65_535),
          }),
        )
        .min(1)
        .max(1000)
        .optional(),
    })
    .refine(
      (request) => !request.items || new Set(request.items.map((item) => item.inputId)).size === request.items.length,
      {
        path: ['items'],
        message: 'inputId must be unique',
      },
    ),
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

/** The 64 MP output cap of an upscale (FC-46 `UPSCALE_MAX_OUTPUT_MEGAPIXELS`); it stays, and the scale is lowered to fit. */
export const CLOUD_UPSCALE_MAX_OUTPUT_MEGAPIXELS = 64;

/**
 * FC-46 `upscaleAppliedScale` (owner decision 2026-09-27): the largest of `scales` that is at most the
 * requested scale and keeps the output within the 64 MP cap, or null when not even the smallest fits.
 * A 12 MP photo asked for 4× gets 2× (48 MP). The cloud's estimate, pricing and worker all decide with
 * this rule; this server uses it only to check what the cloud says.
 */
export const cloudUpscaleAppliedScale = (
  width: number,
  height: number,
  requested: number,
  scales: readonly number[] = [2, 4],
): 2 | 4 | null => {
  const fits = scales.filter(
    (value) =>
      (value === 2 || value === 4) &&
      value <= requested &&
      width * height * value * value <= CLOUD_UPSCALE_MAX_OUTPUT_MEGAPIXELS * 1_000_000,
  );
  return fits.length > 0 ? (Math.max(...fits) as 2 | 4) : null;
};

const upscaleInputId = z.string().regex(/^[\w-]{1,64}$/);

/**
 * FC-46 `EstimateUpscale` (upscale estimates only): the requested scale, the scale each declared input
 * gets, and the inputs the 64 MP output cap lowers. The owner sees `lowered` before confirming, since
 * it changes what the job makes and costs.
 */
export const estimateUpscaleSchema = z
  .strictObject({
    scale,
    items: z.array(z.strictObject({ inputId: upscaleInputId, scale })).max(1000),
    lowered: z.array(upscaleInputId).max(1000),
  })
  .superRefine((upscale, context) => {
    const items = new Map(upscale.items.map((item) => [item.inputId, item.scale]));
    if (items.size !== upscale.items.length) {
      context.addIssue({ code: 'custom', path: ['items'], message: 'inputId must be unique' });
    }
    for (const item of upscale.items) {
      if (item.scale > upscale.scale) {
        context.addIssue({
          code: 'custom',
          path: ['items'],
          message: 'an input never gets more than the requested scale',
        });
      }
      if (item.scale < upscale.scale !== upscale.lowered.includes(item.inputId)) {
        context.addIssue({
          code: 'custom',
          path: ['lowered'],
          message: 'lowered names exactly the inputs given a smaller scale',
        });
      }
    }
    for (const inputId of upscale.lowered) {
      if (!items.has(inputId)) {
        context.addIssue({ code: 'custom', path: ['lowered'], message: 'a lowered input is one of the items' });
      }
    }
  });
export type CloudEstimateUpscale = z.infer<typeof estimateUpscaleSchema>;

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
  /** FC-46, upscale only: the scale each declared input gets (`EstimateUpscale`). */
  upscale: estimateUpscaleSchema.optional(),
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
 * `Idempotency-Key` on `POST /v2/jobs` (FC-43, the IETF Idempotency-Key header draft): one per logical
 * submission. A retry with the same key and body answers the same admission, so a retry never spends a
 * second estimate or holds twice. A missing or malformed key answers 400 (`request-invalid`, detail
 * `idempotency-key`), so it is checked here first; the same key with another body answers 422
 * `idempotency-key-reused`; the same key while the first request is still processed answers 409
 * `idempotency-in-flight` with `Retry-After`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\w-]{8,100}$/;

/** FC-43: how often `POST /v2/jobs` is sent again while its key is still in flight, before giving up for now. */
export const CLOUD_IDEMPOTENCY_IN_FLIGHT_RETRIES = 3;
/** FC-43: the wait between those retries when `Retry-After` names none, and the longest wait honoured. */
export const CLOUD_IDEMPOTENCY_IN_FLIGHT_DEFAULT_SECONDS = 2;
export const CLOUD_IDEMPOTENCY_IN_FLIGHT_MAX_SECONDS = 30;

/* ------------------------------------------------------------------ */
/* Ephemeral job storage (FC-42, `packages/contracts/src/ml/storage.ts`) */
/* ------------------------------------------------------------------ */

/** FC-42: every multipart part but the last is exactly this long (8 MiB). */
export const CLOUD_UPLOAD_PART_BYTES = 8_388_608;

/** FC-42: inputs up to this size are uploaded with one presigned PUT (`inline`); larger ones in parts. */
export const CLOUD_UPLOAD_INLINE_MAX_BYTES = 1_048_576;

const sha256HexSchema = z.string().regex(/^[\da-f]{64}$/);
const storageContentTypeSchema = z.string().regex(/^[a-z]+\/[\d+.a-z-]{1,100}$/);
/** A presigned storage address. Where it may point is checked again before use (`cloudAddressProblem`). */
const storageUrlSchema = z.url({ protocol: /^https?$/ }).max(4096);

/**
 * FC-42 `StorageHeaders`: the signed content type and the job's storage encryption headers, which
 * every request to one of the job's presigned addresses sends exactly as given. They are secrets for
 * the job's lifetime: never logged and never stored beyond the job.
 */
export const storageHeadersSchema = z
  .record(z.string().regex(/^[\da-z-]{1,64}$/), z.string().max(200))
  .refine((headers) => Object.keys(headers).length <= 10, 'at most 10 headers');
export type CloudStorageHeaders = z.infer<typeof storageHeadersSchema>;

const presignedPartSchema = z.strictObject({
  partNumber: z.number().int().min(1).max(10_000),
  url: storageUrlSchema,
  bytes: z.number().int().min(1).max(CLOUD_UPLOAD_PART_BYTES),
});

/**
 * FC-42 `UploadTarget`: where and how one input is uploaded. Exactly the target its `method` names is
 * set; inline uploads are at most 1 MiB; a multipart target's parts add up to the input's size.
 */
export const uploadTargetSchema = z
  .strictObject({
    inputId: z.string().regex(/^[\w-]{1,64}$/),
    bytes: z.number().int().min(1),
    contentType: storageContentTypeSchema,
    sha256: sha256HexSchema,
    method: z.enum(['inline', 'multipart']),
    headers: storageHeadersSchema,
    inline: z.strictObject({ url: storageUrlSchema, method: z.literal('PUT') }).nullable(),
    multipart: z
      .strictObject({
        partBytes: z.literal(CLOUD_UPLOAD_PART_BYTES),
        parts: z.array(presignedPartSchema).min(1).max(10_000),
        completeUrl: storageUrlSchema,
      })
      .nullable(),
    uploaded: z.boolean(),
    expiresAt: gatewayTimestamp(),
  })
  .superRefine((target, context) => {
    if ((target.method === 'inline') !== (target.inline !== null)) {
      context.addIssue({ code: 'custom', path: ['method'], message: 'exactly the target of `method` is set' });
    }
    if ((target.method === 'multipart') !== (target.multipart !== null)) {
      context.addIssue({ code: 'custom', path: ['method'], message: 'exactly the target of `method` is set' });
    }
    if (target.method === 'inline' && target.bytes > CLOUD_UPLOAD_INLINE_MAX_BYTES) {
      context.addIssue({ code: 'custom', path: ['inline'], message: 'inline uploads are at most 1 MiB' });
    }
    if (target.multipart) {
      const total = target.multipart.parts.reduce((sum, part) => sum + part.bytes, 0);
      if (total !== target.bytes) {
        context.addIssue({
          code: 'custom',
          path: ['multipart', 'parts'],
          message: "the parts add up to the input's size",
        });
      }
    }
  });
export type CloudUploadTarget = z.infer<typeof uploadTargetSchema>;

/** `GET /v2/jobs/{id}/uploads` (FC-42 `UploadTargetsResponse`). */
export const uploadTargetsResponseSchema = z.strictObject({
  jobId: z.uuid(),
  uploads: z.array(uploadTargetSchema).max(1000),
});

/** FC-42 `OutputDownload`: one output, fetched with a presigned GET and verified against `sha256`. */
export const outputDownloadSchema = z.strictObject({
  outputId: z.string().regex(/^[\w-]{1,80}$/),
  url: storageUrlSchema,
  sha256: sha256HexSchema,
  bytes: z.number().int().min(0),
  contentType: storageContentTypeSchema,
});
export type CloudOutputDownload = z.infer<typeof outputDownloadSchema>;

/**
 * `POST /v2/jobs` answer up to admission (FC-34 `JobAdmitted`): the sealed estimate is spent and the
 * wallet holds `hold.amountUsd`. FC-42 added `uploads`, where each input goes, once the region has
 * job storage; `GET /v2/jobs/{id}/uploads` answers the same targets.
 */
export const jobAdmittedSchema = z.strictObject({
  jobId: z.uuid(),
  status: z.literal('admitted'),
  modelSku: modelSkuSchema,
  modelRev: modelRevSchema,
  computeSku: computeSkuSchema,
  hold: z.strictObject({ amountUsd: gatewayUsd(), ceilingUsd: gatewayUsd(), minimumUsd: gatewayUsd() }),
  createdAt: gatewayTimestamp(),
  uploads: z.array(uploadTargetSchema).max(1000).optional(),
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

/** FC-39 `FINAL_JOB_STATES`: the job never moves again, and its hold is released or settled. */
export const FINAL_CLOUD_JOB_STATUSES = ['completed', 'failed', 'cancelled', 'cancelled_budget', 'expired'] as const;
export type CloudJobStatusValue = (typeof CLOUD_JOB_STATUSES)[number];

export const isFinalCloudJobStatus = (status: CloudJobStatusValue): boolean =>
  (FINAL_CLOUD_JOB_STATUSES as readonly string[]).includes(status);

/**
 * FC-39 `JobErrorCode`: why a job ended without completing, with fixed customer copy. Every code but
 * `cancelled`, `budget-exceeded` and `runtime-cap` released the hold in full; `input-sha256-mismatch`
 * pays at most the minimum (one start fee).
 */
export const CLOUD_JOB_ERROR_CODES = [
  'worker-unavailable',
  'worker-lost',
  'time-limit',
  // FC-47 (owner decision 2026-09-27): the job reached its model's runtime cap (video restoration and
  // Smooth motion: 6 hours) and was stopped. Charged for what ran up to the cap; never retryable: the
  // clip has to be split
  'runtime-cap',
  'deadline-exceeded',
  'upload-expired',
  'queue-expired',
  'budget-exceeded',
  'cancelled',
  'internal',
  'input-sha256-mismatch',
] as const;
export type CloudJobErrorCode = (typeof CLOUD_JOB_ERROR_CODES)[number];

export const jobErrorSchema = z.strictObject({
  code: z.enum(CLOUD_JOB_ERROR_CODES),
  message: z.string().min(1).max(300),
  retryable: z.boolean(),
});
export type CloudJobError = z.infer<typeof jobErrorSchema>;

/** FC-39 `JobProgress`: `done` of `total` in `unit` (segments for chunked video). */
export const jobProgressSchema = z.strictObject({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  unit: z.enum(['items', 'seconds', 'segments']),
  etaSeconds: z.number().int().min(0).nullable(),
});
export type CloudJobProgress = z.infer<typeof jobProgressSchema>;

/** FC-39 `JobCharges`: metered so far (never above the hold), the hold and its ceiling. */
export const jobChargesSchema = z.strictObject({
  meteredUsd: gatewayUsd(),
  holdUsd: gatewayUsd(),
  ceilingUsd: gatewayUsd(),
});
export type CloudJobCharges = z.infer<typeof jobChargesSchema>;

const jobCostLineSchema = z.strictObject({
  kind: z.enum(['start_fees', 'gpu_time', 'minimum_charge', 'covered_by_frameleaf', 'refund']),
  label: z.string().min(1).max(80),
  sign: z.enum(['charge', 'credit']),
  quantity: z.number().int().min(0).nullable(),
  unit: z.enum(['starts', 'seconds']).nullable(),
  amountUsd: gatewayUsd(),
});
export type CloudJobCostLine = z.infer<typeof jobCostLineSchema>;

const toMicros = (usd: number) => Math.round(usd * MICROS_PER_USD);

/**
 * FC-43 `JobCost`: what a settled job cost. The charge lines minus the credit lines equal `totalUsd`
 * to the micro-USD, the total is never above the hold, and only a charged job has a total. Anything
 * else is refused, so a malformed settlement is never recorded as a charge.
 */
export const jobCostSchema = z
  .strictObject({
    outcome: z.enum(['charged', 'not_charged', 'refunded']),
    totalUsd: gatewayUsd(),
    heldUsd: gatewayUsd(),
    releasedUsd: gatewayUsd(),
    lines: z.array(jobCostLineSchema).max(5),
    note: z.string().min(1).max(300),
    settledAt: gatewayTimestamp(),
  })
  .superRefine((cost, context) => {
    const sum = cost.lines.reduce(
      (total, line) => total + (line.sign === 'charge' ? 1 : -1) * toMicros(line.amountUsd),
      0,
    );
    if (sum !== toMicros(cost.totalUsd)) {
      context.addIssue({ code: 'custom', path: ['lines'], message: "lines don't add up to totalUsd" });
    }
    if (toMicros(cost.totalUsd) > toMicros(cost.heldUsd)) {
      context.addIssue({ code: 'custom', path: ['totalUsd'], message: 'totalUsd is above heldUsd' });
    }
    if (cost.outcome !== 'charged' && cost.totalUsd !== 0) {
      context.addIssue({ code: 'custom', path: ['totalUsd'], message: 'only a charged job has a total' });
    }
  });
export type CloudJobCost = z.infer<typeof jobCostSchema>;

/**
 * FC-42 `JobResult`: the outputs of a completed job (or the completed outputs of one stopped at its
 * hold), until the job is acknowledged. Every GET sends `headers` exactly and checks `sha256`.
 */
export const jobResultSchema = z.strictObject({
  outputs: z.array(outputDownloadSchema).max(5000),
  headers: storageHeadersSchema,
  expiresAt: gatewayTimestamp(),
  modelSku: modelSkuSchema,
  modelRev: modelRevSchema,
});
export type CloudJobResult = z.infer<typeof jobResultSchema>;

/**
 * `GET /v2/jobs/{id}`, `POST /v2/jobs/{id}/start` and `POST /v2/jobs/{id}/cancel` (FC-39 `JobView`,
 * FC-43 `cost`). Strict, as the contract is: SKUs only, `run` exactly its four fields, no provider,
 * worker or GPU detail. The answer carries an `ETag` (304 on a match) and `Retry-After` while the job
 * waits.
 */
export const jobViewSchema = z.strictObject({
  jobId: z.uuid(),
  status: z.enum(CLOUD_JOB_STATUSES),
  modelSku: modelSkuSchema,
  modelRev: modelRevSchema,
  computeSku: computeSkuSchema,
  clientRef: z.string().max(200).nullable(),
  progress: jobProgressSchema.nullable(),
  run: jobRunSchema,
  charges: jobChargesSchema,
  cost: jobCostSchema.nullable().optional(),
  result: jobResultSchema.nullable(),
  error: jobErrorSchema.nullable(),
  purgeAfter: gatewayTimestamp().nullable(),
  createdAt: gatewayTimestamp(),
  updatedAt: gatewayTimestamp(),
});
export type CloudJobView = z.infer<typeof jobViewSchema>;

/**
 * FC-44 `DescriptionWarning`: why a description item is incomplete or was changed. The first four
 * mean the item failed (an empty description, no tags, no moment, confidence 0).
 */
export const CLOUD_DESCRIPTION_WARNINGS = [
  'input-unsupported',
  'input-too-large',
  'input-unreadable',
  'output-invalid',
  'metadata-removed',
  'content-removed',
  'truncated',
] as const;
export type CloudDescriptionWarning = (typeof CLOUD_DESCRIPTION_WARNINGS)[number];
export const CLOUD_DESCRIPTION_FAILURE_WARNINGS: readonly CloudDescriptionWarning[] = [
  'input-unsupported',
  'input-too-large',
  'input-unreadable',
  'output-invalid',
];

/** Text for people: no control characters and no markup. */
const descriptionText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}<>]*$/u);

/** FC-44 `DescriptionItem`: one photo's description, or why it has none. */
export const descriptionItemSchema = z
  .strictObject({
    inputId: z.string().regex(/^[\w-]{1,64}$/),
    description: descriptionText(1200),
    tags: z.array(descriptionText(48).min(1)).max(30),
    moment: descriptionText(120).min(1).nullable(),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.enum(CLOUD_DESCRIPTION_WARNINGS)).max(7),
  })
  .superRefine((item, context) => {
    const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
    if (new Set(item.tags).size !== item.tags.length) {
      issue('tags', 'tags are unique');
    }
    if (new Set(item.warnings).size !== item.warnings.length) {
      issue('warnings', 'warnings are unique');
    }
    const failed = item.warnings.some((warning) => CLOUD_DESCRIPTION_FAILURE_WARNINGS.includes(warning));
    if (failed !== (item.description === '')) {
      issue(
        'description',
        'a failed item has an empty description and a failure warning; a described item has neither',
      );
    }
    if (failed && (item.tags.length > 0 || item.moment !== null || item.confidence !== 0)) {
      issue('tags', 'a failed item has no tags, no moment and confidence 0');
    }
  });
export type CloudDescriptionItem = z.infer<typeof descriptionItemSchema>;

/**
 * FC-44 `DescriptionsResult`: one output document of a completed descriptions job (one output per
 * input, `outputId` = the input's `inputId`, `application/json`). It names the model by SKU and
 * revision only; anything else (a model name, a fingerprint, markup) refuses the whole document.
 */
export const descriptionsResultSchema = z
  .strictObject({
    schema: z.literal('frameleaf.descriptions/v1'),
    modelSku: modelSkuSchema,
    modelRev: modelRevSchema,
    language: languageTag,
    items: z.array(descriptionItemSchema).min(1).max(1000),
  })
  .refine((result) => new Set(result.items.map((item) => item.inputId)).size === result.items.length, {
    path: ['items'],
    message: 'inputId must be unique',
  });
export type CloudDescriptionsResult = z.infer<typeof descriptionsResultSchema>;

/** The largest description output document this server reads (FC-44 `DESCRIPTIONS_RESULT_MAX_BYTES`). */
export const CLOUD_DESCRIPTION_RESULT_MAX_BYTES = 16_384;

/** The output id of a job's result document (FC-46, FC-47): never a media output. */
export const CLOUD_RESULT_OUTPUT_ID = 'result';

/** FC-46 `UpscaleWarning`: why an item has no output, or what happened to one that has. */
export const CLOUD_UPSCALE_WARNINGS = [
  'input-unsupported',
  'input-animated',
  'input-too-large',
  'input-mismatch',
  'input-unreadable',
  'out-of-memory',
  'output-invalid',
  'metadata-removed',
  'icc-dropped',
  'tiles-reduced',
] as const;
const CLOUD_UPSCALE_FAILURE_WARNINGS: readonly string[] = CLOUD_UPSCALE_WARNINGS.slice(0, 7);
export const CLOUD_UPSCALE_OUTPUT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
const upscaleSide = z.number().int().min(1).max(65_535);

/**
 * FC-46 `UpscaleItem`: one input's outcome. `scale` (owner decision 2026-09-27) is the scale this input
 * was really upscaled by: the requested one, or the largest smaller one under the 64 MP output cap;
 * null for an item that failed.
 */
export const upscaleItemSchema = z
  .strictObject({
    inputId: upscaleInputId,
    input: z.strictObject({ width: upscaleSide, height: upscaleSide }).nullable(),
    scale: scale.nullable(),
    outputs: z
      .array(
        z.strictObject({
          outputId: upscaleInputId,
          contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
          width: upscaleSide,
          height: upscaleSide,
          bytes: z.number().int().min(1),
          sha256: z.string().regex(/^[\da-f]{64}$/),
        }),
      )
      .max(1),
    metrics: z.strictObject({
      tiles: z.number().int().min(0).max(1_000_000),
      seconds: z.number().min(0).max(604_800),
    }),
    warnings: z.array(z.enum(CLOUD_UPSCALE_WARNINGS)).max(10),
  })
  .superRefine((item, context) => {
    const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
    if (new Set(item.warnings).size !== item.warnings.length) {
      issue('warnings', 'warnings are unique');
    }
    const failed = item.warnings.some((warning) => CLOUD_UPSCALE_FAILURE_WARNINGS.includes(warning));
    if (failed !== (item.outputs.length === 0)) {
      issue('outputs', 'a failed item has no output and a failure warning; a succeeded item has one output');
    }
    if ((item.scale === null) !== (item.outputs.length === 0)) {
      issue('scale', 'a succeeded item names its scale; a failed one has none');
    }
    const output = item.outputs[0];
    if (output) {
      if (output.outputId !== item.inputId) {
        issue('outputs', 'the output is named by its input');
      }
      if (!item.input) {
        issue('input', 'a succeeded item names its input size');
      }
      if (output.width * output.height > CLOUD_UPSCALE_MAX_OUTPUT_MEGAPIXELS * 1_000_000) {
        issue('outputs', 'outputs are at most 64 MP');
      }
    }
  });
export type CloudUpscaleItem = z.infer<typeof upscaleItemSchema>;

/**
 * FC-46 `UpscaleResult`, the job's result document (output `result`). `scale` is the requested scale,
 * the most any item got; each output is its input times the item's own `scale`, never the document's.
 */
export const upscaleResultSchema = z
  .strictObject({
    schema: z.literal('frameleaf.upscale/v1'),
    modelSku: modelSkuSchema,
    modelRev: modelRevSchema,
    licence: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^\p{Cc}<>]*$/u),
    scale,
    format: z.enum(['png', 'jpeg', 'webp']),
    items: z.array(upscaleItemSchema).min(1).max(1000),
  })
  .superRefine((result, context) => {
    if (new Set(result.items.map((item) => item.inputId)).size !== result.items.length) {
      context.addIssue({ code: 'custom', path: ['items'], message: 'inputId must be unique' });
    }
    for (const [index, item] of result.items.entries()) {
      const output = item.outputs[0];
      if (!output || !item.input || item.scale === null) {
        continue;
      }
      if (item.scale > result.scale) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'scale'],
          message: 'never beyond the requested scale',
        });
      }
      if (output.width !== item.input.width * item.scale || output.height !== item.input.height * item.scale) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'outputs'],
          message: 'the output is the input times its scale',
        });
      }
      if (output.contentType !== CLOUD_UPSCALE_OUTPUT_TYPES[result.format]) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'outputs'],
          message: 'the output is in the requested format',
        });
      }
    }
  });
export type CloudUpscaleResult = z.infer<typeof upscaleResultSchema>;

/** The largest upscale result document this server reads (FC-46 `UPSCALE_RESULT_MAX_BYTES`). */
export const CLOUD_UPSCALE_RESULT_MAX_BYTES = 1_048_576;

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
  /**
   * 422 on `POST /v2/jobs` (FC-43, IETF Idempotency-Key draft; was 409 `idempotency-conflict`): the key
   * was already used with another body. This server keeps one key per logical job and one body per
   * key, so this is a bug here: the job fails and nothing is sent again.
   */
  IdempotencyKeyReused = 'idempotency-key-reused',
  /**
   * 409 on `POST /v2/jobs` (FC-43): the first request under this key is still being processed. The
   * same request is sent again after `Retry-After`; it is not a refusal of the job.
   */
  IdempotencyInFlight = 'idempotency-in-flight',
  /** 503 (FC-34): the region takes no new jobs now (until FC-39 binds the broker, every job). */
  Capacity = 'capacity',
  /** 403 (FC-34): the account or the server belongs to another region's gateway. */
  RegionMismatch = 'region-mismatch',
  /** 403 (FC-19, FC-34): the cloud suspects this server's identity was copied. */
  CloneSuspected = 'clone_suspected',
  /**
   * 503 (FC-62): Frameleaf staff paused new work of this kind (sign-ups, links, backup grants, top-ups);
   * retryable with `Retry-After`, and `message` is the status message customers see. Running work
   * carries on.
   */
  ServicePaused = 'service-paused',
  /** 503 (FC-31, FC-62): no relay tunnel now; also what a paused relay region answers. */
  RelayUnavailable = 'relay-unavailable',
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
      // FC-43: a key still in flight is a wait, never a spent or mismatched estimate (which would be
      // estimated again under a new key and could admit the job twice)
      return code === CloudErrorCode.IdempotencyInFlight
        ? MlAdmissionRefusal.CloudUnavailable
        : MlAdmissionRefusal.ModelMismatch;
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

/**
 * FC-62: Frameleaf Cloud refused to START new work because staff paused it: `service-paused` (links,
 * backup grants, top-ups), or the codes a paused relay region (`relay-unavailable`) and ML region
 * (`capacity`) keep. Always a 503, retryable, and never a reason to stop work already running.
 */
export const isNewWorkPaused = (error: unknown): error is FrameleafCloudError =>
  error instanceof FrameleafCloudError &&
  error.status === 503 &&
  [CloudErrorCode.ServicePaused, CloudErrorCode.RelayUnavailable, CloudErrorCode.Capacity].includes(
    error.envelope?.code as CloudErrorCode,
  );

/** What Frameleaf Cloud has paused, in its own words when it gave any (the status message staff wrote). */
export const pausedMessageOf = (error: unknown): string | null => {
  if (!isNewWorkPaused(error)) {
    return null;
  }
  return error.envelope?.message.trim() || 'Frameleaf Cloud has paused this for now. Try again later.';
};

/**
 * FC-62: a paused refusal as the answer an administrator's request gets: 503 with Frameleaf Cloud's own
 * message (never shortened by the web app), its `code` and `retryAfterSeconds`; null for anything else.
 */
export const pausedException = (error: unknown): HttpException | null => {
  const message = pausedMessageOf(error);
  if (!message) {
    return null;
  }
  const { envelope, retryAfterSeconds } = error as FrameleafCloudError;
  return new HttpException(
    {
      message,
      error: 'Service Unavailable',
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: envelope?.code ?? CloudErrorCode.ServicePaused,
      retryAfterSeconds,
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
};

/** The error code of a failed cloud call: the envelope's `code`, else the OAuth `error`. */
export const cloudErrorCode = (error: unknown): string | null =>
  error instanceof FrameleafCloudError ? (error.envelope?.code ?? error.oauth?.error ?? null) : null;

/** FC-43: `POST /v2/jobs` answered 409 `idempotency-in-flight`: send the same request after `Retry-After`. */
export const isIdempotencyInFlight = (error: unknown): boolean =>
  error instanceof FrameleafCloudError &&
  error.status === 409 &&
  error.envelope?.code === CloudErrorCode.IdempotencyInFlight;

/** FC-43: `POST /v2/jobs` answered 422 `idempotency-key-reused`: the key was used with another body. */
export const isIdempotencyKeyReused = (error: unknown): boolean =>
  error instanceof FrameleafCloudError &&
  error.status === 422 &&
  error.envelope?.code === CloudErrorCode.IdempotencyKeyReused;

/**
 * The ML gateway itself (not the token endpoint, FL-185) answered 403 `clone_suspected` (FC-34
 * `MlInstanceGuard`): Frameleaf Cloud suspects a copy of this server.
 */
export const isGatewayCloneSuspected = (error: unknown): error is FrameleafCloudError =>
  error instanceof FrameleafCloudError &&
  error.status === 403 &&
  error.envelope?.code === CloudErrorCode.CloneSuspected;

/**
 * FC-50: Frameleaf Cloud refused this server's ML region. The regional gateway answers 403
 * `region-mismatch` for a valid token minted for another region's gateway (only after the DPoP proof
 * and the key binding passed) and for an account or server of another region; the token endpoint
 * answers 400 `invalid_target` for an ML resource that is not the account's own region. Either way the
 * gateway this server chose does not match the owner's `dataRegion`: a configuration or discovery
 * problem, never a transient one.
 */
export const isRegionMismatch = (error: unknown): error is FrameleafCloudError =>
  error instanceof FrameleafCloudError &&
  ((error.status === 403 && error.envelope?.code === CloudErrorCode.RegionMismatch) ||
    (error.status === 400 && error.oauth?.error === 'invalid_target'));

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
   * identity, and what a Frameleaf Cloud model choice (`ml_cloud_model_choice`, FL-186) names.
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
   * `descriptions`, `restoration-faithful`, …), among the models offered. Admission uses it when no
   * model is chosen; a group without one refuses. Absent on facts stored before FL-183, which
   * therefore name no default.
   */
  defaultModels?: Record<string, string>;
  /**
   * FL-186: the catalogue group (`catalogGroupKey`) each offered model SKU belongs to. Admission
   * refuses a model whose group is not the job's own, so a TTS model is never sent for speech to
   * text, nor a faithful restoration model for creative work. Absent on facts stored before FL-186;
   * such facts admit no model until the next check.
   */
  modelGroups?: Record<string, string>;
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
 * always names its model, and work the cloud never runs has no group. `cloudModelGroupFor` is the
 * group a job's chosen model is read from, Studio AI included.
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

/**
 * The Frameleaf Cloud model group a cloud job reads its chosen model from (FL-186): the catalogue
 * group of `workload`, and for Studio AI the group of the feature being run (`transcription` for
 * speech to text and captions, `tts` for speech). Null for work the cloud never runs, and for Studio
 * AI when the feature is not named: that job has no model to send and is refused.
 */
export const cloudModelGroupFor = (
  workload: MlWorkload,
  studioFeature?: StudioAiCloudFeature | null,
): CloudModelGroup | null => {
  if (workload === MlWorkload.StudioAi) {
    if (!studioFeature) {
      return null;
    }
    return studioAiCloudWorkloadId(studioFeature) === 'tts' ? 'tts' : 'transcription';
  }
  const group = cloudDefaultGroupFor(workload);
  return group !== null && isCloudModelGroup(group) ? group : null;
};

/** The Studio features a Studio AI cloud job can name (FL-181). */
export const STUDIO_AI_CLOUD_FEATURES = ['speech-to-text', 'captions', 'speech'] as const;

/** FL-186: a model group stored as `restoration:faithful` before the keys were hyphenated. */
const hyphenatedGroup = (key: string): string => key.replace(/^restoration:(faithful|creative)$/, 'restoration-$1');

/**
 * Stored check facts in today's shape (FL-186): the old `restoration:faithful` and
 * `restoration:creative` group keys become `restoration-faithful` and `restoration-creative`, so a check
 * recorded before the keys changed still names its defaults. Facts from before FL-186 have no
 * `modelGroups`; that stays absent, and read-only views treat such a check as unknown until the next.
 */
export const normalizeCloudProbeFacts = (facts: CloudProbeFacts | null): CloudProbeFacts | null => {
  if (!facts) {
    return facts;
  }
  return {
    ...facts,
    ...(facts.defaultModels && {
      defaultModels: Object.fromEntries(
        Object.entries(facts.defaultModels).map(([group, sku]) => [hyphenatedGroup(group), sku]),
      ),
    }),
    ...(facts.modelGroups && {
      modelGroups: Object.fromEntries(
        Object.entries(facts.modelGroups).map(([sku, group]) => [sku, hyphenatedGroup(group)]),
      ),
    }),
  };
};

/** FC-34: the server reads `active` alone, which already includes a grace period (`state: grace`). */
export const isEntitled = (entitlement: CloudCapabilities['entitlement']): boolean => entitlement.active;

export const cloudFactsFromCapabilities = (
  capabilities: CloudCapabilities,
  modelIds: string[],
  modelWorkloads: Record<string, MlWorkload | null> = {},
  defaultModels: Record<string, string> = {},
  modelGroups: Record<string, string> = {},
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
  modelGroups,
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
export type StudioAiCloudFeature = (typeof STUDIO_AI_CLOUD_FEATURES)[number];

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
