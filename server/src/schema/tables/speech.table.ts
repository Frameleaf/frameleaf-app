import { Column, ForeignKeyColumn, Index, Table, Unique } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { SpeechWord } from 'src/utils/speech.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('speech_settings')
export class SpeechSettingsTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'boolean', default: false }) enabled!: Generated<boolean>;
  @Column({ type: 'text', default: 'library' }) scope!: Generated<'library' | 'albums'>;
  @Column({ type: 'uuid', array: true, default: [] }) albumIds!: Generated<string[]>;
  @Column({ type: 'uuid', nullable: true }) destinationId!: string | null;
  @Column({ type: 'uuid' }) generation!: string;
  @Column({ type: 'text', nullable: true }) modelFingerprint!: string | null;
  @Column({ type: 'uuid', nullable: true }) cursor!: string | null;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) nextScanAt!: Generated<Timestamp>;
}

@Table('speech_transcript')
@Index({ name: 'IDX_speech_transcript_ownerId', columns: ['ownerId'] })
@Unique({ name: 'speech_transcript_operationId_key', columns: ['operationId'] })
export class SpeechTranscriptTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE' }) assetId!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column({ type: 'uuid' }) operationId!: string;
  @Column({ type: 'uuid' }) generation!: string;
  @Column({ type: 'bytea' }) checksum!: Buffer;
  @Column({ type: 'integer' }) indexVersion!: number;
  @Column({ type: 'text' }) modelFingerprint!: string;
  @Column({ type: 'text', nullable: true }) model!: string | null;
  @Column({ type: 'text', nullable: true }) language!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) completedAt!: Timestamp | null;
}

@Table('speech_window')
@Index({ name: 'IDX_speech_window_assetId_operationId', columns: ['assetId', 'operationId'] })
@Index({ name: 'IDX_speech_window_vector', expression: '"vector"', using: 'gin' })
export class SpeechWindowTable {
  @Column({ type: 'uuid', primary: true }) operationId!: string;
  @Column({ type: 'integer', primary: true }) sequence!: number;
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', index: false }) assetId!: string;
  @Column({ type: 'tsvector' }) vector!: string;
  @Column({ type: 'text', array: true }) tokens!: string[];
  @Column({ type: 'jsonb' }) words!: SpeechWord[];
}

@Table('speech_checkpoint')
export class SpeechCheckpointTable {
  @Column({ type: 'uuid', primary: true }) operationId!: string;
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', index: false }) assetId!: string;
  @Column({ type: 'integer' }) nextChunk!: number;
  @Column({ type: 'jsonb' }) tail!: SpeechWord[];
  @Column({ type: 'text', nullable: true }) model!: string | null;
  @Column({ type: 'text', nullable: true }) language!: string | null;
}
