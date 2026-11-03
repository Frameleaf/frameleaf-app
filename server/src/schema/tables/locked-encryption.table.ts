import { Check, Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * Optional encryption of one person's Locked files. Mirrors migration 2100000003036-LockedEncryption.
 *
 * A row means the person turned it on (no row means off). `status` is `encrypting` while the Locked
 * files are being sealed, `on` once they all are, and `decrypting` while turning it off unseals them.
 * No key material is stored here; the key file holds the wrapped keys.
 */
@Table('locked_encryption')
@Check({ name: 'locked_encryption_mode_check', expression: `"mode" = ANY (ARRAY['pin'::text, 'advanced'::text])` })
@Check({
  name: 'locked_encryption_status_check',
  expression: `"status" = ANY (ARRAY['encrypting'::text, 'on'::text, 'decrypting'::text])`,
})
@Check({
  name: 'locked_encryption_askAgainHours_check',
  expression: `"askAgainHours" = ANY (ARRAY[8, 24, 72])`,
})
export class LockedEncryptionTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  userId!: string;

  /** `pin` unlocks with the Locked PIN; `advanced` with the recovery key alone. */
  @Column({ type: 'text' })
  mode!: 'pin' | 'advanced';

  @Column({ type: 'text' })
  status!: 'encrypting' | 'on' | 'decrypting';

  /** Hours before the key is asked for again: 8, 24 or 72; null asks again only after a restart. */
  @Column({ type: 'integer', nullable: true, default: 72 })
  askAgainHours!: Generated<number | null>;

  @Column({ type: 'timestamp with time zone' })
  recoveryKeyCreatedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  enabledAt!: Generated<Timestamp>;
}
