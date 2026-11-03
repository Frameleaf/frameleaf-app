import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import {
  ReviewedImportContext,
  readRetainedImportInputs,
  withImportInputRun,
} from 'src/library-import/reviewed-inputs.js';
import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  advanceSourceArchiveHash,
  decodeSourceArchiveRecord,
  encodeSourceArchiveRecord,
  sourceArchiveRecordFingerprint,
} from 'src/library-import/source-archive-codec.js';
import { LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';

const ordinal = z
  .string()
  .refine((value) => /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = z.strictObject({
  format: z.literal('frameleaf-source-archive'),
  version: z.literal(1),
  rows: ordinal,
  sha256: hash,
});
export const parseSourceArchiveDescriptor = (input: unknown) => {
  const result = descriptorSchema.safeParse(input);
  if (!result.success || (result.data.rows === '0' && result.data.sha256 !== EMPTY_SOURCE_ARCHIVE_HASH))
    throw new LibraryImportRefused('SOURCE_ARCHIVE_DESCRIPTOR_INVALID');
  return result.data;
};
const headerSchema = z
  .strictObject({
    destinationId: z.uuid(),
    version: z.literal(1),
    expectedCount: ordinal,
    expectedSha256: hash,
    writtenCount: ordinal,
    sealed: z.boolean(),
  })
  .refine(
    (header) =>
      BigInt(header.writtenCount) <= BigInt(header.expectedCount) &&
      (!header.sealed || header.writtenCount === header.expectedCount),
  );
type Header = z.infer<typeof headerSchema>;
const recordSchema = z.strictObject({ ordinal, payload: z.unknown(), sha256: hash });
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};
const required = (header: Header | undefined): Header => header ?? refuse('SOURCE_ARCHIVE_MISSING');

/** Private source content only. Projection qualification, source fencing and activation remain controller obligations. */
export class LibrarySourceArchive {
  private readonly context: ReviewedImportContext;
  constructor(
    private db: ImportDatabase,
    context: ReviewedImportContext,
  ) {
    const destination = z.uuid().safeParse(context.destinationId);
    if (!destination.success) throw new LibraryImportRefused('SOURCE_ARCHIVE_DESTINATION_CHANGED');
    this.context = {
      binding: parseLibraryImportBinding(context.binding),
      destinationId: destination.data.toLowerCase(),
    };
  }

  private withRun<T>(write: boolean, body: (tx: ImportDatabase, header: Header | undefined) => Promise<T>): Promise<T> {
    return withImportInputRun(this.db, this.context, write, async (tx, bound) => {
      const [row] = await tx.query(
        `SELECT destination_id::text AS "destinationId",version,
        expected_count::text AS "expectedCount",expected_sha256 AS "expectedSha256",
        written_count::text AS "writtenCount",sealed FROM public.frameleaf_library_import_archive
        WHERE operation_id=$1::uuid${write ? ' FOR UPDATE' : ''}`,
        [bound.binding.operationId],
      );
      let header: Header | undefined;
      if (row) {
        const parsed = headerSchema.safeParse(row);
        if (!parsed.success) return refuse('SOURCE_ARCHIVE_HEADER_INVALID');
        header = parsed.data;
        if (header.destinationId !== bound.destinationId.toLowerCase())
          return refuse('SOURCE_ARCHIVE_DESTINATION_CHANGED');
      }
      return body(tx, header);
    });
  }

  async begin(input: unknown): Promise<void> {
    const descriptor = parseSourceArchiveDescriptor(input);
    return this.withRun(true, async (tx, header) => {
      const reviewed = await readRetainedImportInputs(tx, this.context);
      if (header) {
        if (
          header.version !== descriptor.version ||
          header.expectedCount !== descriptor.rows ||
          header.expectedSha256 !== descriptor.sha256
        )
          return refuse('SOURCE_ARCHIVE_DESCRIPTOR_CHANGED');
        return;
      }
      await tx.query(
        `INSERT INTO public.frameleaf_library_import_archive
        (operation_id,destination_id,version,expected_count,expected_sha256) VALUES($1::uuid,$2::uuid,1,$3::bigint,$4)`,
        [this.context.binding.operationId, reviewed.plan.destinationId, descriptor.rows, descriptor.sha256],
      );
    });
  }

  async append(offset: string, input: unknown): Promise<void> {
    if (!ordinal.safeParse(offset).success || !Array.isArray(input) || input.length === 0 || input.length > 1000)
      return refuse('SOURCE_ARCHIVE_PAGE_INVALID');
    const start = BigInt(offset);
    const records = input.map((value, index) => {
      const payload = encodeSourceArchiveRecord(value);
      return { ordinal: String(start + BigInt(index)), payload, sha256: sourceArchiveRecordFingerprint(payload) };
    });
    const end = start + BigInt(records.length);
    return this.withRun(true, async (tx, value) => {
      const header = required(value);
      const written = BigInt(header.writtenCount);
      if (start > written) return refuse('SOURCE_ARCHIVE_GAP');
      if (end > BigInt(header.expectedCount)) return refuse('SOURCE_ARCHIVE_COUNT_MISMATCH');
      if (header.sealed && end > written) return refuse('SOURCE_ARCHIVE_SEALED');
      const overlap = end < written ? end - start : written - start;
      const existing = await tx.query(
        `SELECT r.ordinal::text,r.payload,r.sha256 FROM public.frameleaf_library_import_archive_record r
        WHERE r.operation_id=$1::uuid AND r.ordinal>=$2::bigint AND r.ordinal<$3::bigint ORDER BY r.ordinal`,
        [this.context.binding.operationId, offset, String(start + overlap)],
      );
      if (BigInt(existing.length) !== overlap) return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
      for (const [index, row] of existing.entries()) {
        const parsed = recordSchema.safeParse(row);
        if (
          !parsed.success ||
          parsed.data.ordinal !== records[index].ordinal ||
          sourceArchiveRecordFingerprint(parsed.data.payload) !== parsed.data.sha256 ||
          parsed.data.sha256 !== records[index].sha256
        )
          return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
      }
      const tail = records.slice(Number(overlap));
      if (tail.length === 0) return;
      await tx.query(
        `INSERT INTO public.frameleaf_library_import_archive_record(operation_id,ordinal,payload,sha256)
        SELECT $1::uuid,r.ordinal::bigint,r.payload,r.sha256
        FROM jsonb_to_recordset($2::text::jsonb) AS r(ordinal text,payload jsonb,sha256 text)`,
        [this.context.binding.operationId, JSON.stringify(tail)],
      );
      await tx.query(
        `UPDATE public.frameleaf_library_import_archive SET written_count=$2::bigint WHERE operation_id=$1::uuid`,
        [this.context.binding.operationId, String(end)],
      );
    });
  }

  private async records(tx: ImportDatabase, header: Header, offset: string) {
    const remaining = BigInt(header.writtenCount) - BigInt(offset);
    if (remaining < 0n) return refuse('SOURCE_ARCHIVE_PAGE_INVALID');
    const rows = await tx.query(
      `SELECT r.ordinal::text,r.payload,r.sha256 FROM public.frameleaf_library_import_archive_record r
      WHERE r.operation_id=$1::uuid AND r.ordinal>=$2::bigint ORDER BY r.ordinal LIMIT 1000`,
      [this.context.binding.operationId, offset],
    );
    if (BigInt(rows.length) !== (remaining > 1000n ? 1000n : remaining)) return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
    return rows.map((row, index) => {
      const parsed = recordSchema.safeParse(row);
      if (
        !parsed.success ||
        parsed.data.ordinal !== String(BigInt(offset) + BigInt(index)) ||
        sourceArchiveRecordFingerprint(parsed.data.payload) !== parsed.data.sha256
      )
        return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
      return parsed.data;
    });
  }

  /** Private keyset access; complete integrity evidence comes from verify(), not an individual page. */
  page(offset = '0') {
    if (!ordinal.safeParse(offset).success)
      return Promise.reject(new LibraryImportRefused('SOURCE_ARCHIVE_PAGE_INVALID'));
    return this.withRun(false, async (tx, value) => {
      const header = required(value);
      const rows = await this.records(tx, header, offset);
      const next = BigInt(offset) + BigInt(rows.length);
      return {
        records: rows.map((row) => decodeSourceArchiveRecord(row.payload)),
        next: next < BigInt(header.writtenCount) ? String(next) : null,
        sealed: header.sealed,
      };
    });
  }

  private async audit(tx: ImportDatabase, header: Header) {
    if (header.writtenCount !== header.expectedCount) return refuse('SOURCE_ARCHIVE_INCOMPLETE');
    const [count] = await tx.query(
      `SELECT count(*)::text AS count FROM public.frameleaf_library_import_archive_record
      WHERE operation_id=$1::uuid`,
      [this.context.binding.operationId],
    );
    if (count?.count !== header.expectedCount) return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
    let offset = 0n,
      bytes = 0n,
      sha256 = EMPTY_SOURCE_ARCHIVE_HASH;
    while (offset < BigInt(header.writtenCount)) {
      const page = await this.records(tx, header, String(offset));
      for (const row of page) {
        sha256 = advanceSourceArchiveHash(sha256, row.payload);
        bytes += BigInt(Buffer.byteLength(JSON.stringify(row.payload)));
      }
      offset += BigInt(page.length);
    }
    if (sha256 !== header.expectedSha256) return refuse('SOURCE_ARCHIVE_HASH_MISMATCH');
    return {
      format: 'frameleaf-source-archive-verification' as const,
      version: 1 as const,
      operationId: this.context.binding.operationId,
      records: header.writtenCount,
      bytes: String(bytes),
      sha256,
      sealed: header.sealed,
    };
  }

  verify() {
    return this.withRun(false, async (tx, header) => {
      await readRetainedImportInputs(tx, this.context);
      return this.audit(tx, required(header));
    });
  }

  seal() {
    return this.withRun(true, async (tx, value) => {
      const header = required(value);
      await readRetainedImportInputs(tx, this.context);
      const report = await this.audit(tx, header);
      if (!header.sealed)
        await tx.query(`UPDATE public.frameleaf_library_import_archive SET sealed=true WHERE operation_id=$1::uuid`, [
          this.context.binding.operationId,
        ]);
      return { ...report, sealed: true };
    });
  }
}
