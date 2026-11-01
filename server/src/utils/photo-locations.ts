import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import z from 'zod';

export const LOCATION_INPUT_MAX_COMPRESSED = 128 * 1024 * 1024;
export const LOCATION_INPUT_MAX_EXPANDED = 1024 * 1024 * 1024;
export const LOCATION_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const LOCATION_UNIT_PRICE_MICROS = 5000;
const locationCurrencySchema = z.literal('USD').meta({ id: 'LocationBillingCurrency' });
const locationUnitPriceSchema = z.literal(5000).meta({ id: 'LocationBillingUnitPriceMicros' });
const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const locationBillingSchema = z
  .object({
    currency: locationCurrencySchema,
    unitPriceMicros: locationUnitPriceSchema,
    heldMicros: micros,
    checkedPhotos: z.number().int().nonnegative(),
    chargedMicros: micros.nullable(),
    releasedMicros: micros.nullable(),
    state: z
      .enum(['pending_hold', 'held', 'settling', 'settled', 'released', 'no_charge'])
      .meta({ id: 'LocationBillingState' }),
  })
  .meta({ id: 'LocationScanBillingDto' });
export type LocationBilling = z.infer<typeof locationBillingSchema>;
export const locationBillingFinal = (billing: LocationBilling | null | undefined) =>
  !!billing &&
  ['settled', 'released', 'no_charge'].includes(billing.state) &&
  billing.chargedMicros !== null &&
  billing.releasedMicros !== null;
export const locationNoCharge = (): LocationBilling => ({
  currency: 'USD',
  unitPriceMicros: 5000,
  heldMicros: 0,
  checkedPhotos: 0,
  chargedMicros: 0,
  releasedMicros: 0,
  state: 'no_charge',
});
export const cloudLocationEstimateSchema = z.object({
  estimateId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  currency: locationCurrencySchema,
  unitPriceMicros: locationUnitPriceSchema,
  eligiblePhotos: z.number().int().nonnegative(),
  selectedPhotos: z.number().int().positive(),
  remainingPhotos: z.number().int().nonnegative(),
  holdMicros: micros,
  availableMicros: micros,
});
export type CloudLocationEstimate = z.infer<typeof cloudLocationEstimateSchema>;
export const photoGpsAccuracy = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : null;
const LOCATION_INPUT_LIMITS = { compressed: LOCATION_INPUT_MAX_COMPRESSED, expanded: LOCATION_INPUT_MAX_EXPANDED };
export const LOCATION_ACTIVE_STATUSES = ['queued', 'preparing', 'uploading', 'running', 'paused'] as const;

const mapsUrl = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.hostname === 'maps.google.com' ||
      (['www.google.com', 'google.com'].includes(url.hostname) && url.pathname.startsWith('/maps')))
  );
}, 'Expected a Google Maps link');

export const locationInsightSchema = z.object({
  provider: z.literal('google').meta({ id: 'LocationInsightProvider' }),
  placeId: z.string().min(1).max(512),
  name: z.string().min(1).max(1024),
  address: z.string().max(2048).nullable().default(null),
  mapsUrl,
  relation: z.enum(['at', 'near']).meta({ id: 'LocationInsightRelation' }),
  confidence: z.enum(['high', 'medium']).meta({ id: 'LocationInsightConfidence' }),
  distanceM: z.number().meta({ format: 'double' }).finite().nonnegative().max(100),
  matchedAt: z.iso.datetime({ offset: true }),
  attributions: z
    .array(z.object({ displayName: z.string().min(1).max(1024), uri: z.url({ protocol: /^https?$/ }).optional() }))
    .max(100),
});
export type PhotoLocationInsight = z.infer<typeof locationInsightSchema>;

export const locationPointSchema = z.strictObject({
  itemKey: z.string().min(1).max(128),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().nonnegative().max(100_000).optional(),
});
export type PhotoLocationPoint = z.infer<typeof locationPointSchema>;

export const validPhotoCoordinates = (latitude: unknown, longitude: unknown): boolean =>
  typeof latitude === 'number' &&
  Number.isFinite(latitude) &&
  Math.abs(latitude) <= 90 &&
  typeof longitude === 'number' &&
  Number.isFinite(longitude) &&
  Math.abs(longitude) <= 180 &&
  (latitude !== 0 || longitude !== 0);

/** The input contains only the fields of the public GPS contract, irrespective of its local source row. */
export async function writeLocationInput(
  path: string,
  scanId: string,
  points: AsyncIterable<PhotoLocationPoint>,
  limits = LOCATION_INPUT_LIMITS,
) {
  let pointCount = 0;
  let expanded = 0;
  let compressedBytes = 0;
  const hash = createHash('sha256');
  async function* document() {
    yield `{"schemaVersion":1,"scanId":${JSON.stringify(scanId)},"points":[`;
    for await (const point of points) {
      const value = locationPointSchema.parse(point);
      if (!validPhotoCoordinates(value.latitude, value.longitude)) throw new Error('Invalid photo coordinates');
      yield `${pointCount++ ? ',' : ''}${JSON.stringify(value)}`;
    }
    yield ']}';
  }
  await pipeline(
    Readable.from(document()),
    new Transform({
      transform(chunk, _encoding, callback) {
        expanded += Buffer.byteLength(chunk);
        callback(expanded > limits.expanded ? new RangeError('Photo location input is too large') : null, chunk);
      },
    }),
    createGzip(),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressedBytes += chunk.length;
        hash.update(chunk);
        callback(
          compressedBytes > limits.compressed ? new RangeError('Photo location input is too large') : null,
          chunk,
        );
      },
    }),
    createWriteStream(path, { mode: 0o600 }),
  );
  return { pointCount, compressedBytes, sha256: hash.digest('hex') };
}

export const cloudLocationStatusSchema = z.object({
  scanId: z.uuid(),
  state: z.enum([
    'uploading',
    'queued',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'acknowledged',
    'expired',
  ]),
  counts: z.object({
    total: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
  }),
  uploadOffset: z.number().int().nonnegative().max(LOCATION_INPUT_MAX_COMPRESSED),
  compressedBytes: z.number().int().nonnegative().max(LOCATION_INPUT_MAX_COMPRESSED),
  algorithmVersion: z.literal(1),
  pauseReason: z.string().max(512).optional(),
  retryAfter: z.number().nonnegative().optional(),
  expiresAt: z.iso.datetime({ offset: true }),
  billing: locationBillingSchema,
});
export const cloudLocationResultsSchema = z.object({
  scanId: z.uuid(),
  algorithmVersion: z.literal(1),
  items: z
    .array(
      z.discriminatedUnion('state', [
        z.object({ itemKey: z.string().min(1).max(128), state: z.literal('matched'), match: locationInsightSchema }),
        z.object({ itemKey: z.string().min(1).max(128), state: z.literal('unmatched') }),
      ]),
    )
    .max(500),
  nextOffset: z.number().int().nonnegative().nullable(),
  complete: z.boolean(),
});
