import z from 'zod';

/**
 * FL-994: what this server accepts from another household's server. Everything here came from a machine owned by
 * another family, so each reply is parsed strictly, with length and range limits, before anything is written.
 */

/** Design section 8. */
export const HOUSEHOLD_PAGE_ENTRIES = 200;
export const HOUSEHOLD_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_FACES = 5000;
const MAX_SEQ = 2_147_483_647;
const MAX_COORDINATE = 1_000_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{2028}\u{2029}]/u;
/** One line of text: a name or a place. Bidirectional overrides would let a name display as something else. */
const line = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => !CONTROL.test(value) && !/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(value),
      'Invalid characters',
    );
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\0'), 'Invalid characters');
const date = z.iso.datetime({ offset: true }).refine((value) => {
  const year = new Date(value).getUTCFullYear();
  return year >= 1000 && year <= 3000;
}, 'Date out of range');
const fileName = line(255)
  .min(1)
  .refine((value) => !/[/\\]/.test(value) && value !== '.' && value !== '..', 'Invalid file name');

const HouseholdAsset = z.strictObject({
  id: z.uuid(),
  type: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'OTHER']),
  originalFileName: fileName,
  // hex as stored: SHA-1 on older items, SHA-256 on newer ones
  checksum: z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  fileCreatedAt: date,
  localDateTime: date,
  timeZone: z
    .string()
    .regex(/^[\w+:/-]{1,64}$/)
    .nullable(),
  description: text(10_000),
  rating: z
    .number()
    .int()
    .min(-1)
    .max(5)
    .refine((value) => value !== 0, 'Rating 0 is not valid')
    .nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  city: line(255).nullable(),
  state: line(255).nullable(),
  country: line(255).nullable(),
  width: z.number().int().min(0).max(MAX_COORDINATE).nullable(),
  height: z.number().int().min(0).max(MAX_COORDINATE).nullable(),
  duration: z
    .string()
    .regex(/^[\d:.]{1,32}$/)
    .nullable(),
  livePhotoVideoId: z.uuid().nullable(),
  stackId: z.uuid().nullable(),
  stackPrimary: z.boolean(),
  updatedAt: date,
  download: z.strictObject({
    token: z
      .string()
      .max(4096)
      .regex(/^[\w.-]+$/),
    expiresAt: date,
  }),
});
export type HouseholdManifestAsset = z.infer<typeof HouseholdAsset>;

const HouseholdFace = z.strictObject({
  assetId: z.uuid(),
  x1: z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  y1: z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  x2: z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  y2: z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  width: z.number().int().min(0).max(MAX_COORDINATE),
  height: z.number().int().min(0).max(MAX_COORDINATE),
});

/** Design section 7. Stored and shown as plain text, as a local comment is. */
export const HOUSEHOLD_COMMENT_CHARS = 4000;
const commentText = text(HOUSEHOLD_COMMENT_CHARS).refine((value) => value.trim().length > 0, 'Empty comment');
const lowerUuid = z.uuid().transform((value) => value.toLowerCase());
/** A like has no text and a comment has text, as the `activity` table requires. */
const likeOrText = (body: { isLiked: boolean; comment: string | null }) => body.isLiked === (body.comment === null);

const HouseholdComment = z
  .strictObject({
    assetId: lowerUuid.nullable(),
    isLiked: z.boolean(),
    comment: commentText.nullable(),
    createdAt: date,
    updatedAt: date,
    author: z.strictObject({ household: z.enum(['local', 'remote']), id: lowerUuid, name: text(100) }),
  })
  .refine(likeOrText, 'A like has no text and a comment has text');
export type HouseholdManifestComment = z.infer<typeof HouseholdComment>;

/** What a receiver may send. The id is the receiver's own, so a retry after a lost reply cannot post twice. */
export const HouseholdCommentPost = z
  .strictObject({
    id: z.uuidv4().transform((value) => value.toLowerCase()),
    userId: lowerUuid,
    assetId: lowerUuid.nullable(),
    isLiked: z.boolean(),
    comment: commentText.nullable(),
  })
  .refine(likeOrText, 'A like has no text and a comment has text');
