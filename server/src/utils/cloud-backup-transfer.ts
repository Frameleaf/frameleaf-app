import z from 'zod';

const key = z.string().min(1).max(1024);
const hash = z.string().regex(/^[\da-f]{64}$/);
const part = z.strictObject({
  partNumber: z.int().min(1).max(10_000),
  etag: z.string().min(1).max(1024),
  size: z
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
  sha256: hash,
});

/** Only transfer identity and receipts belong in durable progress; never signing or encryption keys. */
export const backupTransferSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('upload'),
    key,
    source: z.string().max(4096).nullable(),
    sourceStamp: z.string().max(128).nullable(),
    expectedSha256: hash.nullable(),
    uploadId: z.string().min(1).max(2048).nullable(),
    previousUploads: z.array(z.string().max(2048)).max(1000),
    parts: z.array(part).max(10_000),
    completing: z.boolean(),
  }),
  z
    .strictObject({
      kind: z.literal('download'),
      key,
      partial: z.string().min(1).max(4096),
      expectedSha256: hash.nullable(),
      plaintextSha256: hash.nullable().optional(),
      versionId: z.string().min(1).max(2048).nullable().optional(),
      etag: z.string().min(1).max(1024),
      size: z.int().min(0),
      offset: z.int().min(0),
      completed: z.strictObject({ path: z.string().min(1).max(4096), sha256: hash }).nullable(),
    })
    .refine((value) => value.offset <= value.size),
]);
export type BackupTransfer = z.infer<typeof backupTransferSchema>;

export type BackupTransferJournal = {
  current: BackupTransfer | null;
  directory: string;
  /** Must be fenced by the operation's current claim before acknowledging this checkpoint. */
  save: (transfer: BackupTransfer | null) => Promise<void>;
};

export const readBackupTransfer = (result: unknown): BackupTransfer | null => {
  const parsed = backupTransferSchema.safeParse((result as { backupTransfer?: unknown } | null)?.backupTransfer);
  return parsed.success ? parsed.data : null;
};
