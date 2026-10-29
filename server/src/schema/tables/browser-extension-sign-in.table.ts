import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { ApiKeyTable } from 'src/schema/tables/api-key.table.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Which browser Save to Frameleaf signed in from (FL-655). */
export type BrowserExtensionClient = 'chrome' | 'edge';

/**
 * FL-655: a single-use sign-in code for Save to Frameleaf, made when you press Allow. Only its
 * SHA-256 is kept. It is bound to the account and session that allowed it, the extension's exact
 * return address, its code challenge and this server, and it lasts at most five minutes. Signing
 * that session out removes it.
 */
@Table('browser_extension_sign_in_code')
@Index({ columns: ['expiresAt'] })
@Check({ name: 'browser_extension_sign_in_code_hash_check', expression: 'octet_length("codeHash") = 32' })
@Check({ name: 'browser_extension_sign_in_code_client_check', expression: `"client" IN ('chrome', 'edge')` })
export class BrowserExtensionSignInCodeTable {
  @PrimaryColumn({ type: 'bytea' }) codeHash!: Buffer;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) userId!: string;
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) sessionId!: string;
  @Column() codeChallenge!: string;
  @Column() redirectUri!: string;
  @Column() client!: BrowserExtensionClient;
  @Column() installationId!: string;
  @Column() serverId!: string;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
}

/**
 * FL-655: an API key that Save to Frameleaf received by signing in, rather than one made by hand.
 * It is listed in API keys as "Save to Frameleaf · Chrome" (or Edge) with "Added by signing in";
 * deleting the key deletes this row. `redirectOrigin` is the extension's own return address and
 * `installationId` a random id the extension made once, so signing in again replaces (and skips the
 * Allow page for) only the same installation, never another browser signed in to the account.
 */
@Table('browser_extension_access')
// one access per installation, enforced (and replaced under a lock in `replaceAccess`)
@Unique({
  name: 'browser_extension_access_installation_uq',
  columns: ['userId', 'client', 'redirectOrigin', 'installationId'],
})
@Check({ name: 'browser_extension_access_client_check', expression: `"client" IN ('chrome', 'edge')` })
export class BrowserExtensionAccessTable {
  @ForeignKeyColumn(() => ApiKeyTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  apiKeyId!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false }) userId!: string;
  @Column() client!: BrowserExtensionClient;
  @Column() redirectOrigin!: string;
  @Column() installationId!: string;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
