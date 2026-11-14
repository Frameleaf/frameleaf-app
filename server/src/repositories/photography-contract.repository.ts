import { Injectable, NotFoundException } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Transaction } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import type { PhotographyContractTable } from 'src/schema/tables/photography-contract.table.js';

export type ContractRow = Selectable<PhotographyContractTable>;
export type ContractStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'void';
export type ContractEventInput = {
  type: 'created' | 'sent' | 'email_verified' | 'viewed' | 'consented' | 'signed' | 'finalized' | 'voided';
  actor: 'studio' | 'signer' | 'system';
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
};
export type ContractEvent = {
  seq: number;
  type: ContractEventInput['type'];
  actor: ContractEventInput['actor'];
  at: string;
  ip: string | null;
  userAgent: string | null;
  data: Record<string, unknown>;
  prevEventSha256: string | null;
  sha256: string;
};

/** JSON with object keys sorted, so a value reads back from jsonb (which reorders keys) to the same bytes. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

/** Each event hashes its own fields plus the previous event's hash, so an edited or missing row breaks the chain. */
export const contractEventSha256 = (event: Omit<ContractEvent, 'sha256'>) =>
  createHash('sha256')
    .update(
      stableJson([
        event.seq,
        event.type,
        event.actor,
        event.at,
        event.ip,
        event.userAgent,
        event.data,
        event.prevEventSha256,
      ]),
    )
    .digest('hex');

const editable: ContractStatus[] = ['draft', 'sent', 'viewed'];
const signable: ContractStatus[] = ['sent', 'viewed'];