export const HouseholdCommentPut = z.strictObject({ userId: lowerUuid, comment: commentText });
export const HouseholdCommentDelete = z.strictObject({ userId: lowerUuid });
export const HouseholdCommentReply = z.strictObject({ id: z.uuid() });

const base = { seq: z.number().int().positive().max(MAX_SEQ), id: z.uuid() };
const Entry = z.union([
  z.strictObject({ ...base, kind: z.enum(['asset', 'person', 'comment', 'space']), stop: z.literal(true) }),
  z.strictObject({ ...base, kind: z.literal('asset'), asset: HouseholdAsset }),
  z.strictObject({
    ...base,
    kind: z.literal('person'),
    person: z.strictObject({ name: text(100), faces: z.array(HouseholdFace).max(MAX_FACES) }),
  }),
  z.strictObject({ ...base, kind: z.literal('comment'), comment: HouseholdComment }),
]);
export type HouseholdManifestEntry = z.infer<typeof Entry>;

const Page = z.strictObject({
  version: z.literal(1),
  shareId: z.uuid(),
  entries: z.array(Entry).max(HOUSEHOLD_PAGE_ENTRIES),
  nextCursor: z.string().regex(/^\d{1,10}$/),
  complete: z.boolean(),
});

/** A reply that breaks the protocol. It affects that share only, and nothing from it is written. */
export class HouseholdBadPage extends Error {}

/**
 * One manifest page, whole or not at all. Beyond its shape, a page must be for this share, move strictly forward
 * from `cursor` and end where it says, so a peer cannot hold a pull in a loop or rewrite what was already read.
 */
export const parseHouseholdPage = (data: unknown, shareId: string, cursor: number) => {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(data));
  } catch {
    throw new HouseholdBadPage('The page is not JSON');
  }
  if (bytes > HOUSEHOLD_PAGE_BYTES) {
    throw new HouseholdBadPage('The page is over the byte limit');
  }
  const parsed = Page.safeParse(data);
  if (!parsed.success) {
    throw new HouseholdBadPage('The page does not match the protocol');
  }
  const page = parsed.data;
  if (page.shareId !== shareId) {
    throw new HouseholdBadPage('The page is for another share');
  }
  let previous = cursor;
  const seen = new Set<string>();
  for (const entry of page.entries) {
    const key = `${entry.kind}:${entry.id}`;
    if (entry.seq <= previous || seen.has(key)) {
      throw new HouseholdBadPage('The page does not move forward');
    }
    if ('asset' in entry && entry.asset.id !== entry.id) {
      throw new HouseholdBadPage('An entry names two items');
    }
    previous = entry.seq;
    seen.add(key);
  }
  const nextCursor = Number(page.nextCursor);
  if (nextCursor !== previous || nextCursor > MAX_SEQ || (page.entries.length === 0 && !page.complete)) {
    throw new HouseholdBadPage('The page cursor is wrong');
  }
  return { entries: page.entries, nextCursor, complete: page.complete };
};

/** `GET shares`. Longer limits than the page's: a name is cut to size when stored, never trusted to be short. */
export const HouseholdOffered = z
  .array(
    z.strictObject({
      id: z.uuid(),
      name: text(4096),
      description: text(100_000),
      ownerName: text(100),
      members: z
        .array(
          z.strictObject({
            remoteUserId: z.uuid(),
            role: z.enum(['viewer', 'contributor']),
            state: z.enum(['invited', 'accepted', 'left']),
          }),
        )
        .max(1000),
    }),
  )
  .max(200);

export const HouseholdHandshake = z.object({ maxOriginalBytes: z.number().int().positive() });

/** One line for a space's name, whatever the peer sent. */
export const cleanHouseholdLine = (value: string, max = 255) =>
  value
    .replaceAll(new RegExp(CONTROL, 'gu'), ' ')
    .replaceAll(/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, '')
    .trim()
    .slice(0, max);
