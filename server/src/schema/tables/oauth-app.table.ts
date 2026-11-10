import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-803 (E3-03): an app that may ask people on this server for access through OAuth 2.1, such as
 * an AI assistant's connector or Home Assistant. `dynamic` apps registered themselves (RFC 7591)
 * while the administrator allowed it; their name is what the app says and is shown as unchecked
 * unless every return address belongs to an app Frameleaf knows. A client has no secret: every
 * app is a public client and proves itself with PKCE (S256) and an exactly registered return address.
 */
@Table('oauth_client')
export class OAuthClientTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  name!: string;

  /** Return addresses exactly as registered: https, or http on a loopback address (any port). */
  @Column({ array: true, type: 'character varying' })
  redirectUris!: string[];

  /** Kept as registered but never fetched by the server or shown on the Allow page. */
  @Column({ nullable: true })
  logoUri!: string | null;

  @Column({ type: 'boolean', default: true })
  dynamic!: Generated<boolean>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * FL-803: one person's permission for one app, made when they chose Allow. Only the SHA-256 of
 * the current access and refresh tokens is kept; a refresh replaces both (rotation), and the spent
 * refresh token is kept in `oauth_spent_refresh_token` so presenting it again revokes the grant.
 * `revokedAt` set means the grant and every token from it no longer work.
 */
@Table('oauth_grant')
@Index({ columns: ['userId', 'revokedAt'] })
export class OAuthGrantTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @ForeignKeyColumn(() => OAuthClientTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  clientId!: string;

  @Column({ array: true, type: 'character varying' })
  scopes!: string[];

  /** The resource (RFC 8707) the app asked for, such as this server's assistant address. */
  @Column({ nullable: true })
  resource!: string | null;

  @Column({ type: 'bytea', unique: true })
  refreshTokenHash!: Buffer;

  @Column({ type: 'bytea', unique: true })
  accessTokenHash!: Buffer;

  @Column({ type: 'timestamp with time zone' })
  accessExpiresAt!: Timestamp;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastUsedAt!: Timestamp | null;

  /** How the last request arrived, in the activity log's words: `home`, `direct` or `relay`. */
  @Column({ nullable: true })
  lastUsedVia!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  revokedAt!: Timestamp | null;
}

/**
 * FL-803: a single-use authorization code, made when a person chose Allow. Only its SHA-256 is
 * kept. It is bound to the app, the person and the session that allowed it, the exact return
 * address (including a loopback port), the S256 code challenge, the scopes and the resource, and
 * lasts five minutes. Signing that session out removes it.
 */
@Table('oauth_authorization_code')
@Index({ columns: ['expiresAt'] })
@Check({ name: 'oauth_authorization_code_hash_check', expression: 'octet_length("codeHash") = 32' })
export class OAuthAuthorizationCodeTable {
  @PrimaryColumn({ type: 'bytea' })
  codeHash!: Buffer;

  @ForeignKeyColumn(() => OAuthClientTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  clientId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  userId!: string;

  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  sessionId!: string;

  @Column()
  redirectUri!: string;

  @Column()
  codeChallenge!: string;

  @Column({ array: true, type: 'character varying' })
  scopes!: string[];

  @Column({ nullable: true })
  resource!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Timestamp;
}

/**
 * FL-803: refresh tokens a grant already used. Presenting one again means a copy leaked, so the
 * grant is revoked (OAuth 2.1 §4.3.1). Removed with the grant.
 */
@Table('oauth_spent_refresh_token')
export class OAuthSpentRefreshTokenTable {
  @PrimaryColumn({ type: 'bytea' })
  tokenHash!: Buffer;

  @ForeignKeyColumn(() => OAuthGrantTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  grantId!: string;

  @CreateDateColumn()
  spentAt!: Generated<Timestamp>;
}
