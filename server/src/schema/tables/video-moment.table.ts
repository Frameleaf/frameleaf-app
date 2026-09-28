import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { VideoMomentSource } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The timestamped moment index of one video (FL-59, `REC-101`). Mirrors migration
 * 2100000000380-AddVideoMomentIndex.
 *
 * One row per video that has reusable frames. It pins the provenance every generated result was
 * made from, so a change to any of them invalidates exactly the generated results that depend on
 * it and nothing else:
 *
 * - **Source.** `sourceFingerprint` is a digest of the original's checksum, path and modification
 *   time when the frames were cut. A replaced original no longer matches, and the frames, their
 *   embeddings and the generated moments are dropped; manual moments and transcripts stay.
 * - **Model and destination.** `embeddingModel` and `embeddingDestinationId` name what indexed the
 *   frames; `captionModel`, `captionConfigHash` and `captionDestinationId` what captioned them.
 * - **Identity.** `captionIdentityHash` is a digest of the confirmed names the caption prompt was
 *   given. A face correction that changes those names makes the generated captions stale.
 *
 * The cover is the owner's choice and survives a refresh: it is kept as a timestamp and re-matched
 * to the nearest new frame.
 */
@Table('video_moment_index')
@UpdatedAtTrigger('video_moment_index_updatedAt')
export class VideoMomentIndexTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @Column()
  sourceFingerprint!: string;

  /** Which sampling policy cut the frames, so a policy change is a visible refresh, not a silent one. */
  @Column()
  extractorVersion!: string;

  @Column({ type: 'integer', default: 0 })
  frameCount!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  framesExtractedAt!: Timestamp | null;

  @Column({ nullable: true })
  embeddingModel!: string | null;

  @Column({ type: 'uuid', nullable: true })
  embeddingDestinationId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  indexedAt!: Timestamp | null;

  @Column({ nullable: true })
  captionModel!: string | null;

  @Column({ nullable: true })
  captionConfigHash!: string | null;

  @Column({ nullable: true })
  captionIdentityHash!: string | null;

  @Column({ type: 'uuid', nullable: true })
  captionDestinationId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  captionedAt!: Timestamp | null;

  /** The owner's chosen cover, as a time in the video. Null means the best-ranked frame. */
  @Column({ type: 'integer', nullable: true })
  coverTimestampMs!: number | null;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  coverSetById!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  coverSetAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * One reusable video frame (FL-59). Cut once, ranked, and reused by the description grid, the
 * moment index and moment captions. Independent of duplicate detection.
 */
@Unique({ columns: ['assetId', 'frameIndex'] })
@Table('video_moment_frame')
@UpdatedAtTrigger('video_moment_frame_updatedAt')
export class VideoMomentFrameTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  assetId!: string;

  @Column({ type: 'integer' })
  frameIndex!: number;

  @Column({ type: 'integer' })
  timestampMs!: number;

  /** Server path of the cached JPEG. Never returned to a client; frames are served by id. */
  @Column()
  path!: string;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  /** Exposure, contrast, detail and sharpness of the frame; higher is a better cover candidate. */
  @Column({ type: 'double precision' })
  score!: number;

  /** 1 is the best frame of the video. */
  @Column({ type: 'integer' })
  rank!: number;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * The search embedding of one reusable frame (FL-59). Kept apart from the frame so a change of
 * search model, which empties every embedding table, never touches frames or moments.
 *
 * The vector index (`video_moment_frame_index`, added in `2100000000500-AddVideoMomentFrameVectorIndex`)
 * is `synchronize: false` for the same reason the column's dimension is: it is built after the
 * table already has its final dimension, choosing whichever vector extension the initial
 * migration chose for this database, the same way `smart_search`'s `clip_index` does.
 */
@Table('video_moment_frame_embedding')
@Index({
  name: 'video_moment_frame_index',
  using: 'hnsw',
  expression: `embedding vector_cosine_ops`,
  with: `ef_construction = 300, m = 16`,
  synchronize: false,
})
export class VideoMomentFrameEmbeddingTable {
  @ForeignKeyColumn(() => VideoMomentFrameTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  frameId!: string;

  @Column({ type: 'vector', length: 512, storage: 'external', synchronize: false })
  embedding!: string;

  @Column()
  modelName!: string;
}

/**
 * A timestamped moment of a video (FL-59).
 *
 * `generated` moments are one per reusable frame and may carry a generated caption; they are
 * replaced whenever the frames are. `manual` moments are the owner's, with their own title and an
 * optional transcript, and no refresh, source replacement or face correction ever removes them.
 * No transcript is ever generated: there is no automatic speech recognition.
 */
@Index({ columns: ['assetId', 'timestampMs'] })
@Table('video_moment')
@UpdatedAtTrigger('video_moment_updatedAt')
export class VideoMomentTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  assetId!: string;

  @Column()
  source!: VideoMomentSource;

  @Column({ type: 'integer' })
  timestampMs!: number;

  @Column({ type: 'integer', nullable: true })
  endMs!: number | null;

  /** The frame a generated moment stands for; null for a manual moment or after a refresh. */
  @ForeignKeyColumn(() => VideoMomentFrameTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  frameId!: string | null;

  /** A manual moment's title, or a generated caption. */
  @Column({ type: 'text', nullable: true })
  caption!: string | null;

  /** Typed by the owner. Never generated. */
  @Column({ type: 'text', nullable: true })
  transcript!: string | null;

  /** For a generated caption: model, prompt digest, identity digest and destination it came from. */
  @Column({ type: 'jsonb', nullable: true })
  provenance!: Record<string, unknown> | null;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
