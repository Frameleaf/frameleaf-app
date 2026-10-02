import { describe, expect, it, vi } from 'vitest';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';

vi.mock('kysely', async (original) => {
  const actual = await original<typeof import('kysely')>();
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) =>
      strings[0].includes('pg_advisory_xact_lock')
        ? {
            execute: (trx: { locks: number }) => {
              trx.locks++;
              return Promise.resolve();
            },
          }
        : actual.sql(strings, ...parameters),
    actual.sql,
  );
  return { ...actual, sql };
});

describe('Buddy transaction admission', () => {
  it('reuses the admitted connection for nested vault and state locks even with a one-connection pool', async () => {
    const trx = { locks: 0 };
    let busy = false;
    let connections = 0;
    const db = {
      transaction: () => ({
        execute: async (run: (trx: unknown) => Promise<unknown>) => {
          if (busy) throw new Error('pool exhausted');
          busy = true;
          connections++;
          try {
            return await run(trx);
          } finally {
            busy = false;
          }
        },
      }),
    };
    const repository = new BuddyBackupRepository(db as never, {} as never);
    const result = await repository.locked('peer-access', (transaction) =>
      repository.locked(
        'vault',
        (vaultTransaction) =>
          repository.locked(
            'state',
            (stateTransaction) => {
              expect(stateTransaction).toBe(transaction);
              return Promise.resolve('acknowledged');
            },
            vaultTransaction,
          ),
        transaction,
      ),
    );
    expect(result).toBe('acknowledged');
    expect(connections).toBe(1);
    expect(trx.locks).toBe(3);
  });
});
