import { Injectable } from '@nestjs/common';
import { Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuddyBootDeclaration } from 'src/utils/buddy-boot-configuration.js';
import type { BuddyPairing } from 'src/utils/frameleaf-buddy.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DB } from 'src/schema/index.js';
import { writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';

export type BuddySettings = {
  directory: string;
  quotaBytes: number;
  uploadMbps: number;
  downloadMbps: number;
  schedule: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  pausedSending: boolean;
  pausedReceiving: boolean;
  includeDerived: boolean;
  configurationFiles: string[];
  bootConfiguration?: BuddyBootDeclaration;
};
export type BuddyRun = {
  id: string;
  state:
    | 'capturing'
    | 'sending'
    | 'paused'
    | 'waiting-peer'
    | 'waiting-quota'
    | 'waiting-key'
    | 'waiting-authorization'
    | 'incomplete'
    | 'complete';
  startedAt: string;
  finishedAt: string | null;
  uploadedBytes: number;
  totalBytes: number;
  objects: number;
  uploadedObjects: number;
  error: string | null;
};
export type BuddyState = {
  version: 1;
  settings: BuddySettings | null;
  pairing: BuddyPairing | null;
  recoveryVerified: boolean;
  probeVerified: boolean;
  nextScheduledAt: string | null;
  lastCompleteAt: string | null;
  lastVerifiedAt: string | null;
  lastSequence: number;
  protectionStartedAt?: string | null;
  run: BuddyRun | null;
  transfer?: { connection: string | null; mbps: number; at: string };
  peerUsage?: { vaultId: string; committedBytes: number; reservedBytes: number; at: string };
};
const emptyState = (): BuddyState => ({
  version: 1,
  settings: null,
  pairing: null,
  recoveryVerified: false,
  probeVerified: false,
  nextScheduledAt: null,
  lastCompleteAt: null,
  lastVerifiedAt: null,
  lastSequence: 0,
  run: null,
});

@Injectable()
export class BuddyBackupRepository {
  constructor(
    @InjectKysely() readonly db: Kysely<DB>,
    private config: ConfigRepository,
  ) {}

  root() {
    return join(identityDirectory(this.config), 'buddy');
  }

  /** A separate lock class avoids both existing file-path locks and integer DatabaseLock values. */
  locked<T>(name: string, callback: (trx: Transaction<DB>) => Promise<T>, transaction?: Transaction<DB>): Promise<T> {
    const execute = async (trx: Transaction<DB>) => {
      await sql`SELECT pg_advisory_xact_lock(-310, hashtext(${name})::int)`.execute(trx);
      return callback(trx);
    };
    return transaction ? execute(transaction) : this.db.transaction().execute(execute);
  }

  async state(): Promise<BuddyState> {
    try {
      const state = JSON.parse(await readFile(join(this.root(), 'state.json'), 'utf8')) as BuddyState;
      if (state.version !== 1) throw new Error('Unsupported Buddy state version');
      return { ...emptyState(), ...state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return emptyState();
    }
  }

  async update(change: (state: BuddyState) => BuddyState, transaction?: Transaction<DB>): Promise<BuddyState> {
    return this.locked(
      'state',
      async () => {
        const state = change(await this.state());
        await writeBuddyFile(join(this.root(), 'state.json'), JSON.stringify(state));
        return state;
      },
      transaction,
    );
  }

  /** Persist nonce and replay admission before dispatch. A restart cannot replay a received request. */
  async admit(proofId: string, suppliedNonce: string | undefined, grantExpiresAt: number, handshake = false) {
    return this.locked('peer-admission', async () => {
      const path = join(this.root(), 'peer-admission.json');
      const now = Date.now();
      let state: { nonce: string; until: number; seen: Record<string, number>; minute: number; requests: number };
      try {
        state = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = {
          nonce: randomBytes(32).toString('base64url'),
          until: now + 300_000,
          seen: {},
          minute: 0,
          requests: 0,
        };
      }
      state.seen = Object.fromEntries(Object.entries(state.seen).filter(([, until]) => until > now));
      if (state.until <= now) {
        state.nonce = randomBytes(32).toString('base64url');
        state.until = now + 300_000;
      }
      if (state.minute !== Math.floor(now / 60_000)) {
        state.minute = Math.floor(now / 60_000);
        state.requests = 0;
      }
      if (state.seen[proofId]) throw new Error('Buddy request replay rejected');
      if (++state.requests > 120 || Object.keys(state.seen).length >= 1000)
        throw new Error('Buddy request rate limit reached');
      if (!handshake && suppliedNonce !== state.nonce) {
        await writeBuddyFile(path, JSON.stringify(state));
        return { allowed: false, nonce: state.nonce };
      }
      state.seen[proofId] = grantExpiresAt;
      await writeBuddyFile(path, JSON.stringify(state));
      return { allowed: true, nonce: state.nonce };
    });
  }
}
