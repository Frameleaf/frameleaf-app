import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { SessionTable } from 'src/schema/tables/session.table.js';

/**
 * Unified sign-in (spec 2026-11-11): how each session was made. One row per session, written with it by
 * `createSession`: the methods used (wire names, in order), the level they reach, when the session last
 * reached that level, and where the sign-in happened (`local` or `frameleaf`). `legacy` marks sessions that
 * existed before this record and sessions from clients that do not declare the `verification` capability;
 * they keep today's rights until the owner turns on "Apply to older apps too".
 */
@Table({ name: 'session_sign_in' })
export class SessionSignInTable {
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  sessionId!: string;

  @Column({ array: true, type: 'character varying', default: '{}' })
  methods!: Generated<string[]>;

  @Column({ type: 'character varying' })
  level!: 'verified' | 'basic';

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  authTime!: Generated<Timestamp>;

  @Column({ type: 'character varying' })
  source!: 'local' | 'frameleaf';

  @Column({ type: 'boolean', default: false })
  legacy!: Generated<boolean>;
}
