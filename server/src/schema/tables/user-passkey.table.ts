import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-836: a passkey of a local account. Mirrors migration 1794260000000-UserPasskey.
 *
 * Only the public key is kept; the private key never leaves the authenticator. `counter` is the
 * authenticator's signature count (0 for passkeys that don't count), checked on every sign-in so a
 * cloned authenticator is refused. `rpId` is the address the passkey was made on: it works only there.
 * `aaguid` names the kind of authenticator (a password manager, a security key) and `backedUp` says
 * whether it syncs to the owner's other devices.
 */
@Table({ name: 'user_passkey' })
export class UserPasskeyTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  userId!: string;

  @Column({ type: 'bytea', unique: true })
  credentialId!: Buffer;

  @Column({ type: 'bytea' })
  publicKey!: Buffer;

  @Column({ type: 'bigint', default: 0 })
  counter!: Generated<string>;

  @Column({ type: 'text', array: true, default: [] })
  transports!: Generated<string[]>;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  rpId!: string;

  @Column({ type: 'uuid', nullable: true })
  aaguid!: string | null;

  @Column({ type: 'boolean', default: false })
  backedUp!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastUsedAt!: Timestamp | null;
}

/**
 * FL-836: the short-lived state of a passkey ceremony, kept on the server (never in the browser):
 * a `register` or `login` challenge (5 minutes, used once) and a `password-proof`, the password
 * checked in a session before adding a passkey (10 minutes). `origin` and `rpId` are the address the
 * ceremony started on, which its answer must come from.
 */
@Table({ name: 'auth_challenge' })
export class AuthChallengeTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column({ type: 'text' })
  purpose!: string;

  @Column({ type: 'text', unique: true })
  challenge!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true, index: false })
  userId!: string | null;

  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true, index: true })
  sessionId!: string | null;

  @Column({ type: 'text', nullable: true })
  origin!: string | null;

  @Column({ type: 'text', nullable: true })
  rpId!: string | null;

  @Column({ type: 'timestamp with time zone', index: true })
  expiresAt!: Timestamp;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * FL-836: the sessions a passkey started. Remote access accepts them like a Frameleaf sign-in, and
 * removing the passkey signs them out.
 */
@Table({ name: 'session_passkey' })
export class SessionPasskeyTable {
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  sessionId!: string;

  @ForeignKeyColumn(() => UserPasskeyTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  passkeyId!: string;
}
