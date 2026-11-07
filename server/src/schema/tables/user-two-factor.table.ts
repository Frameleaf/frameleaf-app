import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-793: an account's authenticator app for two-step sign-in. Mirrors migration 1793970000000-TwoFactorSignIn.
 *
 * `secret` is sealed (AES-256-GCM) under a key derived from the server's own key file, never stored in
 * clear. The row exists from setup; two-step sign-in is on only once `enabledAt` is set (the first code
 * was confirmed). `lastUsedStep` is the newest TOTP step accepted, so a code works once.
 */
@Table({ name: 'user_two_factor' })
export class UserTwoFactorTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  userId!: string;

  @Column({ type: 'text' })
  secret!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  enabledAt!: Timestamp | null;

  @Column({ type: 'bigint', nullable: true })
  lastUsedStep!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/** FL-793: one-time recovery codes, stored as SHA-256 only; `usedAt` is set when one signs in. */
@Table({ name: 'user_recovery_code' })
export class UserRecoveryCodeTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  userId!: string;

  @Column({ type: 'bytea' })
  codeHash!: Buffer;

  @Column({ type: 'timestamp with time zone', nullable: true })
  usedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