@Injectable()
export class PhotographyContractRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  templates(ownerId: string) {
    return this.db
      .selectFrom('photography_contract_template')
      .select(['id', 'name', 'body', 'updatedAt'])
      .where('ownerId', '=', ownerId)
      .orderBy('name')
      .execute();
  }
  async template(ownerId: string, id: string) {
    const row = await this.db
      .selectFrom('photography_contract_template')
      .select(['id', 'name', 'body', 'updatedAt'])
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Template is unavailable');
    return row;
  }
  createTemplate(ownerId: string, value: { name: string; body: string }) {
    return this.db
      .insertInto('photography_contract_template')
      .values({ ownerId, ...value })
      .returning(['id', 'name', 'body', 'updatedAt'])
      .executeTakeFirstOrThrow();
  }
  async updateTemplate(ownerId: string, id: string, value: { name: string; body: string }) {
    const row = await this.db
      .updateTable('photography_contract_template')
      .set({ ...value, updatedAt: new Date() })
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .returning(['id', 'name', 'body', 'updatedAt'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Template is unavailable');
    return row;
  }
  async deleteTemplate(ownerId: string, id: string) {
    const { numDeletedRows } = await this.db
      .deleteFrom('photography_contract_template')
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!numDeletedRows) throw new NotFoundException('Template is unavailable');
  }

  list(ownerId: string) {
    return this.db
      .selectFrom('photography_contract')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .execute();
  }
  async get(ownerId: string, id: string) {
    const row = await this.db
      .selectFrom('photography_contract')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Contract is unavailable');
    return row;
  }
  /** A live link: right hash, not expired, not voided. */
  byToken(tokenHash: string) {
    return this.db
      .selectFrom('photography_contract')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .where('tokenExpiresAt', '>', new Date())
      .where('status', '!=', 'void')
      .executeTakeFirst();
  }
  events(contractId: string): Promise<ContractEvent[]> {
    return this.db
      .selectFrom('photography_contract_event')
      .select(['seq', 'type', 'actor', 'at', 'ip', 'userAgent', 'data', 'prevEventSha256', 'sha256'])
      .where('contractId', '=', contractId)
      .orderBy('seq')
      .execute()
      .then((rows) => rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() }) as ContractEvent));
  }

  create(value: Insertable<PhotographyContractTable>) {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('photography_contract').values(value).returningAll().executeTakeFirstOrThrow();
      await this.append(trx, row.id, [
        { type: 'created', actor: 'studio', data: { documentSha256: row.documentSha256 } },
      ]);
      return row;
    });
  }
  send(ownerId: string, id: string, tokenHash: string, tokenExpiresAt: Date) {
    return this.change(id, ownerId, editable, async (trx) => {
      await trx
        .updateTable('photography_contract')
        .set({ status: 'sent', tokenHash, tokenExpiresAt, sentAt: new Date() })
        .where('id', '=', id)
        .execute();
      return [{ type: 'sent', actor: 'studio', data: { expiresAt: tokenExpiresAt.toISOString() } }];
    });
  }
  void(ownerId: string, id: string) {
    return this.change(id, ownerId, editable, async (trx) => {
      await trx
        .updateTable('photography_contract')
        .set({ status: 'void', tokenHash: null, tokenExpiresAt: null })
        .where('id', '=', id)
        .execute();
      return [{ type: 'voided', actor: 'studio' }];
    });
  }
  /** The first open of the emailed link proves the signer controls the address. */
  viewed(id: string, request: { ip: string | null; userAgent: string | null }, email: string) {
    return this.change(id, null, ['sent'], async (trx) => {
      await trx.updateTable('photography_contract').set({ status: 'viewed' }).where('id', '=', id).execute();
      return [
        { type: 'email_verified', actor: 'signer', ...request, data: { email } },
        { type: 'viewed', actor: 'signer', ...request },
      ];
    });
  }
  sign(
    id: string,
    tokenHash: string,
    signer: {
      name: string;
      signatureType: 'typed' | 'drawn';
      signaturePng: Buffer | null;
      documentSha256: string;
      consentSha256: string;
    },
    request: { ip: string | null; userAgent: string | null },
  ) {
    return this.change(id, null, signable, async (trx, row) => {
      const live = row.tokenHash === tokenHash && row.tokenExpiresAt && new Date(row.tokenExpiresAt) > new Date();
      const unchanged =
        row.documentSha256 === signer.documentSha256 &&
        createHash('sha256').update(row.body, 'utf8').digest('hex') === row.documentSha256;
      if (!live || !unchanged) return null;
      await trx
        .updateTable('photography_contract')
        .set({
          status: 'signed',
          signedAt: new Date(),
          signerName: signer.name,
          signatureType: signer.signatureType,
          signaturePng: signer.signaturePng,
        })
        .where('id', '=', id)
        .execute();
      const signatureSha256 = signer.signaturePng
        ? createHash('sha256').update(signer.signaturePng).digest('hex')
        : null;
      return [
        { type: 'consented', actor: 'signer', ...request, data: { consentSha256: signer.consentSha256 } },
        {
          type: 'signed',
          actor: 'signer',
          ...request,
          data: {
            name: signer.name,
            signatureType: signer.signatureType,
            signatureSha256,
            documentSha256: row.documentSha256,
          },
        },
      ];
    });
  }
  finalize(id: string, pdfPath: string, finalPdfSha256: string) {
    return this.change(id, null, ['signed'], async (trx, row) => {
      if (row.pdfPath) return null;
      await trx.updateTable('photography_contract').set({ pdfPath, finalPdfSha256 }).where('id', '=', id).execute();
      return [{ type: 'finalized', actor: 'system', data: { finalPdfSha256 } }];
    });
  }
  async delete(ownerId: string, id: string) {
    const { numDeletedRows } = await this.db
      .deleteFrom('photography_contract')
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!numDeletedRows) throw new NotFoundException('Contract is unavailable');
  }

  /**
   * Locks the contract, checks its status, applies the change and appends its events in one transaction.
   * Returns the updated row, or null when the status (or the change itself) refuses.
   */
  private change(
    id: string,
    ownerId: string | null,
    from: ContractStatus[],
    apply: (trx: Transaction<DB>, row: ContractRow) => Promise<ContractEventInput[] | null>,
  ) {
    return this.db.transaction().execute(async (trx) => {
      let query = trx.selectFrom('photography_contract').selectAll().where('id', '=', id);
      if (ownerId) query = query.where('ownerId', '=', ownerId);
      const row = await query.forUpdate().executeTakeFirst();
      if (!row) throw new NotFoundException('Contract is unavailable');
      if (!from.includes(row.status as ContractStatus)) return null;
      const events = await apply(trx, row);
      if (!events) return null;
      await this.append(trx, id, events);
      return trx.selectFrom('photography_contract').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }
  private async append(trx: Transaction<DB>, contractId: string, events: ContractEventInput[]) {
    const last = await trx
      .selectFrom('photography_contract_event')
      .select(['seq', 'sha256'])
      .where('contractId', '=', contractId)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    let seq = last?.seq ?? 0;
    let prevEventSha256 = last?.sha256 ?? null;
    for (const input of events) {
      const event = {
        seq: ++seq,
        type: input.type,
        actor: input.actor,
        at: new Date().toISOString(),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        data: input.data ?? {},
        prevEventSha256,
      };
      const sha256 = contractEventSha256(event);
      await trx
        .insertInto('photography_contract_event')
        .values({ contractId, ...event, sha256 })
        .execute();
      prevEventSha256 = sha256;
    }
  }
}
