import { Column, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';

@Index({ columns: ['petId'] })
@Index({ columns: ['ownerId'] })
@Index({ columns: ['deletedAt'] })
@Table('pet_audit')
export class PetAuditTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;
  @Column({ type: 'uuid' })
  petId!: string;
  @Column({ type: 'uuid' })
  ownerId!: string;
  @Column({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' })
  deletedAt!: Generated<Timestamp>;
}
