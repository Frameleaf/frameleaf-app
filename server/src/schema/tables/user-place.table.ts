import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-949: a place a person named, such as "Home": a centre and how far it reaches. The name is theirs alone; no
 * partner, administrator or shared link reads it. A name is used once per person, whatever its capitals.
 * Mirrors migration 1794912000000-UserPlace.
 */
@Table('user_place')
@Index({ name: 'user_place_ownerId_name_uq', expression: '"ownerId", lower(name)', unique: true })
@Check({ name: 'user_place_radiusMeters_check', expression: '"radiusMeters" >= 25 AND "radiusMeters" <= 5000' })
export class UserPlaceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // Covered by user_place_ownerId_name_uq, which leads with ownerId.
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @Column({ type: 'character varying', length: 80 })
  name!: string;

  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  @Column({ type: 'integer' })
  radiusMeters!: number;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
