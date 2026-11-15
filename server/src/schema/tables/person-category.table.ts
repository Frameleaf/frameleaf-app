import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  ForeignKeyConstraint,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PersonTable } from 'src/schema/tables/person.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-874: an owner's categories for their people, such as Family, Friends and Work. Each account has its own;
 * a partner never sees another account's categories. `(id, ownerId)` is unique so a membership can name both.
 */
@Table('person_category')
@Unique({ name: 'person_category_id_ownerId_uq', columns: ['id', 'ownerId'] })
@Index({ name: 'person_category_ownerId_order_idx', columns: ['ownerId', 'order'] })
export class PersonCategoryTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  color!: string | null;

  @Column({ type: 'integer', default: 0 })
  order!: Generated<number>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * FL-874: one of an owner's people in one of their categories. A person is named the way `person` names it (and
 * `person_profile`, `person_merge_candidate`): the owner plus the API's person id (`person_group.id`). Both
 * references are composite, so a membership always joins a category and a person of the same owner, and goes
 * with either when it is deleted. The default for every account is no membership at all.
 */
@Table('person_category_member')
@Index({ name: 'person_category_member_categoryId_idx', columns: ['categoryId'] })
@ForeignKeyConstraint({
  name: 'person_category_member_categoryId_ownerId_fkey',
  columns: ['categoryId', 'ownerId'],
  referenceTable: () => PersonCategoryTable,
  referenceColumns: ['id', 'ownerId'],
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
  index: false,
})
@ForeignKeyConstraint({
  name: 'person_category_member_ownerId_personId_fkey',
  columns: ['ownerId', 'personId'],
  referenceTable: () => PersonTable,
  referenceColumns: ['ownerId', 'personGroupId'],
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
  index: false,
})
export class PersonCategoryMemberTable {
  @PrimaryColumn({ type: 'uuid' })
  ownerId!: string;

  @PrimaryColumn({ type: 'uuid' })
  personId!: string;

  @PrimaryColumn({ type: 'uuid' })
  categoryId!: string;
}

/**
 * FL-874: marks an account whose starting categories (Family, Friends, Work) were made. They are made once, the
 * first time the account's categories are read; deleting them all never brings them back.
 */
@Table('person_category_seed')
export class PersonCategorySeedTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @CreateDateColumn()
  seededAt!: Generated<Timestamp>;
}
